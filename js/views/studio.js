// مساحة العمل الرئيسية: الخريطة ولوحة الخطوات وتفاصيل المبنى.
import { state, commit, subscribe, uid, PILOT, PANEL_PRESETS, activeArea, climateFor } from '../store.js';
import { searchPlace, reverseAdmin, fetchOsm, fetchClimate } from '../services.js';
import { analyze, aggregate } from '../engine/analyze.js';
import { totalLossFraction } from '../engine/solar.js';
import { detectRoof } from '../engine/vision.js';
import { nativeZoomAt } from '../engine/imagery.js';
import { esc, fmt, stat, energyLabel, monthlyChart, toast, CONF, SOURCE_LABEL, THEME, quantileBreaks, classOf } from '../ui.js';

const OMAN_BOUNDS = [[16.4, 51.8], [26.6, 60.1]];
const MAX_AREA_KM2 = 25;

export function renderStudio(root) {
  root.innerHTML = `
    <div class="studio">
      <aside class="panel" id="panel" aria-label="لوحة التحليل"></aside>
      <div class="map-wrap">
        <div id="map"></div>
        <div class="map-mode" id="modeBar" hidden></div>
        <div class="map-switch" role="group" aria-label="نوع الخريطة">
          <button data-base="sat" class="is-on">قمر صناعي</button>
          <button data-base="street">خريطة</button>
        </div>
        <div class="map-legend" id="legend" hidden></div>
        <div class="map-summary" id="summary"></div>
      </div>
    </div>`;

  let alive = true;
  const panel = root.querySelector('#panel');
  const ui = { tab: state.areas.length ? 'buildings' : 'area', selected: null, mode: null, busy: new Set(), tolerance: 14, results: [], editLayer: null };

  // ---------- الخريطة ----------
  const map = L.map('map', { zoomControl: false, maxZoom: 21 });
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
  const bases = {
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 21, maxNativeZoom: 19, attribution: 'الصور © Esri, Maxar, Earthstar Geographics',
    }),
    street: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 21, maxNativeZoom: 19, attribution: '© مساهمو OpenStreetMap',
    }),
  };
  bases.sat.addTo(map);
  map.fitBounds(OMAN_BOUNDS);
  map.pm.setLang('en');
  map.pm.setGlobalOptions({ allowSelfIntersection: false, snappable: true, snapDistance: 12, templineStyle: { color: '#F2C66B' }, hintlineStyle: { color: '#F2C66B', dashArray: '5,5' }, pathOptions: { color: '#F2C66B', weight: 2 } });

  map.createPane('panels').style.zIndex = 430;
  const panelRenderer = L.canvas({ pane: 'panels' });
  const areasLayer = L.layerGroup().addTo(map);
  const sitesLayer = L.layerGroup().addTo(map);
  const buildingsLayer = L.layerGroup().addTo(map);
  const panelsLayer = L.layerGroup().addTo(map);
  const obstaclesLayer = L.layerGroup().addTo(map);

  // ---------- رسم الخريطة من الحالة ----------
  function drawMap() {
    if (ui.editLayer) return;
    areasLayer.clearLayers(); sitesLayer.clearLayers(); buildingsLayer.clearLayers(); panelsLayer.clearLayers(); obstaclesLayer.clearLayers();

    for (const a of state.areas) {
      const on = a.id === state.activeAreaId;
      L.geoJSON(a.geometry, { interactive: false, style: { color: on ? '#F2C66B' : '#ffffff', weight: on ? 2 : 1.5, dashArray: '7 6', fill: false } }).addTo(areasLayer);
      for (const s of a.sites || []) {
        L.geoJSON(s.geometry, { interactive: false, style: { color: '#7FD3E6', weight: 1.5, dashArray: '2 5', fill: false } }).addTo(sitesLayer);
      }
    }

    const breaks = quantileBreaks(ui.results.map(({ r }) => r.annualKWh));
    for (const { b, r } of ui.results) {
      const selected = b.id === ui.selected;
      const color = r.annualKWh != null ? THEME[classOf(r.annualKWh, breaks)] : '#B8C4C8';
      const layer = L.geoJSON(b.geometry, {
        style: { color: selected ? '#ffffff' : '#12262C', weight: selected ? 3 : 1, fillColor: color, fillOpacity: selected ? 0.12 : 0.5 },
      }).addTo(buildingsLayer);
      layer.bindTooltip(`<strong>${esc(b.name)}</strong><br>${fmt(r.footprintM2)} م² · ${fmt(r.panelCount)} لوح · ${r.annualKWh != null ? `${fmt(r.annualKWh / 1000, 1)} MWh/سنة` : 'الإنتاج غير محسوب'}`, { sticky: true, direction: 'top' });
      layer.on('click', (e) => {
        if (ui.mode) return;
        L.DomEvent.stop(e);
        ui.selected = b.id;
        render();
      });
      for (const ob of b.obstacles || []) {
        L.geoJSON(ob, { interactive: false, style: { color: '#E4572E', weight: 1.5, fillColor: '#E4572E', fillOpacity: 0.45 } }).addTo(obstaclesLayer);
      }
      if (selected || map.getZoom() >= 18) {
        for (const p of r.panels) {
          L.polygon(p.map(([lon, lat]) => [lat, lon]), {
            renderer: panelRenderer, interactive: false, color: '#D6EEF9', weight: 0.5, fillColor: '#1B5F9E', fillOpacity: 0.92,
          }).addTo(panelsLayer);
        }
      }
    }

    const legend = root.querySelector('#legend');
    legend.hidden = !ui.results.some(({ r }) => r.annualKWh != null);
    if (!legend.hidden) {
      const classes = ['أقل', '', '', '', 'أعلى'];
      legend.innerHTML = `<span class="legend-title">الإنتاج السنوي</span><div class="legend-ramp">${THEME.map((c, i) => `<span style="background:${c}"></span>`).join('')}</div><div class="legend-ends"><span>${classes[0]}</span><span>${classes[4]}</span></div>`;
    }
  }

  // ---------- أوضاع الرسم ----------
  function setMode(mode, label) {
    ui.mode = mode;
    const bar = root.querySelector('#modeBar');
    bar.hidden = !mode;
    if (mode) bar.innerHTML = `<span>${esc(label)}</span><button class="btn btn-sm btn-light" data-act="cancel-mode">إلغاء</button>`;
    map.getContainer().classList.toggle('is-crosshair', mode === 'detect');
  }
  function cancelMode() {
    map.pm.disableDraw();
    if (ui.editLayer) {
      ui.editLayer.pm.disable();
      map.removeLayer(ui.editLayer);
      ui.editLayer = null;
    }
    setMode(null);
    render();
  }

  map.on('pm:create', ({ layer }) => {
    const geometry = layer.toGeoJSON().geometry;
    map.removeLayer(layer);
    const mode = ui.mode;
    map.pm.disableDraw();
    setMode(null);
    if (mode === 'area') createArea(geometry);
    else if (mode === 'building') addBuilding(geometry, { source: 'manual', boundaryReviewed: true });
    else if (mode === 'obstacle') {
      commit(() => {
        const b = state.buildings.find((x) => x.id === ui.selected);
        if (b) b.obstacles.push(geometry);
      });
    }
  });

  map.on('click', async (e) => {
    if (ui.mode === 'detect') {
      const area = activeArea();
      if (!area) return;
      ui.busy.add('detect');
      renderPanel();
      map.getContainer().classList.add('is-busy');
      try {
        const res = await detectRoof(e.latlng.lat, e.latlng.lng, ui.tolerance);
        addBuilding(res.geometry, { source: 'vision', confidence: res.confidence }, false);
        toast(`اكتُشف سطح بمساحة ${fmt(res.areaM2)} م². دقة الصورة هنا ${fmt(res.mpp, 2)} م/بكسل؛ راجع الحدود قبل اعتماد النتيجة.`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      ui.busy.delete('detect');
      map.getContainer().classList.remove('is-busy');
      render();
    } else if (!ui.mode && ui.selected) {
      ui.selected = null;
      render();
    }
  });
  map.on('zoomend', drawMap);

  // نضبط تكبير الصور على الدقة المتاحة فعليًا حتى لا تظهر المربعات الرمادية
  async function syncImageryZoom() {
    if (map.getZoom() < 15) return;
    const c = map.getCenter();
    const z = await nativeZoomAt(c.lat, c.lng);
    if (alive && bases.sat.options.maxNativeZoom !== z) {
      bases.sat.options.maxNativeZoom = z;
      // إعادة الإضافة تعيد حساب مقياس المربعات؛ redraw وحده يترك الصور منزاحة عن الطبقات
      if (map.hasLayer(bases.sat)) {
        map.removeLayer(bases.sat);
        bases.sat.addTo(map);
      }
    }
  }
  map.on('moveend', syncImageryZoom);

  // ---------- العمليات ----------
  async function ensureClimate(area) {
    const c = turf.centroid(turf.polygon(area.geometry.coordinates)).geometry.coordinates;
    const key = `${c[1].toFixed(2)},${c[0].toFixed(2)}`;
    if (state.climate[key]) {
      commit(() => { area.climateKey = key; });
      return;
    }
    ui.busy.add('climate');
    render();
    try {
      const climate = await fetchClimate(c[1], c[0]);
      commit((s) => { s.climate[climate.key] = climate; area.climateKey = climate.key; area.climateError = null; });
    } catch (e) {
      commit(() => { area.climateError = e.message || 'تعذر جلب بيانات المناخ'; });
      toast('تعذر جلب بيانات المناخ. ستظهر المساحات والألواح، أما الإنتاج فيحتاج إلى إعادة المحاولة.', 'error');
    }
    ui.busy.delete('climate');
    render();
  }

  async function createArea(geometry, preset = {}) {
    const km2 = turf.area(geometry) / 1e6;
    if (km2 > MAX_AREA_KM2) {
      toast(`المساحة ${fmt(km2, 1)} كم² أكبر من حد ${MAX_AREA_KM2} كم² في النسخة التجريبية. ارسم منطقة أصغر.`, 'error');
      return null;
    }
    const area = {
      id: uid('area'), name: preset.name || `منطقة ${state.areas.length + 1}`, geometry,
      neighborhood: preset.neighborhood || '', wilaya: preset.wilaya || '', governorate: preset.governorate || '',
      sites: [], refBuildingCount: null, createdAt: Date.now(),
    };
    commit((s) => { s.areas.push(area); s.activeAreaId = area.id; });
    ui.tab = 'buildings';
    ui.selected = null;
    fitArea(area);
    render();
    ensureClimate(area);
    if (!preset.wilaya) {
      const c = turf.centroid(turf.polygon(geometry.coordinates)).geometry.coordinates;
      reverseAdmin(c[1], c[0]).then((admin) => {
        commit(() => {
          Object.assign(area, admin);
          if (admin.neighborhood && !preset.name) area.name = admin.neighborhood;
        });
      }).catch(() => {});
    }
    return area;
  }

  function fitArea(area) {
    map.fitBounds(L.geoJSON(area.geometry).getBounds(), { padding: [40, 40], maxZoom: 19 });
  }

  function addBuilding(geometry, extra, select = true) {
    const area = activeArea();
    if (!area) return null;
    const n = state.buildings.filter((b) => b.areaId === area.id).length + 1;
    const b = {
      id: uid('bld'), areaId: area.id, name: extra.name || `مبنى ${n}`, geometry,
      source: extra.source, sourceId: extra.sourceId ?? null, confidence: extra.confidence ?? null,
      boundaryReviewed: !!extra.boundaryReviewed, obstaclesReviewed: !!extra.obstaclesReviewed, obstacles: extra.obstacles || [],
      imageryReview: !!extra.imageryReview,
      roof: { type: 'flat', tilt: null, azimuth: null }, reference: {},
    };
    commit((s) => { s.buildings.push(b); });
    if (select) ui.selected = b.id;
    ui.tab = 'buildings';
    render();
    return b;
  }

  async function loadOsm(area) {
    ui.busy.add('osm');
    render();
    try {
      const bbox = turf.bbox(area.geometry);
      const { buildings, sites } = await fetchOsm(bbox);
      const shape = turf.polygon(area.geometry.coordinates);
      const inArea = (g) => turf.booleanPointInPolygon(turf.centroid(turf.polygon(g.coordinates)), shape);
      const existing = new Set(state.buildings.filter((b) => b.sourceId).map((b) => b.sourceId));
      const fresh = buildings.filter((x) => inArea(x.geometry) && !existing.has(x.osmId));
      commit((s) => {
        area.sites = sites.filter((x) => inArea(x.geometry));
        area.osmLoadedAt = Date.now();
        area.osmFound = buildings.filter((x) => inArea(x.geometry)).length;
        let n = s.buildings.filter((b) => b.areaId === area.id).length;
        for (const x of fresh) {
          n++;
          s.buildings.push({
            id: uid('bld'), areaId: area.id, name: x.name || `مبنى ${n}`, geometry: x.geometry,
            source: 'osm', sourceId: x.osmId, confidence: null, boundaryReviewed: false,
            obstaclesReviewed: false, obstacles: [], roof: { type: 'flat', tilt: null, azimuth: null }, reference: {},
          });
        }
      });
      toast(area.osmFound ? `عدد المباني الموجودة في OpenStreetMap: ${fmt(area.osmFound)}.` : 'لا توجد مبانٍ مسجلة هنا في OpenStreetMap. استخدم الكشف بنقرة أو الرسم اليدوي.', area.osmFound ? 'ok' : 'info');
    } catch {
      toast('تعذر الاتصال بخوادم OpenStreetMap الآن. أعد المحاولة بعد قليل أو أضف المباني يدويًا.', 'error');
    }
    ui.busy.delete('osm');
    render();
  }

  function startEditBoundary(b) {
    const layer = L.polygon(b.geometry.coordinates[0].slice(0, -1).map(([lon, lat]) => [lat, lon]), { color: '#F2C66B', weight: 2, fillOpacity: 0.1 }).addTo(map);
    ui.editLayer = layer;
    buildingsLayer.clearLayers(); panelsLayer.clearLayers();
    layer.pm.enable({ allowSelfIntersection: false, snappable: false });
    const bar = root.querySelector('#modeBar');
    ui.mode = 'edit';
    bar.hidden = false;
    bar.innerHTML = `<span>اسحب النقاط لتصحيح حدود السطح</span><button class="btn btn-sm btn-sun" data-act="save-edit">حفظ الحدود</button><button class="btn btn-sm btn-light" data-act="cancel-mode">إلغاء</button>`;
  }

  // ---------- لوحة التحكم ----------
  function renderSummary() {
    const area = activeArea();
    const rows = area ? ui.results.filter(({ b }) => b.areaId === area.id) : [];
    const t = aggregate(rows);
    const e = energyLabel(t.withEnergy ? t.annualKWh : null);
    root.querySelector('#summary').innerHTML = !area ? '' : `
      <div class="sum-item"><b>${fmt(t.buildings)}</b><span>مبنى</span></div>
      <div class="sum-item"><b>${fmt(t.usableM2)}</b><span>م² قابلة للاستخدام</span></div>
      <div class="sum-item"><b>${fmt(t.panels)}</b><span>لوح</span></div>
      <div class="sum-item"><b>${fmt(t.kWp, 1)}</b><span>kWp</span></div>
      <div class="sum-item sum-key"><b>${e.value}</b><span>${e.unit}</span></div>`;
  }

  function areaTab() {
    return `
      <div class="pad">
        <button class="pilot" data-act="pilot">
          <span class="pilot-kicker">النموذج التجريبي</span>
          <strong>${PILOT.name}</strong>
          <span>مالك بن أنس سابقًا، قرية قميراء، ولاية ضنك. انتقل إلى موقعها وابدأ التحليل مباشرة.</span>
        </button>
        <label class="field"><span>ابحث عن موقع في عُمان</span>
          <form class="search" data-form="search">
            <input type="search" name="q" placeholder="مثال: البريمي، صحار، جامعة…" autocomplete="off">
            <button class="btn btn-primary" ${ui.busy.has('search') ? 'disabled' : ''}>بحث</button>
          </form>
        </label>
        <div id="searchResults">${ui.searchHtml || ''}</div>
        <div class="section-label">أو ارسم منطقة الدراسة</div>
        <div class="btn-row">
          <button class="btn btn-outline" data-act="draw-rect">مستطيل</button>
          <button class="btn btn-outline" data-act="draw-poly">مضلع حر</button>
        </div>
        ${state.areas.length ? `<div class="section-label">المناطق (${fmt(state.areas.length)})</div>` : ''}
        <ul class="area-list">
          ${state.areas.map((a) => {
            const n = state.buildings.filter((b) => b.areaId === a.id).length;
            const on = a.id === state.activeAreaId;
            return `<li class="${on ? 'is-on' : ''}">
              <button class="area-open" data-act="open-area" data-id="${a.id}"><strong>${esc(a.name)}</strong>
                <span>${esc([a.wilaya, a.governorate].filter(Boolean).join('، ') || 'لم تُحدد التبعية الإدارية')} · ${fmt(n)} مبنى · ${fmt(turf.area(a.geometry) / 1e6, 2)} كم²</span></button>
              ${on ? `<div class="area-fields">
                ${textField('اسم المنطقة', 'area.name', a.name)}
                <div class="grid-3">
                  ${textField('الحي / القرية', 'area.neighborhood', a.neighborhood)}
                  ${textField('الولاية', 'area.wilaya', a.wilaya)}
                  ${textField('المحافظة', 'area.governorate', a.governorate)}
                </div>
                <button class="btn-text danger" data-act="del-area" data-id="${a.id}">حذف المنطقة ومبانيها</button>
              </div>` : ''}
            </li>`;
          }).join('')}
        </ul>
      </div>`;
  }

  const textField = (label, path, value) => `<label class="field"><span>${label}</span><input type="text" data-set="${path}" value="${esc(value)}"></label>`;
  const numField = (label, path, value, unit, min, max, step = 'any', tip = '') => `
    <label class="field" ${tip ? `data-tip="${esc(tip)}"` : ''}><span>${label}</span>
      <span class="input-unit"><input type="number" lang="en" data-num="${path}" value="${value ?? ''}" min="${min}" max="${max}" step="${step}"><i>${unit}</i></span></label>`;

  function buildingsTab() {
    const area = activeArea();
    if (!area) {
      return `<div class="pad empty"><h3>حدد منطقة الدراسة أولًا</h3><p>المباني والنتائج تُجمع داخل منطقة تختارها.</p><button class="btn btn-primary" data-act="tab" data-tab="area">اختيار منطقة</button></div>`;
    }
    const rows = ui.results.filter(({ b }) => b.areaId === area.id)
      .sort((x, y) => (y.r.annualKWh ?? y.r.footprintM2) - (x.r.annualKWh ?? x.r.footprintM2));
    return `
      <div class="pad">
        <div class="area-head"><strong>${esc(area.name)}</strong><button class="btn-text" data-act="tab" data-tab="area">تغيير</button></div>
        ${area.climateError ? `<div class="notice notice-warn"><span>${esc(area.climateError)}</span><button class="btn-text" data-act="retry-climate">إعادة المحاولة</button></div>` : ''}
        ${ui.busy.has('climate') ? '<div class="notice">جارٍ جلب بيانات المناخ من NASA POWER…</div>' : ''}
        <div class="section-label">إضافة المباني</div>
        <div class="tool-list">
          <button class="tool" data-act="load-osm" ${ui.busy.has('osm') ? 'disabled' : ''}>
            <strong>${ui.busy.has('osm') ? 'جارٍ الجلب…' : 'جلب من OpenStreetMap'}</strong>
            <span>${area.osmLoadedAt ? `آخر جلب: ${fmt(area.osmFound)} مبنى` : 'بصمات المباني المسجلة داخل المنطقة'}</span>
          </button>
          <button class="tool ${ui.mode === 'detect' ? 'is-on' : ''}" data-act="detect">
            <strong>${ui.busy.has('detect') ? 'جارٍ تحليل الصورة…' : 'كشف السطح بنقرة'}</strong>
            <span>انقر وسط السطح على صورة القمر الصناعي</span>
          </button>
          ${ui.mode === 'detect' ? `<label class="field slim"><span>حساسية الكشف: ${ui.tolerance}</span><input type="range" min="6" max="30" value="${ui.tolerance}" data-tol></label>` : ''}
          <button class="tool" data-act="draw-building"><strong>رسم يدوي</strong><span>أدق خيار عند وضوح الصورة</span></button>
          <label class="tool"><strong>استيراد GeoJSON</strong><span>مضلعات مبانٍ من مصدر معتمد لديك</span>
            <input type="file" accept=".geojson,.json,application/geo+json" data-import hidden></label>
        </div>
        ${area.osmLoadedAt && area.osmFound < 3 ? '<div class="notice">تغطية OpenStreetMap محدودة هنا، وهذا متوقع في المناطق الريفية. الكشف بنقرة والرسم اليدوي يكملان النقص.</div>' : ''}
        <div class="section-label">المباني (${fmt(rows.length)})</div>
        ${rows.length ? `<ul class="bld-list">${rows.map(({ b, r }) => `
          <li><button data-act="select" data-id="${b.id}">
            <span class="bld-top"><strong>${esc(b.name)}</strong><span class="chip ${CONF[r.confidence].cls}">${CONF[r.confidence].icon} ${CONF[r.confidence].label}</span></span>
            <span class="bld-meta">${fmt(r.footprintM2)} م² · ${fmt(r.panelCount)} لوح · ${fmt(r.kWp, 1)} kWp · ${r.annualKWh != null ? `${fmt(r.annualKWh / 1000, 1)} MWh/سنة` : 'الإنتاج غير محسوب'}</span>
          </button></li>`).join('')}</ul>
          <a class="btn btn-outline full" href="#/dashboard">عرض لوحة المعلومات</a>` : '<p class="muted">لم تُضف مبانٍ بعد. ابدأ بإحدى الأدوات أعلاه.</p>'}
      </div>`;
  }

  function systemTab() {
    const s = state.settings;
    const loss = totalLossFraction(s.losses) * 100;
    return `
      <div class="pad">
        <p class="muted">تُطبق هذه الافتراضات على كل المباني، ويمكن تخصيص الميل والاتجاه لكل مبنى من صفحته.</p>
        <div class="section-label">اللوح الشمسي</div>
        <label class="field"><span>الفئة</span><select data-preset>
          ${PANEL_PRESETS.map((p) => `<option value="${p.id}" ${s.panelPreset === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
          <option value="custom" ${s.panelPreset === 'custom' ? 'selected' : ''}>مواصفات مخصصة</option>
        </select></label>
        <div class="grid-3">
          ${numField('القدرة', 'panel.watt', s.panel.watt, 'واط', 100, 900)}
          ${numField('العرض', 'panel.widthM', s.panel.widthM, 'م', 0.5, 2)}
          ${numField('الطول', 'panel.lengthM', s.panel.lengthM, 'م', 0.8, 3)}
        </div>
        ${numField('معامل الحرارة', 'panel.gamma', s.panel.gamma, '%/°م', -0.6, -0.2, 0.01, 'نسبة انخفاض القدرة لكل درجة فوق 25°م')}
        <div class="section-label">التركيب على الأسطح المستوية</div>
        <div class="grid-2">
          ${numField('زاوية الميل', 'flatTilt', s.flatTilt, '°', 0, 45, 1)}
          <label class="field"><span>اتجاه الصفوف</span><select data-select="alignment">
            <option value="south" ${s.alignment === 'south' ? 'selected' : ''}>نحو الجنوب</option>
            <option value="building" ${s.alignment === 'building' ? 'selected' : ''}>موازٍ لحافة المبنى</option>
          </select></label>
        </div>
        <div class="grid-2">
          ${numField('ارتداد الحواف', 'setback', s.setback, 'م', 0, 5, 0.1, 'مسافة خالية عند حافة السطح')}
          ${numField('خلوص العوائق', 'obstacleClearance', s.obstacleClearance, 'م', 0, 3, 0.1)}
          ${numField('ممر صيانة كل', 'aisleEvery', s.aisleEvery, 'لوح', 0, 50, 1, 'صفر يعني بدون ممرات عرضية')}
          ${numField('عرض الممر', 'aisleWidth', s.aisleWidth, 'م', 0, 2, 0.1)}
        </div>
        <div class="section-label">الخسائر والأداء <span class="muted">(مجموع الخسائر ${fmt(loss, 1)}%)</span></div>
        <div class="grid-2">
          ${numField('الغبار والاتساخ', 'losses.soiling', s.losses.soiling, '%', 0, 30, 0.5, 'عامل مؤثر في مناخ عُمان، ويعتمد على جدول التنظيف')}
          ${numField('الأسلاك', 'losses.wiring', s.losses.wiring, '%', 0, 10, 0.5)}
          ${numField('عدم التطابق', 'losses.mismatch', s.losses.mismatch, '%', 0, 10, 0.5)}
          ${numField('التوافر', 'losses.availability', s.losses.availability, '%', 0, 10, 0.5)}
          ${numField('تفاوت القدرة والتدهور', 'losses.nameplate', s.losses.nameplate, '%', 0, 10, 0.5)}
          ${numField('كفاءة العاكس', 'inverterEff', s.inverterEff, '%', 85, 100, 0.5)}
        </div>
      </div>`;
  }

  function buildingDetail(b, r) {
    const conf = CONF[r.confidence];
    const e = energyLabel(r.annualKWh);
    const climate = climateFor(state.areas.find((a) => a.id === b.areaId) || {});
    return `
      <div class="detail-head">
        <button class="btn-text" data-act="close-detail">→ كل المباني</button>
        <input class="title-input" type="text" data-set="b.name" value="${esc(b.name)}" aria-label="اسم المبنى">
        <div class="chips">
          <span class="chip ${conf.cls}">${conf.icon} ${conf.label}</span>
          <span class="chip">${SOURCE_LABEL[b.source] || b.source}</span>
        </div>
      </div>
      <div class="pad">
        <div class="hero-stat">
          <span class="stat-label">الإنتاج السنوي المتوقع</span>
          <span class="hero-num">${e.value} <small>${e.unit}</small></span>
        </div>
        <div class="stat-grid">
          ${stat('بصمة المبنى', fmt(r.footprintM2), 'م²')}
          ${stat('مساحة السطح', fmt(r.roofM2), 'م²', r.flat ? 'السطح المستوي: تساوي البصمة' : 'البصمة مقسومة على جيب تمام الميل')}
          ${stat('قابلة للاستخدام', fmt(r.usableM2), 'م²', 'بعد خصم الارتدادات والعوائق المرسومة')}
          ${stat('عدد الألواح', fmt(r.panelCount), 'لوح')}
          ${stat('القدرة الاسمية', fmt(r.kWp, 1), 'kWp')}
          ${stat('الإنتاج النوعي', r.energy ? fmt(r.energy.specificYield) : '—', 'kWh/kWp', 'الإنتاج السنوي لكل كيلوواط ذروة مركب')}
        </div>
        ${r.energy ? `<div class="section-label">الإنتاج الشهري (kWh)</div>${monthlyChart(r.energy.months.map((m) => m.kWh))}` : ''}

        <div class="section-label">السطح</div>
        <div class="grid-2">
          <label class="field"><span>نوع السطح</span><select data-select="b.roof.type">
            <option value="flat" ${r.flat ? 'selected' : ''}>مستوٍ</option>
            <option value="pitched" ${r.flat ? '' : 'selected'}>مائل</option>
          </select></label>
          ${numField(r.flat ? 'ميل الألواح' : 'ميل السطح', 'b.roof.tilt', b.roof.tilt ?? r.tilt, '°', 0, 60, 1)}
          ${numField('اتجاه الألواح', 'b.roof.azimuth', b.roof.azimuth ?? Math.round(r.azimuth), '°', 0, 359, 1, '0 شمال، 90 شرق، 180 جنوب، 270 غرب')}
        </div>
        <div class="btn-row">
          <button class="btn btn-outline" data-act="edit-boundary">تصحيح الحدود</button>
          <button class="btn btn-outline" data-act="draw-obstacle">رسم عائق</button>
        </div>
        ${b.obstacles.length ? `<p class="muted">${fmt(b.obstacles.length)} عائق مرسوم · <button class="btn-text" data-act="clear-obstacles">حذف العوائق</button></p>` : ''}
        <label class="check"><input type="checkbox" data-check="obstaclesReviewed" ${b.obstaclesReviewed ? 'checked' : ''}> راجعتُ العوائق على السطح</label>
        <label class="check"><input type="checkbox" data-check="boundaryReviewed" ${b.boundaryReviewed ? 'checked' : ''}> طابقتُ حدود السطح مع الصورة</label>
        ${b.imageryReview ? `<label class="check"><input type="checkbox" data-check="fieldVerified" ${b.fieldVerified ? 'checked' : ''}> تحققتُ من السطح ميدانيًا</label>` : ''}

        ${r.flags.length ? `<div class="section-label">يحتاج إلى استكمال</div><ul class="flags">${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}

        <details class="assume"><summary>الافتراضات التي بُني عليها الحساب</summary>
          <ul>
            <li>ميل ${fmt(r.tilt)}° واتجاه ${fmt(r.azimuth)}° (180 = جنوب)</li>
            <li>${esc(state.settings.panel.name || 'لوح')}: ${fmt(state.settings.panel.watt)} واط، ${state.settings.panel.lengthM}×${state.settings.panel.widthM} م</li>
            ${r.flat && r.pitch ? `<li>تباعد الصفوف ${fmt(r.pitch, 2)} م، منها ${fmt(r.gap, 2)} م لتجنب الظل (9 صباحًا، الانقلاب الشتوي)</li>` : ''}
            <li>ارتداد ${fmt(state.settings.setback, 1)} م، وخسائر ${fmt(totalLossFraction(state.settings.losses) * 100, 1)}%، وكفاءة عاكس ${fmt(state.settings.inverterEff, 1)}%</li>
            <li>المناخ: ${climate ? `${esc(climate.source)} عند ${climate.key}` : 'غير محمل'}</li>
            <li>لا يشمل الحساب ظل المباني والأشجار المجاورة ولا قدرة السطح الإنشائية.</li>
          </ul>
        </details>

        <details class="assume"><summary>بيانات مرجعية للتحقق</summary>
          <p class="muted">أدخل قياسات موثوقة إن توفرت لتظهر مؤشرات الخطأ في لوحة المعلومات.</p>
          <div class="grid-2">
            ${numField('مساحة السطح المرجعية', 'b.reference.areaM2', b.reference.areaM2, 'م²', 0, 1e6)}
            ${numField('عدد الألواح المرجعي', 'b.reference.panels', b.reference.panels, 'لوح', 0, 1e5, 1)}
            ${numField('الإنتاج السنوي المرجعي', 'b.reference.annualKWh', b.reference.annualKWh, 'kWh', 0, 1e9)}
          </div>
        </details>

        <div class="btn-row">
          <a class="btn btn-primary" href="#/report/${b.id}">تقرير المبنى</a>
          <button class="btn-text danger" data-act="del-building">حذف المبنى</button>
        </div>
      </div>`;
  }

  function renderPanel() {
    const selected = ui.selected && ui.results.find(({ b }) => b.id === ui.selected);
    if (selected) {
      panel.innerHTML = buildingDetail(selected.b, selected.r);
      return;
    }
    const tabs = [['area', '١ المنطقة'], ['buildings', '٢ المباني'], ['system', '٣ الافتراضات']];
    panel.innerHTML = `
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${ui.tab === k}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>
      ${ui.tab === 'area' ? areaTab() : ui.tab === 'buildings' ? buildingsTab() : systemTab()}`;
  }

  function render() {
    if (!alive) return; // قد تكتمل طلبات الشبكة بعد مغادرة الصفحة
    ui.results = state.buildings.map((b) => ({ b, r: analyze(b) }));
    if (ui.selected && !ui.results.some(({ b }) => b.id === ui.selected)) ui.selected = null;
    renderPanel();
    renderSummary();
    drawMap();
  }

  // ---------- الأحداث ----------
  const selectedBuilding = () => state.buildings.find((b) => b.id === ui.selected);

  const actions = {
    tab: (el) => { ui.tab = el.dataset.tab; ui.selected = null; render(); },
    select: (el) => {
      if (ui.mode === 'detect') setMode(null);
      ui.selected = el.dataset.id;
      render();
      const b = selectedBuilding();
      if (b) map.fitBounds(L.geoJSON(b.geometry).getBounds(), { padding: [80, 80], maxZoom: 19 });
    },
    'close-detail': () => { ui.selected = null; render(); },
    'open-area': (el) => {
      commit((s) => { s.activeAreaId = el.dataset.id; });
      const area = activeArea();
      fitArea(area);
      if (!area.climateKey) ensureClimate(area);
      render();
    },
    'del-area': (el) => {
      const a = state.areas.find((x) => x.id === el.dataset.id);
      const n = state.buildings.filter((b) => b.areaId === a.id).length;
      if (!confirm(`حذف «${a.name}» و${n} مبنى داخلها؟ لا يمكن التراجع عن ذلك.`)) return;
      commit((s) => {
        s.areas = s.areas.filter((x) => x.id !== a.id);
        s.buildings = s.buildings.filter((b) => b.areaId !== a.id);
        if (s.activeAreaId === a.id) s.activeAreaId = s.areas[0]?.id || null;
      });
      render();
    },
    pilot: async () => {
      let existing = state.areas.find((a) => a.isPilot);
      if (existing && existing.pilotRev !== PILOT.rev) {
        // نسخة أقدم من النموذج: نستبدلها بعد موافقة المستخدم لأنها قد تحتوي تعديلاته
        if (!confirm('تتوفر بيانات محدثة للنموذج التجريبي بعد مراجعة السطح. هل تريد استبدال النسخة الحالية؟')) {
          commit((s) => { s.activeAreaId = existing.id; });
          fitArea(existing);
          ui.tab = 'buildings';
          render();
          return;
        }
        const oldId = existing.id;
        commit((s) => {
          s.areas = s.areas.filter((a) => a.id !== oldId);
          s.buildings = s.buildings.filter((b) => b.areaId !== oldId);
        });
        existing = null;
      }
      if (existing) {
        commit((s) => { s.activeAreaId = existing.id; });
        fitArea(existing);
        ui.tab = 'buildings';
        render();
        return;
      }
      const [w, s, e, n] = PILOT.bbox;
      const area = await createArea({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, PILOT);
      if (area) {
        commit(() => { area.isPilot = true; area.pilotRev = PILOT.rev; });
        addBuilding(structuredClone(PILOT.building.geometry), {
          name: PILOT.building.name, source: 'manual', sourceId: PILOT.building.sourceId,
          boundaryReviewed: true, obstaclesReviewed: true, imageryReview: true,
          obstacles: structuredClone(PILOT.building.obstacles),
        }, false);
        loadOsm(area);
      }
    },
    'draw-rect': () => { setMode('area', 'اسحب لرسم مستطيل منطقة الدراسة'); map.pm.enableDraw('Rectangle'); },
    'draw-poly': () => { setMode('area', 'انقر لوضع النقاط، ثم انقر النقطة الأولى لإغلاق المضلع'); map.pm.enableDraw('Polygon'); },
    'draw-building': () => {
      if (map.getZoom() < 17 && activeArea()) fitArea(activeArea());
      setMode('building', 'ارسم حدود السطح نقطة نقطة، ثم أغلق المضلع');
      map.pm.enableDraw('Polygon');
    },
    'draw-obstacle': () => { setMode('obstacle', 'ارسم حول العائق (مكيف، خزان، سلم…)'); map.pm.enableDraw('Polygon'); },
    detect: () => {
      if (ui.mode === 'detect') { cancelMode(); return; }
      setMode('detect', 'انقر وسط السطح في صورة القمر الصناعي');
      renderPanel();
    },
    'cancel-mode': cancelMode,
    'load-osm': () => loadOsm(activeArea()),
    'retry-climate': () => ensureClimate(activeArea()),
    'edit-boundary': () => { const b = selectedBuilding(); if (b) startEditBoundary(b); },
    'save-edit': () => {
      const b = selectedBuilding();
      const geo = ui.editLayer.toGeoJSON().geometry;
      ui.editLayer.pm.disable();
      map.removeLayer(ui.editLayer);
      ui.editLayer = null;
      setMode(null);
      commit(() => { b.geometry = geo; b.boundaryReviewed = true; });
      render();
    },
    'clear-obstacles': () => { const b = selectedBuilding(); commit(() => { b.obstacles = []; }); render(); },
    'del-building': () => {
      const b = selectedBuilding();
      if (!confirm(`حذف «${b.name}»؟`)) return;
      commit((s) => { s.buildings = s.buildings.filter((x) => x.id !== b.id); });
      ui.selected = null;
      render();
    },
    'pick-place': (el) => {
      const bb = el.dataset.bbox.split(',').map(Number);
      map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17 });
      ui.searchHtml = `<div class="notice">تمركزت الخريطة على ${esc(el.dataset.name)}. ارسم الآن حدود منطقة الدراسة.</div>`;
      renderPanel();
    },
  };

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) {
      e.preventDefault();
      actions[el.dataset.act](el);
    }
  }
  root.addEventListener('click', onClick);

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-base]');
    if (!btn) return;
    Object.values(bases).forEach((l) => map.removeLayer(l));
    bases[btn.dataset.base].addTo(map);
    root.querySelectorAll('[data-base]').forEach((x) => x.classList.toggle('is-on', x === btn));
  });

  function setPath(obj, parts, value) {
    let o = obj;
    parts.slice(0, -1).forEach((p) => { o = o[p]; });
    o[parts[parts.length - 1]] = value;
  }

  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q')?.trim();
    if (!q) return;
    ui.busy.add('search');
    try {
      const hits = await searchPlace(q);
      ui.searchHtml = hits.length ? `<ul class="hits">${hits.map((h) => `<li><button data-act="pick-place" data-name="${esc(h.name || h.display_name)}" data-bbox="${h.boundingbox.join(',')}">${esc(h.display_name)}</button></li>`).join('')}</ul>` : '<div class="notice">لا توجد نتائج مطابقة في عُمان. جرّب كتابة الاسم بطريقة أخرى.</div>';
    } catch {
      ui.searchHtml = '<div class="notice notice-warn">تعذر البحث الآن. يمكنك تحريك الخريطة يدويًا.</div>';
    }
    ui.busy.delete('search');
    renderPanel();
    const input = panel.querySelector('input[name="q"]');
    if (input) input.value = q;
  });

  panel.addEventListener('input', (e) => {
    if (e.target.matches('[data-tol]')) {
      ui.tolerance = Number(e.target.value);
      e.target.previousElementSibling.textContent = `حساسية الكشف: ${ui.tolerance}`;
    }
  });

  panel.addEventListener('change', async (e) => {
    const el = e.target;
    const b = selectedBuilding();
    const area = activeArea();
    if (el.dataset.set) {
      const [root0, ...rest] = el.dataset.set.split('.');
      commit(() => setPath(root0 === 'b' ? b : area, rest, el.value));
      render();
    } else if (el.dataset.num) {
      const parts = el.dataset.num.split('.');
      const raw = el.value === '' ? null : Number(el.value);
      if (raw != null && !Number.isFinite(raw)) return;
      const min = Number(el.min), max = Number(el.max);
      const value = raw == null ? null : Math.min(max, Math.max(min, raw));
      commit((s) => {
        if (parts[0] === 'b') setPath(b, parts.slice(1), value);
        else {
          if (value == null) return;
          setPath(s.settings, parts, value);
          if (parts[0] === 'panel') { s.settings.panelPreset = 'custom'; s.settings.panel.name = 'مواصفات مخصصة'; }
        }
      });
      render();
    } else if (el.dataset.select) {
      const parts = el.dataset.select.split('.');
      commit((s) => {
        if (parts[0] === 'b') setPath(b, parts.slice(1), el.value);
        else setPath(s.settings, parts, el.value);
      });
      render();
    } else if ('preset' in el.dataset) {
      const p = PANEL_PRESETS.find((x) => x.id === el.value);
      commit((s) => { s.settings.panelPreset = el.value; if (p) s.settings.panel = { ...p }; });
      render();
    } else if (el.dataset.check) {
      commit(() => { b[el.dataset.check] = el.checked; });
      render();
    } else if ('import' in el.dataset && el.files[0]) {
      try {
        const json = JSON.parse(await el.files[0].text());
        const features = json.type === 'FeatureCollection' ? json.features : [json];
        const polys = features.flatMap((f) => {
          const g = f.geometry || f;
          if (g.type === 'Polygon') return [{ g, name: f.properties?.name }];
          if (g.type === 'MultiPolygon') return g.coordinates.map((c) => ({ g: { type: 'Polygon', coordinates: c }, name: f.properties?.name }));
          return [];
        });
        if (!polys.length) throw new Error();
        commit((s) => {
          let n = s.buildings.filter((x) => x.areaId === area.id).length;
          for (const { g, name } of polys) {
            n++;
            s.buildings.push({ id: uid('bld'), areaId: area.id, name: name || `مبنى ${n}`, geometry: g, source: 'import', sourceId: null, confidence: null, boundaryReviewed: false, obstaclesReviewed: false, obstacles: [], roof: { type: 'flat', tilt: null, azimuth: null }, reference: {} });
          }
        });
        toast(`استُورد ${fmt(polys.length)} مبنى.`, 'ok');
        render();
      } catch {
        toast('تعذرت قراءة الملف. يلزم GeoJSON يحتوي على مضلعات.', 'error');
      }
    }
  });

  const unsub = subscribe(() => {});
  render();
  const area = activeArea();
  if (area) { fitArea(area); if (!area.climateKey) ensureClimate(area); }

  return () => {
    alive = false;
    unsub();
    map.stop();
    // ننتظر انتهاء حركة التكبير ورسم اللوحة، وإلا تستدعي Leaflet عناصر أُزيلت
    setTimeout(() => map.remove(), 500);
  };
}
