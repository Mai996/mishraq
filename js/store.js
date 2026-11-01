// حالة المشروع: تُحفظ في متصفح المستخدم وتُصدَّر عند الحاجة.
const KEY = 'mishraq.project.v1';

export const PANEL_PRESETS = [
  { id: 'p450', name: 'لوح 450 واط (فئة عامة)', widthM: 1.048, lengthM: 2.094, watt: 450, gamma: -0.35 },
  { id: 'p550', name: 'لوح 550 واط (فئة عامة)', widthM: 1.134, lengthM: 2.278, watt: 550, gamma: -0.35 },
  { id: 'p600', name: 'لوح 600 واط (فئة عامة)', widthM: 1.303, lengthM: 2.172, watt: 600, gamma: -0.34 },
];

export const DEFAULT_SETTINGS = {
  panelPreset: 'p550',
  panel: { ...PANEL_PRESETS[1] },
  orientation: 'portrait',
  flatTilt: 15,
  alignment: 'south',
  setback: 1.0,
  obstacleClearance: 0.5,
  aisleEvery: 10,
  aisleWidth: 0.6,
  losses: { soiling: 5, wiring: 2, mismatch: 2, availability: 3, nameplate: 2 },
  inverterEff: 97,
  albedo: 0.25,
  u0: 25,
  u1: 6.84,
};

// مدرسة قميراء (مالك بن أنس سابقًا). الحدود تضم المجمعين المسجلين كمدرسة على OpenStreetMap.
export const PILOT = {
  name: 'مدرسة قميراء (الصفوف 1-12)',
  neighborhood: 'قميراء',
  wilaya: 'ولاية ضنك',
  governorate: 'محافظة الظاهرة',
  bbox: [56.2000, 23.9324, 56.2025, 23.9341],
  rev: 2,
  // الحدود والعوائق مرسومة على Esri World Imagery (نحو 0.55 م/بكسل) لأن بصمة OSM منزاحة عن السطح الظاهر
  building: {
    name: 'المبنى الرئيسي',
    sourceId: 1217557079,
    geometry: {
      type: 'Polygon',
      coordinates: [[[56.201369, 23.933558], [56.201588, 23.933596], [56.201788, 23.933627], [56.201856, 23.933642], [56.201856, 23.933661], [56.201994, 23.933690], [56.202044, 23.933615], [56.202113, 23.933257], [56.202135, 23.933143], [56.202128, 23.933017], [56.202038, 23.933000], [56.202006, 23.933120], [56.202050, 23.933196], [56.201956, 23.933543], [56.201875, 23.933555], [56.201475, 23.933455], [56.201538, 23.933143], [56.201573, 23.932950], [56.201481, 23.932929], [56.201435, 23.933249], [56.201378, 23.933455], [56.201369, 23.933558]]],
    },
    obstacles: [
      [[56.201500, 23.933581], [56.201578, 23.933593], [56.201598, 23.933524], [56.201513, 23.933512], [56.201500, 23.933581]],
      [[56.201794, 23.933627], [56.201863, 23.933644], [56.201878, 23.933598], [56.201806, 23.933587], [56.201794, 23.933627]],
      [[56.201950, 23.933604], [56.201988, 23.933612], [56.201995, 23.933570], [56.201958, 23.933564], [56.201950, 23.933604]],
      [[56.202041, 23.933249], [56.202100, 23.933260], [56.202110, 23.933217], [56.202050, 23.933205], [56.202041, 23.933249]],
      [[56.202006, 23.933131], [56.202056, 23.933143], [56.202075, 23.933080], [56.202019, 23.933068], [56.202006, 23.933131]],
      [[56.201485, 23.932979], [56.201540, 23.932990], [56.201548, 23.932959], [56.201493, 23.932948], [56.201485, 23.932979]],
    ].map((ring) => ({ type: 'Polygon', coordinates: [ring] })),
  },
};

function fresh() {
  return { areas: [], buildings: [], climate: {}, settings: structuredClone(DEFAULT_SETTINGS), activeAreaId: null, cloud: {} };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...fresh(), ...parsed, settings: { ...structuredClone(DEFAULT_SETTINGS), ...parsed.settings } };
    }
  } catch { /* تخزين غير متاح: نكمل بحالة جديدة */ }
  return fresh();
}

export const state = load();
const listeners = new Set();
let saveTimer = null;

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function commit(mutate) {
  if (mutate) mutate(state);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* تجاوز السعة أو الحظر */ }
  }, 150);
  listeners.forEach((fn) => fn());
}

export function resetProject() {
  commit((s) => { Object.assign(s, fresh()); });
}

// استبدال المشروع كله (من الحساب السحابي) دون أن يُعد تعديلًا من المستخدم
export function replaceProject(data, cloudMeta) {
  Object.assign(state, fresh(), data, {
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...data.settings },
    cloud: cloudMeta,
  });
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* تجاوز السعة أو الحظر */ }
  dispatchEvent(new Event('mishraq:project-replaced'));
}

export function clearLocalProject() {
  Object.assign(state, fresh());
  try { localStorage.removeItem(KEY); } catch { /* تخزين غير متاح */ }
  dispatchEvent(new Event('mishraq:project-replaced'));
}

export const hasLocalData = () => state.areas.length > 0 || state.buildings.length > 0;

export function saveMeta(meta) {
  state.cloud = { ...state.cloud, ...meta };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* تجاوز السعة أو الحظر */ }
}

export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const climateKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export function climateFor(area) {
  return area.climateKey ? state.climate[area.climateKey] || null : null;
}

export const activeArea = () => state.areas.find((a) => a.id === state.activeAreaId) || null;
