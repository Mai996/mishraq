// الدقة الأصلية لصور Esri تختلف بين المواقع؛ وفوقها تعيد الخدمة صورة رمادية بديلة بنجاح HTTP 200.
const TILE = 256;
const cache = new Map();

export const tileUrl = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

export function loadTile(z, x, y) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('تعذر تحميل صور الأقمار الصناعية'));
    img.src = tileUrl(z, x, y);
  });
}

export function worldPx(lat, lon, z) {
  const s = TILE * 2 ** z, sin = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
}

async function hasImagery(lat, lon, z) {
  const [wx, wy] = worldPx(lat, lon, z);
  const img = await loadTile(z, Math.floor(wx / TILE), Math.floor(wy / TILE));
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let sum = 0, sq = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { sum += d[i]; sq += d[i] * d[i]; }
  return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) > 8;
}

// أعلى مستوى تكبير يحتوي صورة حقيقية عند هذه النقطة
export function nativeZoomAt(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      for (let z = 19; z >= 15; z--) {
        if (await hasImagery(lat, lon, z)) return z;
      }
      return 15;
    })().catch(() => { cache.delete(key); return 17; }));
  }
  return cache.get(key);
}

export const metersPerPixel = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
