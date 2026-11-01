// كشف السطح بنقرة: رؤية حاسوبية تقليدية (نمو منطقة لوني على صور الأقمار الصناعية).
// النتيجة تقدير أولي دائمًا ويجب أن يراجعه المستخدم.
import { loadTile, worldPx, nativeZoomAt, metersPerPixel } from './imagery.js';

const TILE = 256, COVER_M = 350; // نافذة التحليل حول النقرة

const pxWorld = (x, y, z) => {
  const s = TILE * 2 ** z, n = Math.PI - (2 * Math.PI * y) / s;
  return [(x / s) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
};

function toLab(r, g, b) {
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function dilate(mask, W, H) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - W] || mask[i + W]) out[i] = 1;
  }
  return out;
}
function erode(mask, W, H) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]) out[i] = 1;
  }
  return out;
}
const repeat = (fn, mask, W, H, n) => { for (let k = 0; k < n; k++) mask = fn(mask, W, H); return mask; };

function component(mask, W, H, seed) {
  const out = new Uint8Array(mask.length), stack = [seed];
  if (!mask[seed]) return out;
  out[seed] = 1;
  while (stack.length) {
    const i = stack.pop();
    for (const n of [i - 1, i + 1, i - W, i + W]) {
      if (n >= 0 && n < mask.length && mask[n] && !out[n]) { out[n] = 1; stack.push(n); }
    }
  }
  return out;
}

function fillHoles(mask, W, H) {
  const outside = new Uint8Array(mask.length), stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop();
    if (i < 0 || i >= mask.length || outside[i] || mask[i]) continue;
    outside[i] = 1;
    if (i % W > 0) stack.push(i - 1);
    if (i % W < W - 1) stack.push(i + 1);
    stack.push(i - W, i + W);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

// تتبع الحد الخارجي (Moore)
function traceContour(mask, W, H) {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];
  const sx = start % W, sy = Math.floor(start / W);
  const pts = [[sx, sy]];
  let x = sx, y = sy, d = 6, guard = W * H;
  while (guard-- > 0) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8;
      const nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
    }
    if (!moved || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return pts;
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let maxD = -1, idx = 0;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

export async function detectRoof(lat, lon, tolerance = 14) {
  const Z = await nativeZoomAt(lat, lon);
  const mpp = metersPerPixel(lat, Z);
  const GRID = Math.max(3, Math.ceil(COVER_M / (mpp * TILE)) | 1);
  // أنصاف أقطار المعالجة بالبكسل تتبع دقة الصورة: حوالي 0.8 م و0.5 م
  const openR = Math.max(1, Math.round(0.8 / mpp));
  const closeR = Math.max(1, Math.round(0.5 / mpp));
  const eps = Math.max(1.2, 0.8 / mpp);
  const [wx, wy] = worldPx(lat, lon, Z);
  const half = Math.floor(GRID / 2);
  const tx0 = Math.floor(wx / TILE) - half, ty0 = Math.floor(wy / TILE) - half;
  const W = GRID * TILE, H = GRID * TILE;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
    jobs.push(loadTile(Z, tx0 + i, ty0 + j).then((img) => ctx.drawImage(img, i * TILE, j * TILE)));
  }
  await Promise.all(jobs);
  const { data } = ctx.getImageData(0, 0, W, H);

  const px = Math.round(wx - tx0 * TILE), py = Math.round(wy - ty0 * TILE);
  const seedIdx = py * W + px;

  // لون البذرة: وسيط نافذة 7×7 حول النقرة
  const samples = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const k = ((py + dy) * W + px + dx) * 4;
    samples.push(toLab(data[k], data[k + 1], data[k + 2]));
  }
  const med = (c) => samples.map((s) => s[c]).sort((a, b) => a - b)[samples.length >> 1];
  const seed = [med(0), med(1), med(2)];

  const candidates = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const [L, a, b] = toLab(data[k], data[k + 1], data[k + 2]);
    // وزن أقل للسطوع لتحمل الظلال الخفيفة والبقع
    const d = Math.sqrt(((L - seed[0]) * 0.7) ** 2 + (a - seed[1]) ** 2 + (b - seed[2]) ** 2);
    if (d < tolerance) candidates[i] = 1;
  }

  // الفتح يقطع التسرب عبر الأجزاء الرفيعة (أرصفة وأسوار)، والإغلاق يعالج الفجوات الصغيرة
  let mask = repeat(erode, candidates, W, H, openR);
  mask = repeat(dilate, mask, W, H, openR);
  if (!mask[seedIdx]) {
    // قد يختفي موضع النقرة بعد الفتح؛ نبحث عن أقرب نقطة مرشحة
    let found = -1;
    for (let r = 1; r < 12 && found < 0; r++) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        const i = (py + dy) * W + px + dx;
        if (mask[i]) { found = i; break; }
      }
    }
    if (found < 0) throw new Error('لم يتميز السطح عن محيطه عند هذه النقطة. انقر في وسط السطح أو ارسم حدوده يدويًا.');
    mask = component(mask, W, H, found);
  } else {
    mask = component(mask, W, H, seedIdx);
  }
  mask = repeat(dilate, mask, W, H, closeR);
  mask = repeat(erode, mask, W, H, closeR);
  mask = fillHoles(mask, W, H);

  let count = 0, touchesEdge = false;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    count++;
    const x = i % W, y = (i / W) | 0;
    if (x < 3 || y < 3 || x > W - 4 || y > H - 4) touchesEdge = true;
  }

  const contour = traceContour(mask, W, H);
  if (contour.length < 8) throw new Error('تعذر استخراج حدود واضحة لهذا السطح. جرّب رفع حساسية الكشف أو الرسم اليدوي.');
  // الحد حلقة مغلقة: نقسمها عند أبعد نقطة عن البداية لأن التبسيط يحتاج إلى طرفين مختلفين
  let far = 0, farD = -1;
  contour.forEach(([x, y], i) => {
    const d = (x - contour[0][0]) ** 2 + (y - contour[0][1]) ** 2;
    if (d > farD) { farD = d; far = i; }
  });
  const simple = [
    ...simplify(contour.slice(0, far + 1), eps).slice(0, -1),
    ...simplify([...contour.slice(far), contour[0]], eps),
  ];
  if (simple.length < 4) throw new Error('الشكل الناتج غير صالح. جرّب نقطة أخرى أو الرسم اليدوي.');
  const ring = simple.map(([x, y]) => pxWorld(tx0 * TILE + x, ty0 * TILE + y, Z));
  ring[ring.length - 1] = ring[0];
  const geometry = { type: 'Polygon', coordinates: [ring] };

  const feature = turf.polygon(geometry.coordinates);
  const areaM2 = turf.area(feature);
  const hull = turf.convex(feature);
  const solidity = hull ? areaM2 / turf.area(hull) : 0;

  if (touchesEdge || areaM2 > 12000) {
    throw new Error('امتد الكشف خارج المبنى لتشابه الألوان مع المحيط. خفّض الحساسية أو ارسم الحدود يدويًا.');
  }
  if (areaM2 < 15) throw new Error('المساحة المكتشفة صغيرة جدًا. انقر في وسط السطح أو ارفع الحساسية.');

  const confidence = solidity > 0.88 ? 'medium' : 'low';
  return { geometry, areaM2, solidity, confidence, count, mpp };
}
