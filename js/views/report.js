// تقرير للطباعة أو الحفظ PDF: للمشروع كله أو لمبنى واحد.
import { state } from '../store.js';
import { aggregate } from '../engine/analyze.js';
import { totalLossFraction } from '../engine/solar.js';
import { buildRows } from './dashboard.js';
import { esc, fmt, stat, energyLabel, monthlyChart, CONF, SOURCE_LABEL } from '../ui.js';

const LIMITS = `
  <h2>حدود هذا التقرير</h2>
  <ul>
    <li>الأرقام تقديرات أولية للإمكانات الفنية، ولا تعني وفورات مالية أو خفضًا محددًا للانبعاثات.</li>
    <li>لا يشمل الحساب ظل المباني والأشجار المجاورة، ولا قدرة السطح الإنشائية، ولا قيود الربط بالشبكة.</li>
    <li>يلزم التحقق الميداني والدراسة الهندسية قبل أي قرار تركيب.</li>
    <li>جودة النتائج مرهونة بجودة الصور والبصمات، وقد تختلف تواريخ الصور عن الواقع الحالي.</li>
  </ul>
  <h2>مصادر البيانات</h2>
  <ul>
    <li>المناخ: NASA POWER (متوسطات مناخية شهرية).</li>
    <li>بصمات المباني: OpenStreetMap، والرسم اليدوي، والكشف الآلي عند الاستخدام.</li>
    <li>صور الأقمار الصناعية: Esri World Imagery.</li>
  </ul>`;

const assumptions = () => {
  const s = state.settings;
  return `
  <h2>الافتراضات</h2>
  <table class="data"><tbody>
    <tr><th>اللوح</th><td>${esc(s.panel.name || '')} · ${fmt(s.panel.watt)} واط · ${s.panel.lengthM}×${s.panel.widthM} م · معامل حرارة ${s.panel.gamma}%/°م</td></tr>
    <tr><th>الأسطح المستوية</th><td>ميل ${fmt(s.flatTilt)}° · ${s.alignment === 'south' ? 'صفوف نحو الجنوب' : 'موازية لحافة المبنى'} · ارتداد ${s.setback} م · خلوص عوائق ${s.obstacleClearance} م</td></tr>
    <tr><th>الخسائر</th><td>${fmt(totalLossFraction(s.losses) * 100, 1)}% (غبار ${s.losses.soiling}%، أسلاك ${s.losses.wiring}%، عدم تطابق ${s.losses.mismatch}%، توافر ${s.losses.availability}%، تفاوت ${s.losses.nameplate}%) · عاكس ${s.inverterEff}%</td></tr>
  </tbody></table>`;
};

