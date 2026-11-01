// لوحة المعلومات: التجميع المكاني، الأولويات، التحقق، والتصدير.
import { state, commit, resetProject } from '../store.js';
import { analyzeAll, aggregate, timing } from '../engine/analyze.js';
import { nativeZoomAt } from '../engine/imagery.js';
import { esc, fmt, stat, energyLabel, monthlyChart, rankedBars, download, toast, CONF, SOURCE_LABEL, THEME, quantileBreaks, classOf } from '../ui.js';

const LEVELS = {
  building: { label: 'المبنى', key: ({ b }) => b.id, name: ({ b }) => b.name },
  neighborhood: { label: 'الحي / القرية', key: ({ a }) => a?.neighborhood || 'غير محدد', name: ({ a }) => a?.neighborhood || 'غير محدد' },
  area: { label: 'منطقة الدراسة', key: ({ a }) => a?.id, name: ({ a }) => a?.name || '—' },
  wilaya: { label: 'الولاية', key: ({ a }) => a?.wilaya || 'غير محدد', name: ({ a }) => a?.wilaya || 'غير محدد' },
  governorate: { label: 'المحافظة', key: ({ a }) => a?.governorate || 'غير محدد', name: ({ a }) => a?.governorate || 'غير محدد' },
};

const meanAbsPct = (pairs) => {
  if (!pairs.length) return null;
  return pairs.reduce((s, [est, ref]) => s + Math.abs(est - ref) / ref, 0) / pairs.length * 100;
};

export function buildRows() {
  return analyzeAll().map(({ b, r }) => ({ b, r, a: state.areas.find((x) => x.id === b.areaId) }));
}

