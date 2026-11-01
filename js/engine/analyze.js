// يربط هندسة المبنى بالتوزيع ونموذج الإنتاج، ويبني مؤشرات الثقة والتحقق الميداني.
import { layoutPanels, longestEdgeBearing } from './layout.js';
import { simulate, totalLossFraction } from './solar.js';
import { state, climateFor } from '../store.js';

const RAD = Math.PI / 180;
const cache = new Map();
export const timing = { lastMs: 0, samples: [] };

export function effectiveRoof(b, s) {
  const flat = b.roof.type !== 'pitched';
  const tilt = flat ? (b.roof.tilt ?? s.flatTilt) : (b.roof.tilt ?? 20);
  let azimuth;
  if (!flat) azimuth = b.roof.azimuth ?? 180;
  else if (b.roof.azimuth != null) azimuth = b.roof.azimuth;
  else if (s.alignment === 'building') {
    // صفوف موازية للضلع الأطول، بالواجهة الأقرب إلى الجنوب
    const bearing = longestEdgeBearing(b.geometry);
    const a = (bearing + 90) % 360, c = (a + 180) % 360;
    azimuth = Math.abs(a - 180) <= Math.abs(c - 180) ? a : c;
  } else azimuth = 180;
  return { flat, tilt, azimuth };
}

export function analyze(b) {
  const s = state.settings;
  const area = state.areas.find((a) => a.id === b.areaId);
  const climate = area ? climateFor(area) : null;
  const key = JSON.stringify([b.geometry, b.roof, b.obstacles, b.obstaclesReviewed, b.boundaryReviewed, b.imageryReview, b.fieldVerified, b.source, b.confidence, b.reference, s, climate ? climate.key : null]);
  const hit = cache.get(b.id);
  if (hit && hit.key === key) return hit.result;

  const t0 = performance.now();
  const feature = turf.polygon(b.geometry.coordinates);
  const footprintM2 = turf.area(feature);
  const [lon, lat] = turf.centroid(feature).geometry.coordinates;
  const { flat, tilt, azimuth } = effectiveRoof(b, s);
  const roofM2 = flat ? footprintM2 : footprintM2 / Math.cos(tilt * RAD);

  const layout = layoutPanels(b.geometry, {
    obstacles: b.obstacles,
    setback: s.setback,
    clearance: s.obstacleClearance,
    panel: s.panel,
    orientation: s.orientation,
    tilt, azimuth, flat, lat,
    aisleEvery: s.aisleEvery,
    aisleWidth: s.aisleWidth,
  });
  const kWp = (layout.count * s.panel.watt) / 1000;
  const usableM2 = flat ? layout.usableM2 : layout.usableM2 / Math.cos(tilt * RAD);

  let energy = null;
  if (climate && kWp > 0) {
    energy = simulate(climate, {
      lat, tilt, azimuth, kWp,
      lossFraction: totalLossFraction(s.losses),
      inverterEff: s.inverterEff / 100,
      gammaPct: s.panel.gamma,
      albedo: s.albedo, u0: s.u0, u1: s.u1,
    });
  }

  const flags = [];
  if (!flat && b.roof.tilt == null) flags.push('ميل السطح المائل مفترض ويحتاج إلى قياس');
  if (!b.obstaclesReviewed) flags.push('لم تُراجَع العوائق على السطح (مكيفات، خزانات، سلالم)');
  if (b.source === 'vision') flags.push('الحدود مكتشفة آليًا من الصور وتحتاج إلى مطابقة');
  if (b.source === 'osm') flags.push('بصمة المبنى من OpenStreetMap ولا تمثل تفاصيل السطح');
  if (layout.count === 0) flags.push('لا يتسع السطح لأي لوح وفق الافتراضات الحالية');
  if (!climate) flags.push('بيانات المناخ غير محملة بعد');

  let confidence;
  if (b.source === 'manual' || b.source === 'import' || b.boundaryReviewed) {
    confidence = b.obstaclesReviewed ? 'high' : 'medium';
  } else if (b.source === 'vision') confidence = b.confidence === 'low' ? 'low' : (b.obstaclesReviewed ? 'medium' : 'low');
  else confidence = b.obstaclesReviewed ? 'medium' : 'low';
  if (b.imageryReview && !b.fieldVerified) {
    // المراجعة من الصور لا ترى العوائق الصغيرة، فلا تتجاوز الثقة المتوسطة قبل التحقق الميداني
    flags.push('روجعت الحدود والعوائق من صورة بدقة 0.55 م تقريبًا، والعوائق الصغيرة قد لا تظهر فيها');
    if (confidence === 'high') confidence = 'medium';
  }
  if (layout.count === 0) confidence = 'low';

  const result = {
    id: b.id, lat, lon, footprintM2, roofM2, usableM2,
    tilt, azimuth, flat,
    panels: layout.panels, panelCount: layout.count, pitch: layout.pitch, gap: layout.gap,
    kWp, energy,
    annualKWh: energy ? energy.annualKWh : null,
    confidence, flags,
    needsField: confidence === 'low' || flags.length > 1,
  };
  const ms = performance.now() - t0;
  timing.lastMs = ms;
  timing.samples.push(ms);
  if (timing.samples.length > 200) timing.samples.shift();
  cache.set(b.id, { key, result });
  return result;
}

export const analyzeAll = (buildings = state.buildings) => buildings.map((b) => ({ b, r: analyze(b) }));

export function aggregate(rows) {
  const t = { buildings: rows.length, footprintM2: 0, roofM2: 0, usableM2: 0, panels: 0, kWp: 0, annualKWh: 0, months: Array(12).fill(0), withEnergy: 0 };
  for (const { r } of rows) {
    t.footprintM2 += r.footprintM2; t.roofM2 += r.roofM2; t.usableM2 += r.usableM2;
    t.panels += r.panelCount; t.kWp += r.kWp;
    if (r.energy) {
      t.annualKWh += r.annualKWh; t.withEnergy++;
      r.energy.months.forEach((m, i) => { t.months[i] += m.kWh; });
    }
  }
  return t;
}