export function renderReport(root, buildingId) {
  const rows = buildRows();
  const row = buildingId ? rows.find(({ b }) => b.id === buildingId) : null;
  const today = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'long' }).format(new Date());
  const header = (title, sub) => `
    <header class="report-head">
      <img src="assets/logo.jpeg" alt="" width="64" height="64">
      <div><p class="eyebrow-dark">مِشراق / MISHRAQ</p><h1>${esc(title)}</h1><p class="muted">${esc(sub)} · ${today}</p></div>
    </header>`;
  const bar = `<div class="report-bar no-print"><a class="btn-text" href="#/dashboard">→ لوحة المعلومات</a><button class="btn btn-primary" id="print">طباعة / حفظ PDF</button></div>`;

  if (buildingId && !row) {
    root.innerHTML = `<div class="page"><div class="empty big"><h1>المبنى غير موجود</h1><a class="btn btn-primary" href="#/studio">العودة إلى الخريطة</a></div></div>`;
    return;
  }
  if (!rows.length) {
    root.innerHTML = `<div class="page"><div class="empty big"><h1>لا توجد بيانات لتقريرها</h1><a class="btn btn-primary" href="#/studio">افتح الخريطة</a></div></div>`;
    return;
  }

  if (row) {
    const { b, r, a } = row;
    const e = energyLabel(r.annualKWh);
    root.innerHTML = `<article class="report">${bar}
      ${header(`تقرير مبنى: ${b.name}`, [a?.name, a?.wilaya, a?.governorate].filter(Boolean).join('، '))}
      <section class="kpis">
        <div class="kpi kpi-main"><span class="stat-label">الإنتاج السنوي المتوقع</span><span class="hero-num">${e.value} <small>${e.unit}</small></span></div>
        ${stat('القدرة الاسمية', fmt(r.kWp, 1), 'kWp')}
        ${stat('عدد الألواح', fmt(r.panelCount), 'لوح')}
        ${stat('مساحة السطح', fmt(r.roofM2), 'م²')}
        ${stat('القابلة للاستخدام', fmt(r.usableM2), 'م²')}
      </section>
      <p><span class="chip ${CONF[r.confidence].cls}">${CONF[r.confidence].icon} ${CONF[r.confidence].label}</span> · المصدر: ${SOURCE_LABEL[b.source]} · الإحداثيات: ${r.lat.toFixed(5)}، ${r.lon.toFixed(5)} · ميل ${fmt(r.tilt)}° · اتجاه ${fmt(r.azimuth)}°</p>
      ${r.energy ? `<h2>الإنتاج الشهري (kWh)</h2>${monthlyChart(r.energy.months.map((m) => m.kWh))}
      <p>الإنتاج النوعي ${fmt(r.energy.specificYield)} kWh/kWp · نسبة الأداء ${fmt(r.energy.performanceRatio * 100, 1)}% · معامل السعة ${fmt(r.energy.capacityFactor * 100, 1)}%</p>` : ''}
      ${r.flags.length ? `<h2>ما يحتاج إلى استكمال</h2><ul>${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${assumptions()}${LIMITS}
    </article>`;
  } else {
    const t = aggregate(rows);
    const e = energyLabel(t.withEnergy ? t.annualKWh : null);
    const field = rows.filter(({ r }) => r.needsField);
    root.innerHTML = `<article class="report">${bar}
      ${header('تقرير الإمكانات الشمسية', `${fmt(state.areas.length)} منطقة · ${fmt(rows.length)} مبنى`)}
      <section class="kpis">
        <div class="kpi kpi-main"><span class="stat-label">الإنتاج السنوي المتوقع</span><span class="hero-num">${e.value} <small>${e.unit}</small></span></div>
        ${stat('القدرة الاسمية', fmt(t.kWp, 1), 'kWp')}
        ${stat('عدد الألواح', fmt(t.panels), 'لوح')}
        ${stat('الأسطح المحللة', fmt(t.roofM2), 'م²')}
        ${stat('القابلة للاستخدام', fmt(t.usableM2), 'م²')}
      </section>
      ${t.withEnergy ? `<h2>الإنتاج الشهري (kWh)</h2>${monthlyChart(t.months)}` : ''}
      <h2>نتائج المباني</h2>
      <table class="data"><thead><tr><th>المبنى</th><th>المنطقة</th><th>السطح م²</th><th>الألواح</th><th>kWp</th><th>kWh/سنة</th><th>الثقة</th></tr></thead>
      <tbody>${rows.map(({ b, r, a }) => `<tr><td>${esc(b.name)}</td><td>${esc(a?.name)}</td><td>${fmt(r.roofM2)}</td><td>${fmt(r.panelCount)}</td><td>${fmt(r.kWp, 1)}</td><td>${r.annualKWh != null ? fmt(r.annualKWh) : '—'}</td><td>${CONF[r.confidence].label}</td></tr>`).join('')}</tbody></table>
      ${field.length ? `<h2>مبانٍ تحتاج إلى بيانات إضافية أو تحقق ميداني (${fmt(field.length)})</h2><ul>${field.map(({ b, r }) => `<li><strong>${esc(b.name)}</strong>: ${esc(r.flags.join('، '))}</li>`).join('')}</ul>` : ''}
      ${assumptions()}${LIMITS}
    </article>`;
  }
  root.querySelector('#print').addEventListener('click', () => window.print());
}
