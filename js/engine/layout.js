// محرك توزيع الألواح: يطرح الارتداد والعوائق، ثم يبحث عن أفضل إزاحة لشبكة الألواح.
import { rowGapFactor } from './solar.js';

const R = 6371008.8, RAD = Math.PI / 180;
const MAX_PANELS = 20000;

function projector([lon0, lat0]) {
  const k = Math.cos(lat0 * RAD);
  return {
    fwd: ([lon, lat]) => [(lon - lon0) * RAD * R * k, (lat - lat0) * RAD * R],
    inv: ([x, y]) => [lon0 + x / (RAD * R * k), lat0 + y / (RAD * R)],
  };
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

function rectFits(rect, polys) {
  const mid = [(rect[0][0] + rect[2][0]) / 2, (rect[0][1] + rect[2][1]) / 2];
  for (const poly of polys) {
    const pts = [...rect, mid];
    if (!pts.every((p) => pointInRing(p, poly[0]))) continue;
    if (poly.slice(1).some((hole) => pts.some((p) => pointInRing(p, hole)))) continue;
    const crosses = poly.some((ring) => {
      for (let i = 0; i < ring.length - 1; i++) {
        for (let k = 0; k < 4; k++) {
          if (segmentsCross(rect[k], rect[(k + 1) % 4], ring[i], ring[i + 1])) return true;
        }
      }
      return false;
    });
    if (!crosses) return true;
  }
  return false;
}

// اتجاه الضلع الأطول في أصغر مستطيل محيط بالمبنى (بالدرجات من الشمال، 0-180)
export function longestEdgeBearing(geometry) {
  const hull = turf.convex(turf.polygon(geometry.coordinates));
  const ring = (hull || turf.polygon(geometry.coordinates)).geometry.coordinates[0];
  const proj = projector(ring[0]);
  const pts = ring.map(proj.fwd);
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ang = Math.atan2(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const ux = Math.sin(ang), uy = Math.cos(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of pts) {
      const u = x * ux + y * uy, v = x * uy - y * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const uLong = maxU - minU >= maxV - minV;
      const deg = (ang / RAD + (uLong ? 0 : 90) + 360) % 180;
      best = { area, deg };
    }
  }
  return best ? best.deg : 90;
}

export function usableArea(geometry, obstacles, setback, clearance) {
  let shape = turf.polygon(geometry.coordinates);
  if (setback > 0) {
    shape = turf.buffer(shape, -setback, { units: 'meters' });
    if (!shape || !shape.geometry || !shape.geometry.coordinates.length) return null;
  }
  for (const ob of obstacles || []) {
    const grown = clearance > 0 ? turf.buffer(turf.polygon(ob.coordinates), clearance, { units: 'meters' }) : turf.polygon(ob.coordinates);
    if (!grown) continue;
    const next = turf.difference(turf.featureCollection([shape, grown]));
    if (!next) return null;
    shape = next;
  }
  return shape;
}

// تعيد الألواح ومقاييس التوزيع
export function layoutPanels(geometry, cfg) {
  const { obstacles, setback, clearance, panel, orientation, tilt, azimuth, flat, lat, aisleEvery, aisleWidth } = cfg;
  const usable = usableArea(geometry, obstacles, setback, clearance);
  const empty = { panels: [], count: 0, usableM2: 0, azimuth, pitch: 0, gap: 0 };
  if (!usable) return empty;
  const usableM2 = turf.area(usable);

  const along = orientation === 'landscape' ? panel.lengthM : panel.widthM;
  const slope = orientation === 'landscape' ? panel.widthM : panel.lengthM;
  const depth = slope * Math.cos(tilt * RAD);
  const gap = flat ? slope * Math.sin(tilt * RAD) * rowGapFactor(lat) : 0.03;
  const pitch = depth + gap;

  const origin = turf.centroid(turf.polygon(geometry.coordinates)).geometry.coordinates;
  const proj = projector(origin);
  const A = azimuth * RAD;
  const f = [Math.sin(A), Math.cos(A)];   // اتجاه واجهة اللوح
  const r = [Math.cos(A), -Math.sin(A)];  // اتجاه الصف
  const toUV = ([x, y]) => [x * r[0] + y * r[1], x * f[0] + y * f[1]];
  const fromUV = ([u, v]) => [u * r[0] + v * f[0], u * r[1] + v * f[1]];

  const raw = usable.geometry.type === 'Polygon' ? [usable.geometry.coordinates] : usable.geometry.coordinates;
  const polys = raw.map((poly) => poly.map((ring) => ring.map((c) => toUV(proj.fwd(c)))));
  const all = polys.flat(2);
  const minU = Math.min(...all.map((p) => p[0])), maxU = Math.max(...all.map((p) => p[0]));
  const minV = Math.min(...all.map((p) => p[1])), maxV = Math.max(...all.map((p) => p[1]));

  const stepU = along + 0.02;
  const blockGap = aisleEvery > 0 ? aisleWidth : 0;
  const placeAt = (offU, offV) => {
    const out = [];
    for (let v = minV + offV; v + depth <= maxV + 1e-6; v += pitch) {
      // أعمدة ثابتة عبر كل الصفوف، كما في التركيب الفعلي
      for (let col = 0; ; col++) {
        const u = minU + offU + col * stepU + (aisleEvery > 0 ? Math.floor(col / aisleEvery) * blockGap : 0);
        if (u + along > maxU + 1e-6) break;
        const rect = [[u, v], [u + along, v], [u + along, v + depth], [u, v + depth]];
        if (rectFits(rect, polys)) {
          out.push(rect);
          if (out.length >= MAX_PANELS) return out;
        }
      }
    }
    return out;
  };

  let best = [];
  const tries = 5;
  for (let i = 0; i < tries; i++) {
    for (let j = 0; j < tries; j++) {
      const res = placeAt((i / tries) * stepU, (j / tries) * pitch);
      if (res.length > best.length) best = res;
    }
  }
  const panels = best.map((rect) => rect.map((p) => proj.inv(fromUV(p))));
  return { panels, count: panels.length, usableM2, azimuth, pitch, gap };
}
