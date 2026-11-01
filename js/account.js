// أزرار الحساب في الشريط العلوي ونوافذ الدخول.
import {
  cloud, onCloudChange, initCloud, signIn, signUp, signOut, requestPasswordReset,
  updatePassword, flushBeforeSignOut, resolveChoice, errorText, saveNow,
} from './cloud.js';
import { esc, toast } from './ui.js';

const STATUS = {
  idle: '',
  pending: 'تعديلات لم تُحفظ بعد',
  saving: 'جارٍ الحفظ…',
  saved: 'محفوظ في حسابك',
  error: 'تعذر الحفظ',
  conflict: 'يلزم اختيار نسخة',
};

const FORMS = {
  login: {
    title: 'تسجيل الدخول',
    submit: 'دخول',
    fields: ['email', 'password'],
    links: [['signup', 'إنشاء حساب جديد'], ['reset', 'نسيت كلمة المرور؟']],
  },
  signup: {
    title: 'إنشاء حساب',
    submit: 'إنشاء الحساب',
    fields: ['name', 'email', 'newPassword'],
    links: [['login', 'لدي حساب بالفعل']],
  },
  reset: {
    title: 'استعادة كلمة المرور',
    submit: 'إرسال رابط الاستعادة',
    fields: ['email'],
    links: [['login', 'العودة إلى تسجيل الدخول']],
  },
  recovery: {
    title: 'كلمة مرور جديدة',
    submit: 'حفظ كلمة المرور',
    fields: ['newPassword'],
    links: [],
  },
};

const FIELD = {
  name: '<label class="field"><span>الاسم</span><input name="name" type="text" autocomplete="name" required></label>',
  email: '<label class="field"><span>البريد الإلكتروني</span><input name="email" type="email" dir="ltr" autocomplete="email" required></label>',
  password: '<label class="field"><span>كلمة المرور</span><input name="password" type="password" dir="ltr" autocomplete="current-password" required></label>',
  newPassword: '<label class="field"><span>كلمة المرور (8 أحرف على الأقل)</span><input name="password" type="password" dir="ltr" autocomplete="new-password" minlength="8" required></label>',
};

let dialog;

function openForm(kind) {
  const f = FORMS[kind];
  const off = !cloud.configured;
  dialog.innerHTML = `
    <form class="auth" method="dialog" data-kind="${kind}">
      <div class="auth-head">
        <h2>${f.title}</h2>
        <button type="button" class="btn-text" data-close aria-label="إغلاق">✕</button>
      </div>
      ${off ? '<div class="notice notice-warn"><span>لم تُربط قاعدة البيانات بعد، لذلك لا يعمل الدخول حاليًا. ما زال بإمكانك استخدام المنصة وحفظ عملك في هذا المتصفح.</span></div>' : ''}
      <fieldset ${off ? 'disabled' : ''}>
        ${f.fields.map((n) => FIELD[n]).join('')}
        <p class="auth-error" role="alert" hidden></p>
        <button class="btn btn-primary full" type="submit">${f.submit}</button>
      </fieldset>
      <div class="auth-links">${f.links.map(([k, l]) => `<button type="button" class="btn-text" data-open="${k}">${l}</button>`).join('')}</div>
    </form>`;
  if (!dialog.open) dialog.showModal();
}

function openChoice() {
  const first = cloud.choice?.reason === 'first-login';
  const when = cloud.choice?.remote?.updated_at
    ? new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(cloud.choice.remote.updated_at))
    : '';
  dialog.innerHTML = `
    <div class="auth">
      <div class="auth-head"><h2>أي نسخة تريد استخدامها؟</h2></div>
      <p>${first ? 'يوجد مشروع على هذا الجهاز ومشروع آخر محفوظ في حسابك.' : 'تغيرت النسخة المحفوظة في حسابك من جهاز آخر، وعلى هذا الجهاز تعديلات مختلفة.'}${when ? ` آخر حفظ في الحساب: ${esc(when)}.` : ''} النسخة التي لا تختارها ستُستبدل.</p>
      <div class="btn-row">
        <button class="btn btn-primary" data-choice="remote">استخدام نسخة الحساب</button>
        <button class="btn btn-outline" data-choice="local">رفع نسخة هذا الجهاز</button>
      </div>
    </div>`;
  if (!dialog.open) dialog.showModal();
}

