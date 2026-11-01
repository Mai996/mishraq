// نموذج الإنتاج الكهربائي: يوم ممثل لكل شهر بخطوة ربع ساعة.
// المدخلات: متوسطات مناخية شهرية (NASA POWER). المخرجات: kWh شهريًا وسنويًا.
const RAD = Math.PI / 180;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const REP_DAY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344]; // أيام Klein الممثلة
const STEP_H = 0.25;

const declination = (n) => 23.45 * RAD * Math.sin((2 * Math.PI * (284 + n)) / 365);

export function totalLossFraction(l) {
  const keep = [l.soiling, l.wiring, l.mismatch, l.availability, l.nameplate]
    .reduce((acc, pct) => acc * (1 - pct / 100), 1);
  return 1 - keep;
}

export function simulate(climate, opts) {
  const { lat, tilt, azimuth, kWp, lossFraction, inverterEff, gammaPct, albedo, u0, u1 } = opts;
  const phi = lat * RAD, beta = tilt * RAD, gamma = (azimuth - 180) * RAD;
  const months = [];
  for (let m = 0; m < 12; m++) {
    const c = climate.months[m];
    const delta = declination(REP_DAY[m]);
    const cosWs = Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta)));
    const ws = Math.acos(cosWs);
    const a = 0.409 + 0.5016 * Math.sin(ws - 60 * RAD);
    const b = 0.6609 - 0.4767 * Math.sin(ws - 60 * RAD);
    const denom = Math.sin(ws) - ws * Math.cos(ws);

    // توزيع القيم اليومية على ساعات النهار (Collares-Pereira & Rabl)
    const samples = [];
    let sumG = 0, sumD = 0;
    for (let t = -12 + STEP_H / 2; t < 12; t += STEP_H) {
      const w = t * 15 * RAD;
      if (Math.abs(w) >= ws) continue;
      const rd = (Math.PI / 24) * (Math.cos(w) - Math.cos(ws)) / denom;
      const rg = (a + b * Math.cos(w)) * rd;
      samples.push({ t, w, rg, rd });
      sumG += rg; sumD += rd;
    }

    let poaDay = 0, dcDay = 0;
    for (const s of samples) {
      const gh = c.ghi * (s.rg / sumG) * (1 / STEP_H);          // kW/m²
      const dh = Math.min(gh, c.dhi * (s.rd / sumD) * (1 / STEP_H));
      const bh = Math.max(0, gh - dh);
      const cosZ = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(s.w);
      const cosI =
        Math.sin(delta) * Math.sin(phi) * Math.cos(beta)
        - Math.sin(delta) * Math.cos(phi) * Math.sin(beta) * Math.cos(gamma)
        + Math.cos(delta) * Math.cos(phi) * Math.cos(beta) * Math.cos(s.w)
        + Math.cos(delta) * Math.sin(phi) * Math.sin(beta) * Math.cos(gamma) * Math.cos(s.w)
        + Math.cos(delta) * Math.sin(beta) * Math.sin(gamma) * Math.sin(s.w);
      const Rb = cosZ > 0.05 ? Math.max(0, cosI) / cosZ : 0;
      const beam = bh * Rb;
      const diff = dh * (1 + Math.cos(beta)) / 2;
      const ground = gh * albedo * (1 - Math.cos(beta)) / 2;
      const poa = beam + diff + ground;

      // خسائر زاوية السقوط (ASHRAE) للإشعاع المباشر، وقيمة ثابتة للمنتشر
      const iam = cosI > 0.05 ? Math.max(0, 1 - 0.05 * (1 / cosI - 1)) : 0;
      const effective = beam * iam + (diff + ground) * 0.95;

      // حرارة الخلية (Faiman) مع منحنى يومي لدرجة الحرارة
      const tAir = c.t2m + ((c.tmax - c.tmin) / 2) * Math.cos(((s.t + 12 - 15) / 24) * 2 * Math.PI);
      const tCell = tAir + (poa * 1000) / (u0 + u1 * c.ws);
      const dc = effective * (1 + (gammaPct / 100) * (tCell - 25));

      poaDay += poa * STEP_H;
      dcDay += Math.max(0, dc) * STEP_H;
    }
    const specific = dcDay * (1 - lossFraction) * inverterEff * DAYS[m]; // kWh/kWp في الشهر
    months.push({
      month: m + 1,
      poa: poaDay * DAYS[m],
      kWh: specific * kWp,
      specific,
    });
  }
  const annualKWh = months.reduce((s, x) => s + x.kWh, 0);
  const annualPoa = months.reduce((s, x) => s + x.poa, 0);
  const specificYield = months.reduce((s, x) => s + x.specific, 0);
  return {
    months, annualKWh, annualPoa, specificYield,
    performanceRatio: annualPoa ? specificYield / annualPoa : 0,
    capacityFactor: specificYield / 8760,
  };
}

// مسافة الظل بين الصفوف: ظل الساعة 9 صباحًا في الانقلاب الشتوي (نهج شائع في التصميم الأولي)
export function rowGapFactor(lat) {
  const phi = lat * RAD, d = -23.45 * RAD, w = -45 * RAD;
  const sinA = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(w);
  const alt = Math.asin(sinA);
  const sinAz = (Math.cos(d) * Math.sin(w)) / Math.cos(alt);
  return Math.sqrt(1 - sinAz * sinAz) / Math.tan(alt);
}