export function renderDashboard(root) {
  let level = state.areas.length > 1 ? 'area' : 'building';
  let map = null;

  const draw = () => {
    if (map) { map.remove(); map = null; }
    const rows = buildRows();
    if (!rows.length) {
      root.innerHTML = `<div class="page"><div class="empty big"><h1>لا توجد نتائج بعد</h1><p>حدد منطقة وأضف مبانيها، وستظهر هنا المؤشرات والخرائط والتقارير.</p><a class="btn btn-primary btn-lg" href="#/studio">افتح الخريطة</a></div></div>`;
      return;
    }
    const t = aggregate(rows);
    const e = energyLabel(t.withEnergy ? t.annualKWh : null);
    const L_ = LEVELS[level];
    const groups = new Map();
    for (const row of rows) {
      const k = L_.key(row);
      if (!groups.has(k)) groups.set(k, { name: L_.name(row), rows: [] });
      groups.get(k).rows.push(row);
    }
    const ranked = [...groups.values()].map((g) => ({ label: g.name, total: aggregate(g.rows) }))
      .sort((x, y) => y.total.annualKWh - x.total.annualKWh);
    const priority = rows.filter(({ r }) => r.panelCount > 0)
      .sort((x, y) => (y.r.annualKWh ?? 0) - (x.r.annualKWh ?? 0)).slice(0, 10);
    const field = rows.filter(({ r }) => r.needsField);

    // مؤشرات التحقق تُحسب فقط من بيانات مرجعية أدخلها المستخدم
    const refArea = rows.filter(({ b }) => b.reference?.areaM2).map(({ b, r }) => [r.roofM2, b.reference.areaM2]);
    const refPanels = rows.filter(({ b }) => b.reference?.panels).map(({ b, r }) => [r.panelCount, b.reference.panels]);
    const refEnergy = rows.filter(({ b, r }) => b.reference?.annualKWh && r.annualKWh != null).map(({ b, r }) => [r.annualKWh, b.reference.annualKWh]);
    const complete = rows.filter(({ r }) => r.energy && r.confidence !== 'low').length / rows.length * 100;
    const avgMs = timing.samples.length ? timing.samples.reduce((a, c) => a + c, 0) / timing.samples.length : null;
    const refCount = state.areas.reduce((s, a) => s + (a.refBuildingCount || 0), 0);
    const kpi = (name, how, value) => `<tr><th scope="row">${name}</th><td>${how}</td><td class="${value ? 'kpi-val' : 'kpi-none'}">${value || 'يلزم بيانات مرجعية'}</td></tr>`;

    root.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div><h1>لوحة المعلومات</h1><p class="muted">${fmt(state.areas.length)} منطقة · ${fmt(rows.length)} مبنى · تقديرات أولية وفق الافتراضات الحالية</p></div>
          <div class="btn-row">
            <a class="btn btn-primary" href="#/report">التقرير الكامل</a>
            <button class="btn btn-outline" data-x="geojson">GeoJSON</button>
            <button class="btn btn-outline" data-x="csv">CSV</button>
            <button class="btn btn-outline" data-x="project">نسخة احتياطية</button>
          </div>
        </div>

        <section class="kpis">
          <div class="kpi kpi-main"><span class="stat-label">الإنتاج السنوي المتوقع</span><span class="hero-num">${e.value} <small>${e.unit}</small></span></div>
          ${stat('القدرة الاسمية', fmt(t.kWp, 1), 'kWp')}
          ${stat('عدد الألواح', fmt(t.panels), 'لوح')}
          ${stat('الأسطح المحللة', fmt(t.roofM2), 'م²')}
          ${stat('القابلة للاستخدام', fmt(t.usableM2), 'م²')}
        </section>

        <div class="dash-grid">
          <section class="card">
            <h2>الخريطة الموضوعية للإنتاج</h2>
            <div id="dashMap" class="dash-map"></div>
            <div class="legend-inline"><span>أقل</span>${THEME.map((c) => `<i style="background:${c}"></i>`).join('')}<span>أعلى</span></div>
          </section>
          <section class="card">
            <h2>الإنتاج الشهري المتوقع للمجموع (kWh)</h2>
            ${t.withEnergy ? monthlyChart(t.months) : '<p class="muted">بيانات المناخ غير محملة.</p>'}
          </section>
          <section class="card">
            <div class="card-head"><h2>مقارنة حسب</h2>
              <select id="level" aria-label="مستوى التجميع">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${k === level ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
            </div>
            ${rankedBars(ranked.slice(0, 12).map((x) => ({ label: x.label, value: x.total.annualKWh / 1000 })), 'MWh/سنة')}
            <p class="muted small">القيم بوحدة MWh/سنة${ranked.length > 12 ? `، وتظهر أعلى 12 من ${fmt(ranked.length)}` : ''}.</p>
          </section>
          <section class="card">
            <h2>أولوية الدراسة التفصيلية</h2>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>#</th><th>المبنى</th><th>kWp</th><th>MWh/سنة</th><th>الثقة</th></tr></thead>
              <tbody>${priority.map(({ b, r }, i) => `<tr><td>${i + 1}</td><td><a href="#/report/${b.id}">${esc(b.name)}</a></td><td>${fmt(r.kWp, 1)}</td><td>${r.annualKWh != null ? fmt(r.annualKWh / 1000, 1) : '—'}</td><td><span class="chip ${CONF[r.confidence].cls}">${CONF[r.confidence].icon} ${CONF[r.confidence].label}</span></td></tr>`).join('')}</tbody>
            </table></div>
          </section>
          <section class="card">
            <h2>مبانٍ تحتاج إلى بيانات أو تحقق ميداني (${fmt(field.length)})</h2>
            ${field.length ? `<ul class="field-list">${field.slice(0, 12).map(({ b, r }) => `<li><a href="#/report/${b.id}"><strong>${esc(b.name)}</strong></a><span>${esc(r.flags.join(' · '))}</span></li>`).join('')}</ul>` : '<p class="muted">لا توجد مبانٍ معلقة.</p>'}
          </section>
          <section class="card">
            <h2>مؤشرات نجاح المشروع</h2>
            <div class="table-wrap"><table class="data kpi-table">
              <thead><tr><th>المؤشر</th><th>القياس</th><th>النتيجة</th></tr></thead>
              <tbody>
                ${kpi('التغطية الجغرافية', 'المساحة المحللة', `${fmt(state.areas.reduce((s, a) => s + turf.area(a.geometry), 0) / 1e6, 2)} كم²`)}
                ${kpi('تغطية المباني', 'مقارنة بالعدد المرجعي', refCount ? `${fmt(rows.length / refCount * 100)}%` : null)}
                ${kpi('دقة تقدير المساحة', 'متوسط الخطأ المطلق النسبي', refArea.length ? `${fmt(meanAbsPct(refArea), 1)}% (${refArea.length} مبنى)` : null)}
                ${kpi('دقة تقدير الألواح', 'مقارنة بتوزيع مرجعي', refPanels.length ? `${fmt(meanAbsPct(refPanels), 1)}% (${refPanels.length} مبنى)` : null)}
                ${kpi('دقة إنتاج الكهرباء', 'مقارنة بمحاكاة أو إنتاج فعلي', refEnergy.length ? `${fmt(meanAbsPct(refEnergy), 1)}% (${refEnergy.length} مبنى)` : null)}
                ${kpi('كفاءة المعالجة', 'زمن تحليل المبنى في هذا المتصفح', avgMs != null ? `${fmt(avgMs)} ملّي ثانية` : null)}
                ${kpi('اكتمال المخرجات', 'مبانٍ بنتيجة وثقة متوسطة أو أعلى', `${fmt(complete)}%`)}
              </tbody>
            </table></div>
            <label class="field slim"><span>العدد المرجعي لكل المباني المعروفة في المناطق (إن توفر)</span>
              <input type="number" lang="en" min="0" id="refCount" value="${refCount || ''}"></label>
          </section>
        </div>
        <div class="page-foot"><button class="btn-text danger" data-x="reset">مسح المشروع من هذا المتصفح</button></div>
      </div>`;

    map = L.map(root.querySelector('#dashMap'), { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 17, attribution: '© Esri' }).addTo(map);
    const breaks = quantileBreaks(rows.map(({ r }) => r.annualKWh));
    const layers = L.featureGroup().addTo(map);
    for (const { b, r } of rows) {
      L.geoJSON(b.geometry, { style: { color: '#12262C', weight: 1, fillColor: r.annualKWh != null ? THEME[classOf(r.annualKWh, breaks)] : '#B8C4C8', fillOpacity: 0.85 } })
        .bindTooltip(`${esc(b.name)}: ${r.annualKWh != null ? `${fmt(r.annualKWh / 1000, 1)} MWh/سنة` : '—'}`, { sticky: true }).addTo(layers);
    }
    map.fitBounds(layers.getBounds(), { padding: [24, 24], maxZoom: 19 });
    const c = layers.getBounds().getCenter();
    const dashMap = map;
    nativeZoomAt(c.lat, c.lng).then((z) => {
      if (map !== dashMap || z === sat.options.maxNativeZoom) return;
      sat.options.maxNativeZoom = z;
      dashMap.removeLayer(sat);
      sat.addTo(dashMap);
    });

    root.querySelector('#level').addEventListener('change', (ev) => { level = ev.target.value; draw(); });
    root.querySelector('#refCount').addEventListener('change', (ev) => {
      const v = Number(ev.target.value) || null;
      commit((s) => { s.areas.forEach((a, i) => { a.refBuildingCount = i === 0 ? v : null; }); });
      draw();
    });
    root.querySelectorAll('[data-x]').forEach((btn) => btn.addEventListener('click', () => exporter(btn.dataset.x, rows, draw)));
  };

  draw();
  return () => { if (map) map.remove(); };
}

function exporter(kind, rows, redraw) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'geojson') {
    const fc = {
      type: 'FeatureCollection',
      features: rows.map(({ b, r, a }) => ({
        type: 'Feature', geometry: b.geometry,
        properties: {
          name: b.name, area: a?.name, neighborhood: a?.neighborhood, wilaya: a?.wilaya, governorate: a?.governorate,
          source: b.source, confidence: r.confidence, footprint_m2: +r.footprintM2.toFixed(1), roof_m2: +r.roofM2.toFixed(1),
          usable_m2: +r.usableM2.toFixed(1), panels: r.panelCount, kwp: +r.kWp.toFixed(2),
          annual_kwh: r.annualKWh != null ? Math.round(r.annualKWh) : null, tilt: r.tilt, azimuth: Math.round(r.azimuth),
        },
      })),
    };
    download(`mishraq-${stamp}.geojson`, JSON.stringify(fc, null, 1), 'application/geo+json');
  } else if (kind === 'csv') {
    const head = ['المبنى', 'المنطقة', 'الحي', 'الولاية', 'المحافظة', 'خط العرض', 'خط الطول', 'المصدر', 'الثقة', 'البصمة م2', 'السطح م2', 'القابلة للاستخدام م2', 'الألواح', 'kWp', 'kWh/سنة', 'يحتاج تحققًا ميدانيًا'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map(({ b, r, a }) => [b.name, a?.name, a?.neighborhood, a?.wilaya, a?.governorate, r.lat.toFixed(6), r.lon.toFixed(6), SOURCE_LABEL[b.source], CONF[r.confidence].label, r.footprintM2.toFixed(1), r.roofM2.toFixed(1), r.usableM2.toFixed(1), r.panelCount, r.kWp.toFixed(2), r.annualKWh != null ? Math.round(r.annualKWh) : '', r.needsField ? 'نعم' : 'لا'].map(cell).join(','));
    download(`mishraq-${stamp}.csv`, `﻿${[head.map(cell).join(','), ...lines].join('\r\n')}`, 'text/csv;charset=utf-8');
  } else if (kind === 'project') {
    download(`mishraq-project-${stamp}.json`, JSON.stringify(state), 'application/json');
    toast('حُفظت نسخة كاملة من المشروع.', 'ok');
  } else if (kind === 'reset') {
    if (confirm('سيُحذف المشروع كله من هذا المتصفح. لا يمكن التراجع. هل تريد المتابعة؟')) {
      resetProject();
      redraw();
    }
  }
}
