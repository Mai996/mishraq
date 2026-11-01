import { state } from '../store.js';
import { totalLossFraction, simulate } from '../engine/solar.js';
import { fetchClimate } from '../services.js';
import { fmt } from '../ui.js';

// قياس مرجعي ثابت نُفذ مقابل PVGIS 5.3 (SARAH3) بخسائر 14% وميل 24° جنوبًا عند البريمي 24.25، 55.79
export const BENCHMARK = { pvgis: 1752.09, lat: 24.25, lon: 55.79, tilt: 24, loss: 0.14 };

const SOURCES = [
  ['NASA POWER', 'الإشعاع والحرارة والرياح (متوسطات شهرية)', 'مستخدم', 'https://power.larc.nasa.gov/'],
  ['OpenStreetMap', 'بصمات المباني والبحث الجغرافي', 'مستخدم', 'https://www.openstreetmap.org/copyright'],
  ['Esri World Imagery', 'صور الأقمار الصناعية وخلفية الخريطة', 'مستخدم؛ تلزم مراجعة شروط الاستخدام قبل الإطلاق', 'https://www.esri.com/en-us/legal/terms/full-master-agreement'],
  ['PVGIS', 'مرجع مستقل لاختبار نموذج الإنتاج', 'استُخدم للمقارنة', 'https://re.jrc.ec.europa.eu/pvg_tools/en/'],
  ['Google Solar API', 'بيانات أسطح تفصيلية', 'لم يُدمج؛ يلزم مفتاح وفحص التغطية في عُمان', 'https://developers.google.com/maps/documentation/solar'],
  ['NREL PVWatts', 'نموذج إنتاج بديل', 'لم يُدمج؛ يلزم مفتاح وفحص ملاءمة البيانات', 'https://developer.nlr.gov/docs/solar/pvwatts/'],
];

const PHASES = [
  ['التخطيط والجدوى الفنية', 'مكتمل جزئيًا', 'مراجعة المصادر تمت. يبقى اعتماد المتطلبات وشروط الاستخدام.'],
  ['النموذج الأولي', 'منجز', 'الواجهة والخريطة والبحث واختيار المباني ولوحة المعلومات.'],
  ['محرك التحليل', 'منجز كنسخة أولى', 'المساحات، توزيع الألواح، الإنتاج، وقواعد الثقة.'],
  ['الاختبار والتحقق', 'لم يبدأ ميدانيًا', 'يلزم قياسات مرجعية من الموقع التجريبي.'],
  ['التقييم والتوسع', 'لم يبدأ', 'يعتمد على نتائج الاختبار، ويشمل نموذج ذكاء اصطناعي مدرَّبًا وتوسيع قاعدة البيانات المكانية.'],
];