function renderBar(host) {
  if (cloud.user) {
    const name = cloud.user.user_metadata?.full_name || cloud.user.email;
    const label = STATUS[cloud.status] || '';
    host.innerHTML = `
      ${label ? `<button class="sync sync-${cloud.status}" data-sync ${cloud.status === 'error' ? '' : 'disabled'} ${cloud.status === 'error' ? 'data-tip="انقر لإعادة المحاولة"' : ''}>${label}</button>` : ''}
      <span class="acct-name" title="${esc(cloud.user.email)}">${esc(name)}</span>
      <button class="btn btn-sm btn-outline" data-signout>تسجيل الخروج</button>`;
  } else {
    host.innerHTML = `
      <button class="btn btn-sm btn-outline" data-open="login">تسجيل الدخول</button>
      <button class="btn btn-sm btn-primary acct-signup" data-open="signup">إنشاء حساب</button>`;
  }
}

async function submit(form) {
  const kind = form.dataset.kind;
  const fd = new FormData(form);
  const email = String(fd.get('email') || '').trim();
  const password = String(fd.get('password') || '');
  const errEl = form.querySelector('.auth-error');
  const btn = form.querySelector('[type=submit]');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    if (kind === 'login') {
      await signIn(email, password);
      dialog.close();
    } else if (kind === 'signup') {
      const { needsConfirmation } = await signUp(email, password, String(fd.get('name') || '').trim());
      dialog.close();
      toast(needsConfirmation ? 'أرسلنا رابط تأكيد إلى بريدك. افتحه لتفعيل الحساب.' : 'أُنشئ حسابك.', 'ok');
    } else if (kind === 'reset') {
      await requestPasswordReset(email);
      dialog.close();
      toast('إن كان البريد مسجلًا فستصلك رسالة بها رابط الاستعادة.', 'ok');
    } else {
      await updatePassword(password);
      dialog.close();
      toast('حُفظت كلمة المرور الجديدة.', 'ok');
    }
  } catch (e) {
    errEl.textContent = errorText(e);
    errEl.hidden = false;
    btn.disabled = false;
  }
}

export function installAccount() {
  const host = document.getElementById('account');
  dialog = document.createElement('dialog');
  dialog.className = 'auth-dialog';
  document.body.append(dialog);

  dialog.addEventListener('submit', (e) => { e.preventDefault(); submit(e.target); });
  dialog.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) openForm(open.dataset.open);
    else if (e.target.closest('[data-close]')) dialog.close();
    else {
      const choice = e.target.closest('[data-choice]');
      if (choice) { dialog.close(); resolveChoice(choice.dataset.choice === 'remote'); }
    }
  });
  // نافذة الاختيار تتطلب قرارًا، فلا تُغلق بمفتاح Esc
  dialog.addEventListener('cancel', (e) => { if (cloud.choice) e.preventDefault(); });

  host.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) openForm(open.dataset.open);
    else if (e.target.closest('[data-sync]')) saveNow();
    else if (e.target.closest('[data-signout]')) {
      const saved = await flushBeforeSignOut();
      if (!saved && !confirm('تعذر حفظ آخر تعديلاتك. عند الخروج الآن ستُفقد هذه التعديلات. هل تريد الخروج؟')) return;
      await signOut();
      toast('سُجل خروجك، وأُزيلت بيانات الحساب من هذا الجهاز.', 'ok');
    }
  });

  onCloudChange(() => {
    renderBar(host);
    if (cloud.recovery) openForm('recovery');
    else if (cloud.choice) openChoice();
  });
  renderBar(host);

  // رابط البريد قد يُفتح في متصفح غير الذي بدأ التسجيل، فيُؤكَّد البريد دون فتح جلسة
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const hadCode = query.has('code');
  const linkFailed = query.has('error_description') || hash.has('error_description');

  initCloud().then(() => {
    if (linkFailed) {
      toast('انتهت صلاحية الرابط أو استُخدم من قبل. سجّل الدخول، أو اطلب رابطًا جديدًا عند الحاجة.', 'error');
    } else if (hadCode && !cloud.user && !cloud.recovery) {
      toast('لم يفتح الرابط جلسة في هذا المتصفح. جرّب تسجيل الدخول بالبريد وكلمة المرور.', 'info');
      openForm('login');
    }
    if (hadCode || linkFailed) {
      history.replaceState(null, '', location.pathname + (linkFailed ? '' : location.hash));
    }
  }).catch(() => toast('تعذر الاتصال بخدمة الحسابات. يمكنك متابعة العمل في هذا المتصفح.', 'error'));
}
