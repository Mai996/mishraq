import { PILOT } from '../store.js';

const SERVICES = [
  ['الاستكشاف واختيار المنطقة', 'ابحث عن موقع في عُمان أو ارسم حدود منطقة الدراسة مباشرة على الخريطة.'],
  ['المباني ومساحات الأسطح', 'بصمات OpenStreetMap، وكشف السطح بنقرة من صور الأقمار الصناعية، ورسم يدوي وتصحيح للحدود.'],
  ['تقدير عدد الألواح', 'محرك هندسي يوزع الألواح فعليًا على السطح بعد خصم الارتدادات والعوائق ومسافات الظل.'],
  ['تقدير إنتاج الكهرباء', 'محاكاة شهرية تعتمد على الإشعاع الشمسي والحرارة والرياح من NASA POWER لكل موقع.'],
  ['التحليل المكاني', 'تجميع النتائج على مستوى المبنى والحي والولاية والمحافظة، مع خرائط موضوعية وقوائم أولوية.'],
  ['التقارير ولوحات المعلومات', 'مؤشرات ورسوم بيانية، وتصدير GeoJSON وCSV، وتقارير جاهزة للطباعة، ومؤشرات التحقق.'],
];

const STEPS = ['تحديد المنطقة', 'جمع البيانات', 'تحديد الأسطح', 'حساب المساحات', 'توزيع الألواح', 'القدرة المركبة', 'إنتاج الكهرباء', 'التجميع المكاني', 'عرض المخرجات', 'التحقق والتحسين'];

export function renderLanding(root) {
  root.innerHTML = `
    <section class="hero">
      <div class="hero-map" id="heroMap" aria-hidden="true"></div>
      <div class="hero-veil"></div>
      <div class="hero-copy">
        <p class="eyebrow">Mapping &amp; AI for Distributed Assets</p>
        <h1>نكتشف طاقة المكان<br>قبل أن تُشرق.</h1>
        <p class="lead">منصة مِشراق تحوّل أسطح المباني في سلطنة عُمان إلى أرقام قابلة للتخطيط: كم لوحًا يتسع السطح، وكم كيلوواط ذروة يمكن تركيبها، وكم كيلوواط ساعة يمكن إنتاجها.</p>
        <div class="hero-actions">
          <a class="btn btn-sun btn-lg" href="#/studio">افتح الخريطة وابدأ التحليل</a>
          <a class="btn btn-ghost-light btn-lg" href="#/method">كيف نحسب النتائج؟</a>
        </div>
        <p class="hero-note">في الخلفية: صورة قمر صناعي حقيقية لقرية ${PILOT.neighborhood} في ولاية ضنك، موقع النموذج التجريبي.</p>
      </div>
    </section>

    <section class="band">
      <div class="wrap">
        <h2>ست خدمات في مسار واحد</h2>
        <div class="services">
          ${SERVICES.map(([t, d], i) => `<article class="service"><span class="service-n">${i + 1}</span><h3>${t}</h3><p>${d}</p></article>`).join('')}
        </div>
      </div>
    </section>

    <section class="band band-tint">
      <div class="wrap">
        <h2>من الخريطة إلى التقرير في عشر مراحل</h2>
        <ol class="flow">${STEPS.map((s) => `<li>${s}</li>`).join('')}</ol>
      </div>
    </section>

    <section class="band">
      <div class="wrap split">
        <div>
          <h2>أرقام تعرف حدودها</h2>
          <p>كل نتيجة في مِشراق تأتي مع مصدر بياناتها ومستوى الثقة فيها والافتراضات التي بُنيت عليها. والمباني التي تحتاج إلى بيانات إضافية أو زيارة ميدانية تظهر في قائمة مستقلة، بدلًا من إخفائها داخل المجموع.</p>
          <a class="link" href="#/method">اقرأ المنهجية وحدود الدقة ←</a>
        </div>
        <ul class="checks">
          <li>لا توجد نسب دقة مفترضة؛ تُحسب مؤشرات الدقة من بيانات مرجعية تدخلها.</li>
          <li>التقديرات أولية ولا تغني عن الدراسة الهندسية والإنشائية للموقع.</li>
          <li>يُحفظ المشروع في متصفحك، أو في حسابك عند تسجيل الدخول، ويمكنك تصديره في أي وقت.</li>
        </ul>
      </div>
    </section>

    <footer class="footer">
      <div class="wrap footer-row">
        <span>مِشراق / MISHRAQ · نموذج تجريبي</span>
        <span>الخرائط: © OpenStreetMap · الصور: Esri · المناخ: NASA POWER</span>
      </div>
    </footer>`;

  const map = L.map('heroMap', {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false,
  }).setView([23.9332, 56.2012], 17);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
  return () => map.remove();
}