export function renderMethod(root) {
  const s = state.settings;
  root.innerHTML = `
    <div class="page prose">
      <h1>المنهجية وحدود الدقة</h1>
      <p class="lead-dark">كل رقم في مِشراق يمكن تتبعه إلى بياناته ومعادلاته. هذه الصفحة تشرح كيف تُحسب النتائج، وما لا تشمله.</p>

      <h2>1. المساحات</h2>
      <p>تُحسب مساحة البصمة جيوديسيًا من المضلع. في السطح المستوي تساوي مساحة السطح البصمة، وفي المائل: مساحة السطح = البصمة ÷ جتا(الميل). المساحة القابلة للاستخدام هي البصمة بعد خصم ارتداد الحواف (${s.setback} م حاليًا) والعوائق المرسومة مع خلوصها (${s.obstacleClearance} م).</p>

      <h2>2. كشف السطح بنقرة</h2>
      <p>تعتمد النسخة الحالية على رؤية حاسوبية تقليدية: نمو منطقة لوني في فضاء CIELAB حول نقطة النقر، ثم عمليات مورفولوجية وتتبع وتبسيط للحدود. وهي <strong>ليست نموذج تعلم عميق مدرَّبًا بعد</strong>. نتيجتها تقدير يحتاج إلى مراجعة، ويقل أداؤها إذا تشابه لون السطح مع الأرض، وهذا شائع في البيئات الصحراوية.</p>

      <h2>3. توزيع الألواح</h2>
      <p>يُختبر كل موضع للوح هندسيًا داخل المساحة القابلة للاستخدام، مع البحث في إزاحات متعددة للشبكة واختيار الأعلى عددًا. في الأسطح المستوية، تُحسب مسافة الصفوف لتجنب الظل الذاتي عند الساعة 9 صباحًا بالتوقيت الشمسي في الانقلاب الشتوي، بحسب خط عرض المبنى.</p>
      <p class="formula">القدرة (kWp) = عدد الألواح × قدرة اللوح (واط) ÷ 1000</p>

      <h2>4. إنتاج الكهرباء</h2>
      <p>لكل شهر يُحاكى يوم ممثل بخطوة ربع ساعة:</p>
      <ul>
        <li>توزيع الإشعاع اليومي على الساعات (Collares-Pereira &amp; Rabl).</li>
        <li>الإشعاع على مستوى اللوح: مباشر، ومنتشر متساوي الخواص، ومنعكس من الأرض (albedo ${s.albedo}).</li>
        <li>خسائر زاوية السقوط (ASHRAE)، وحرارة الخلية (Faiman) مع منحنى يومي للحرارة.</li>
        <li>الخسائر الكلية ${fmt(totalLossFraction(s.losses) * 100, 1)}%، وكفاءة العاكس ${s.inverterEff}%.</li>
      </ul>

      <h2>5. اختبار النموذج مقابل مرجع مستقل</h2>
      <div id="bench">${benchHtml(null)}</div>

      <h2>6. مستويات الثقة</h2>
      <table class="data"><thead><tr><th>المستوى</th><th>متى يُمنح</th></tr></thead><tbody>
        <tr><th>مرتفعة</th><td>حدود مرسومة أو مطابَقة يدويًا، والعوائق مراجَعة.</td></tr>
        <tr><th>متوسطة</th><td>أحد الجانبين فقط مراجَع: الحدود أو العوائق؛ أو كلاهما مراجَع من الصور دون تحقق ميداني.</td></tr>
        <tr><th>منخفضة</th><td>مصدر آلي بلا مراجعة، أو لا يتسع السطح لألواح.</td></tr>
      </tbody></table>
      <p class="muted">الثقة هنا وصف لاكتمال المراجعة وليست نسبة دقة مقيسة. الدقة تُقاس بالمؤشرات في لوحة المعلومات عند توفر بيانات مرجعية.</p>

      <h2>7. ما لا يشمله الحساب</h2>
      <ul>
        <li>ظل المباني والأشجار المجاورة، والتضاريس المحلية.</li>
        <li>القدرة الإنشائية للسطح، وقيود الربط بالشبكة، والاشتراطات التنظيمية.</li>
        <li>التكلفة والعائد وخفض الانبعاثات؛ وهي مرحلة لاحقة تحتاج إلى بيانات الأسعار والتعرفة وعوامل الانبعاث.</li>
        <li>التغير السنوي في الطقس؛ فالمدخلات متوسطات لعدة سنوات.</li>
      </ul>

      <h2>8. مصادر البيانات</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>المصدر</th><th>الاستخدام</th><th>الحالة</th></tr></thead><tbody>
        ${SOURCES.map(([n, u, st, url]) => `<tr><th><a href="${url}" target="_blank" rel="noopener">${n}</a></th><td>${u}</td><td>${st}</td></tr>`).join('')}
      </tbody></table></div>

      <h2>9. موقع النسخة الحالية من خطة التنفيذ</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>المرحلة</th><th>الحالة</th><th>ملاحظات</th></tr></thead><tbody>
        ${PHASES.map(([n, st, d]) => `<tr><th>${n}</th><td>${st}</td><td>${d}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;

  fetchClimate(BENCHMARK.lat, BENCHMARK.lon).then((c) => {
    const host = root.querySelector('#bench');
    if (host) host.innerHTML = benchHtml(c);
  }).catch(() => {
    const host = root.querySelector('#bench');
    if (host) host.innerHTML = benchHtml(null, true);
  });
}

function benchHtml(climate, failed = false) {
  const intro = `<p>النموذج يُختبر عند موقع قياسي في البريمي (${BENCHMARK.lat}، ${BENCHMARK.lon}) بميل ${BENCHMARK.tilt}° جنوبًا وخسائر 14%، مقابل <a href="https://re.jrc.ec.europa.eu/pvg_tools/en/" target="_blank" rel="noopener">PVGIS 5.3</a> الذي أعطى ${fmt(BENCHMARK.pvgis)} kWh/kWp سنويًا.</p>`;
  if (!climate) return `${intro}<p class="muted">${failed ? 'تعذر جلب المناخ لحساب المقارنة الآن.' : 'جارٍ حساب نتيجة النموذج…'}</p>`;
  const sim = simulate(climate, { lat: BENCHMARK.lat, tilt: BENCHMARK.tilt, azimuth: 180, kWp: 1, lossFraction: BENCHMARK.loss, inverterEff: 1, gammaPct: -0.35, albedo: 0.25, u0: 25, u1: 6.84 });
  const diff = (sim.specificYield - BENCHMARK.pvgis) / BENCHMARK.pvgis * 100;
  return `${intro}<p>نتيجة نموذج مِشراق بالإعدادات نفسها: <strong>${fmt(sim.specificYield)} kWh/kWp</strong>، بفارق <strong>${fmt(diff, 1)}%</strong>. هذا تحقق من اتساق النموذج مع نموذج مرجعي، وليس قياسًا ميدانيًا.</p>`;
}
