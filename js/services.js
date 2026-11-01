// الاتصال بمصادر البيانات الخارجية.
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPlace(q) {
  const url = `${NOMINATIM}/search?format=jsonv2&limit=6&accept-language=ar&countrycodes=om&q=${encodeURIComponent(q)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error('تعذر البحث الآن');
  return res.json();
}

export async function reverseAdmin(lat, lon) {
  const url = `${NOMINATIM}/reverse?format=jsonv2&zoom=14&accept-language=ar&lat=${lat}&lon=${lon}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return {};
  const a = (await res.json()).address || {};
  // في بيانات عُمان قد تأتي الولاية في حقل town أو city بدل county
  const isWilaya = (v) => v && v.startsWith('ولاية');
  const wilaya = [a.county, a.state_district, a.city_district, a.town, a.city].find(isWilaya) || a.county || a.city_district || '';
  return {
    neighborhood: a.suburb || a.neighbourhood || a.village || a.hamlet || [a.town, a.city].find((v) => v && !isWilaya(v)) || '',
    wilaya,
    governorate: a.state || a.region || '',
  };
}

async function overpass(query) {
  // الخوادم العامة تتعطل كثيرًا، فنأخذ أول خادم يجيب
  return Promise.any(OVERPASS.map(async (endpoint) => {
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    }, 45000);
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return res.json();
  }));
}

const closedRing = (geom) => {
  if (!geom || geom.length < 4) return null;
  const ring = geom.map((p) => [p.lon, p.lat]);
  const [a, z] = [ring[0], ring[ring.length - 1]];
  return a[0] === z[0] && a[1] === z[1] ? ring : null;
};

// يعيد بصمات المباني، والحدود المدرسية كطبقة مرجعية لا تُحسب مبانيَ
export async function fetchOsm([w, s, e, n]) {
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(way["building"](${bbox});way["amenity"="school"](${bbox}););out tags geom;`;
  const data = await overpass(q);
  const buildings = [], sites = [];
  for (const el of data.elements || []) {
    const ring = closedRing(el.geometry);
    if (!ring) continue;
    const item = { osmId: el.id, name: el.tags?.name || '', geometry: { type: 'Polygon', coordinates: [ring] }, tags: el.tags || {} };
    if (el.tags?.building) buildings.push(item);
    else sites.push(item);
  }
  return { buildings, sites };
}

export async function fetchClimate(lat, lon) {
  const params = 'ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DIFF,T2M,T2M_MAX,T2M_MIN,WS2M';
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=${params}&community=RE&longitude=${lon.toFixed(3)}&latitude=${lat.toFixed(3)}&format=JSON`;
  const res = await fetchWithTimeout(url, {}, 45000);
  if (!res.ok) throw new Error('تعذر جلب بيانات المناخ من NASA POWER');
  const json = await res.json();
  const p = json.properties.parameter;
  const months = MONTHS.map((m) => ({
    ghi: p.ALLSKY_SFC_SW_DWN[m], dhi: p.ALLSKY_SFC_SW_DIFF[m],
    t2m: p.T2M[m], tmax: p.T2M_MAX[m], tmin: p.T2M_MIN[m], ws: p.WS2M[m],
  }));
  if (months.some((m) => Object.values(m).some((v) => v == null || v <= -900))) {
    throw new Error('بيانات NASA POWER غير مكتملة لهذا الموقع');
  }
  return { key: `${lat.toFixed(2)},${lon.toFixed(2)}`, lat, lon, months, source: 'NASA POWER', range: json.header?.range || '' };
}
