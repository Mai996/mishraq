// الحسابات والحفظ السحابي عبر Supabase. المنصة تعمل محليًا بالكامل دونه.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { state, subscribe, replaceProject, clearLocalProject, hasLocalData, saveMeta } from './store.js';
import { analyzeAll } from './engine/analyze.js';

const SAVE_DELAY = 1500;
let client = null;
let saveTimer = null;
let saving = null;
let applying = false;
const listeners = new Set();

export const cloud = { configured: false, user: null, status: 'idle', recovery: false, choice: null };

const emit = () => listeners.forEach((fn) => fn());
export const onCloudChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const setStatus = (status) => { cloud.status = status; emit(); };

const ERRORS = [
  [/invalid login credentials/i, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'],
  [/already registered|already been registered/i, 'هذا البريد مسجل مسبقًا. جرّب تسجيل الدخول.'],
  [/email not confirmed/i, 'لم يُؤكَّد البريد بعد. افتح رسالة التأكيد في بريدك.'],
  [/password should be|weak/i, 'كلمة المرور ضعيفة. استخدم 8 أحرف على الأقل.'],
  [/rate limit|too many/i, 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.'],
  [/failed to fetch|network/i, 'تعذر الاتصال بالخادم. تحقق من الإنترنت.'],
];
export const errorText = (e) => (ERRORS.find(([re]) => re.test(e?.message || '')) || [])[1] || 'تعذر إكمال العملية. أعد المحاولة بعد قليل.';

function buildingRows() {
  return analyzeAll().map(({ b, r }) => {
    const a = state.areas.find((x) => x.id === b.areaId);
    return {
      id: b.id, name: b.name, area_name: a?.name, neighborhood: a?.neighborhood, wilaya: a?.wilaya, governorate: a?.governorate,
      source: b.source, confidence: r.confidence, footprint_m2: r.footprintM2, roof_m2: r.roofM2, usable_m2: r.usableM2,
      panels: r.panelCount, kwp: r.kWp, annual_kwh: r.annualKWh, geom: JSON.stringify(b.geometry),
    };
  });
}

function projectPayload() {
  const { cloud: _meta, ...data } = state;
  return data;
}

export async function saveNow() {
  if (!client || !cloud.user || cloud.choice) return false;
  clearTimeout(saveTimer);
  if (saving) await saving.catch(() => {});
  setStatus('saving');
  const meta = state.cloud || {};
  saving = client.rpc('save_project', {
    p_id: meta.projectId || null,
    p_name: state.areas[0]?.name || 'مشروعي',
    p_data: projectPayload(),
    p_buildings: buildingRows(),
    p_expected_version: meta.version ?? null,
  }).then(({ data, error }) => {
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    saveMeta({ ownerId: cloud.user.id, projectId: row.id, version: row.version, dirty: false });
    setStatus('saved');
    return true;
  });
  try {
    return await saving;
  } catch (e) {
    if (/version_conflict/.test(e?.message || '')) {
      // نسخة أحدث في جهاز آخر: لا نكتب فوقها، ونترك القرار للمستخدم
      const remote = await fetchRemote().catch(() => null);
      cloud.choice = { remote, reason: 'conflict' };
      setStatus('conflict');
    } else {
      setStatus('error');
    }
    return false;
  } finally {
    saving = null;
  }
}

function scheduleSave() {
  if (applying || !cloud.user || cloud.choice) return;
  saveMeta({ dirty: true, ownerId: cloud.user.id });
  setStatus('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

async function fetchRemote() {
  const { data, error } = await client.from('projects')
    .select('id, data, version, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

function applyRemote(remote) {
  applying = true;
  replaceProject(remote.data, { ownerId: cloud.user.id, projectId: remote.id, version: remote.version, dirty: false });
  applying = false;
  cloud.choice = null;
  setStatus('saved');
}

async function reconcile() {
  setStatus('saving');
  let remote;
  try {
    remote = await fetchRemote();
  } catch {
    setStatus('error');
    return;
  }
  const meta = state.cloud || {};
  const ownLocal = meta.ownerId === cloud.user.id;

  if (!remote) {
    if (ownLocal && meta.projectId) saveMeta({ projectId: null, version: null });
    if (hasLocalData()) await saveNow();
    else setStatus('saved');
  } else if (!hasLocalData()) {
    applyRemote(remote);
  } else if (ownLocal && meta.projectId === remote.id && meta.version === remote.version) {
    if (meta.dirty) await saveNow();
    else setStatus('saved');
  } else if (ownLocal && meta.projectId === remote.id && !meta.dirty) {
    applyRemote(remote);
  } else {
    // بيانات مختلفة على الجهاز وفي الحساب: لا نحذف أيًّا منهما دون قرار
    cloud.choice = { remote, reason: ownLocal ? 'conflict' : 'first-login' };
    setStatus('conflict');
  }
}

export function resolveChoice(useRemote) {
  const { remote } = cloud.choice || {};
  cloud.choice = null;
  if (useRemote && remote) {
    applyRemote(remote);
  } else {
    saveMeta({ ownerId: cloud.user.id, projectId: remote?.id || null, version: remote?.version ?? null, dirty: true });
    saveNow();
  }
}

export async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email, password, fullName) {
  const { data, error } = await client.auth.signUp({
    email, password,
    options: { data: { full_name: fullName }, emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function requestPasswordReset(email) {
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
  cloud.recovery = false;
  emit();
}

// تعيد false إذا تعذر الحفظ، ليقرر المستخدم هل يخرج مع فقد آخر التعديلات
export async function flushBeforeSignOut() {
  if (!cloud.user || !state.cloud?.dirty) return true;
  return saveNow();
}

export async function signOut() {
  clearTimeout(saveTimer);
  cloud.choice = null;
  await client.auth.signOut();
}

let lastUserId = null;
function onSession(session) {
  const user = session?.user || null;
  const id = user?.id || null;
  cloud.user = user;
  if (id === lastUserId) { emit(); return; }
  const signedOut = lastUserId && !id;
  lastUserId = id;
  if (id) {
    reconcile();
  } else if (signedOut) {
    // لا نترك بيانات الحساب على جهاز قد يكون مشتركًا
    applying = true;
    clearLocalProject();
    applying = false;
    setStatus('idle');
  } else {
    emit();
  }
}

// يقبل عميلًا بديلًا لأغراض الاختبار
export async function initCloud(testClient) {
  if (testClient) {
    client = testClient;
  } else {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) { emit(); return; }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true },
    });
  }
  cloud.configured = true;
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') cloud.recovery = true;
    // نؤجل عملنا حتى تكتمل معالجة المكتبة للحدث
    setTimeout(() => onSession(session), 0);
  });
  const { data } = await client.auth.getSession();
  onSession(data.session);
}

subscribe(scheduleSave);
addEventListener('online', () => { if (cloud.user && state.cloud?.dirty) saveNow(); });
addEventListener('beforeunload', (e) => {
  if (cloud.user && state.cloud?.dirty) e.preventDefault();
});
