// أدوات عرض مشتركة: التنسيق، الرسوم البيانية، التلميحات، التنزيل.
export const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export const CONF = {
  high: { label: 'ثقة مرتفعة', cls: 'conf-high', icon: '●' },
  medium: { label: 'ثقة متوسطة', cls: 'conf-medium', icon: '◐' },
  low: { label: 'ثقة منخفضة', cls: 'conf-low', icon: '○' },
};
export const SOURCE_LABEL = { osm: 'OpenStreetMap', manual: 'رسم يدوي', vision: 'كشف آلي من الصور', import: 'ملف مستورد' };
export const THEME = ['#F9E3B4', '#F2C66B', '#DE9A2B', '#AD6C14', '#6E430A'];

const NF = (d) => new Intl.NumberFormat('ar-u-nu-latn', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '—' : NF(d).format(n));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function energyLabel(kWh) {
  if (kWh == null) return { value: '—', unit: 'kWh/سنة' };
  if (kWh >= 1e6) return { value: fmt(kWh / 1e6, 2), unit: 'GWh/سنة' };
  if (kWh >= 1e4) return { value: fmt(kWh / 1e3, 1), unit: 'MWh/سنة' };
  return { value: fmt(kWh), unit: 'kWh/سنة' };
}

export const stat = (label, value, unit = '', hint = '') => `
  <div class="stat" ${hint ? `data-tip="${esc(hint)}"` : ''}>
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-value">${value}${unit ? ` <small>${esc(unit)}</small>` : ''}</span>
  </div>`;

export function monthlyChart(values, unit = 'kWh') {
  const max = Math.max(...values, 1);
  const peak = values.indexOf(Math.max(...values));
  const low = values.indexOf(Math.min(...values));
  const table = values.map((v, i) => `<tr><td>${MONTH_NAMES[i]}</td><td>${fmt(v)} ${unit}</td></tr>`).join('');
  return `
    <figure class="chart">
      <div class="chart-bars" role="img" aria-label="الإنتاج الشهري المتوقع">
        ${values.map((v, i) => `
          <div class="bar-col" data-tip="${MONTH_NAMES[i]}: ${fmt(v)} ${unit}">
            <span class="bar-plot"><span class="bar" style="height:${Math.max(1.5, (v / max) * 100)}%">${i === peak || i === low ? `<span class="bar-val">${fmt(v)}</span>` : ''}</span></span>
            <span class="bar-label">${MONTH_NAMES[i].slice(0, 3)}</span>
          </div>`).join('')}
      </div>
      <details class="chart-table"><summary>عرض القيم في جدول</summary><table>${table}</table></details>
    </figure>`;
}

export function rankedBars(items, unit) {
  const max = Math.max(...items.map((x) => x.value), 1);
  return `<ol class="ranked">${items.map((x) => `
    <li data-tip="${esc(x.label)}: ${fmt(x.value, 1)} ${unit}">
      <span class="ranked-label">${esc(x.label)}</span>
      <span class="ranked-track"><span class="ranked-bar" style="width:${Math.max(1, (x.value / max) * 100)}%"></span></span>
      <span class="ranked-val">${fmt(x.value, x.value < 100 ? 1 : 0)}</span>
    </li>`).join('')}</ol>`;
}

export function quantileBreaks(values, classes = 5) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return [];
  return Array.from({ length: classes - 1 }, (_, i) => v[Math.floor(((i + 1) / classes) * v.length)]);
}
export const classOf = (value, breaks) => {
  let i = 0;
  while (i < breaks.length && value >= breaks[i]) i++;
  return i;
};

export function toast(message, kind = 'info') {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  root.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4500);
}

export function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  document.body.append(tip);
  document.addEventListener('pointerover', (e) => {
    const host = e.target.closest?.('[data-tip]');
    if (!host) { tip.hidden = true; return; }
    tip.textContent = host.dataset.tip;
    tip.hidden = false;
    const r = host.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8}px`;
  });
}
