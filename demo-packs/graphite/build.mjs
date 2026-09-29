/**
 * Regenerates this pack: `node demo-packs/graphite/build.mjs`.
 * Writes `pack.json` and `images/*.jpg` (line-drawn elevations in the Graphite palette —
 * placeholders that read as architecture, not stock photos). Commit the output; the CMS
 * only ever reads the generated files.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'images'), { recursive: true })

const P = (slug, category, tf, te, year, locF, locE, area, tf1, te1, tf2, te2) => ({
  slug, category, image: `${slug}.jpg`, title: { fa: tf, en: te },
  facts: {
    fa: [['مکان', locF], ['سال', year], ['مساحت', `${area} متر مربع`], ['وضعیت', 'اجراشده']],
    en: [['Location', locE], ['Year', year], ['Area', `${area} m²`], ['Status', 'Completed']],
  },
  text: { fa: tf1, en: te1 }, more: { fa: tf2, en: te2 },
})
const E = (slug, tf, te, dur, lvl, tf1, te1, tf2, te2) => ({
  slug, category: 'education', image: `${slug}.jpg`, title: { fa: tf, en: te },
  facts: {
    fa: [['مدت', dur[0]], ['سطح', lvl[0]], ['شهریه', 'رایگان']],
    en: [['Duration', dur[1]], ['Level', lvl[1]], ['Fee', 'Free']],
  },
  text: { fa: tf1, en: te1 }, more: { fa: tf2, en: te2 },
})

const posts = [
  P('sea-house', 'projects', 'خانه ساحلی', 'Sea House', '1402', 'نوشهر', 'Nowshahr', '320',
    'ویلایی رو به دریا با حیاط‌های میانی و بازشوهای بزرگ برای نور و نسیم.', 'A seaside villa with inner courts and large openings for light and breeze.',
    'مصالح بومی و بتن نمایان، هماهنگ با اقلیم شمال، ساختار ساده و ماندگار را می‌سازند.', 'Local materials and exposed concrete suit the northern climate and keep the structure simple and lasting.'),
  P('courtyard-office', 'projects', 'دفتر حیاط‌دار', 'Courtyard Office', '1401', 'تهران', 'Tehran', '860',
    'ساختمان اداری با حیاط مرکزی که همهٔ طبقات را به هم پیوند می‌دهد.', 'An office building whose central courtyard ties every floor together.',
    'نور طبیعی تا عمق پلان می‌رسد و فضاهای جمعی در اطراف حیاط شکل می‌گیرند.', 'Daylight reaches deep into the plan and shared spaces gather around the court.'),
  P('brick-library', 'projects', 'کتابخانهٔ آجری', 'Brick Library', '1400', 'اصفهان', 'Isfahan', '1450',
    'کتابخانهٔ محله با پوستهٔ آجری و سالن‌های مطالعهٔ نیمه‌باز.', 'A neighbourhood library with a brick skin and semi-open reading halls.',
    'الگوی آجرچینی نور را فیلتر می‌کند و شب‌ها ساختمان مثل فانوس می‌درخشد.', 'The brick pattern filters light, and at night the building glows like a lantern.'),
  P('hillside-cabin', 'projects', 'کلبهٔ دامنه', 'Hillside Cabin', '1402', 'الموت', 'Alamut', '96',
    'کلبه‌ای کوچک روی شیب با چوب و سنگ محلی.', 'A small cabin on a slope, built from local timber and stone.',
    'پلان فشرده و ایوان رو به دره، حداقل دخالت در زمین را ممکن کرده است.', 'A compact plan and a porch facing the valley keep the intervention in the land minimal.'),
  P('market-renewal', 'projects', 'بازآفرینی بازار', 'Market Renewal', '1399', 'تبریز', 'Tabriz', '2100',
    'مرمت و بازطراحی یک راستهٔ بازار با حفظ ساختار تاریخی.', 'Restoration and redesign of a bazaar row that keeps its historic structure.',
    'سقف‌های تاقی بازسازی شد و روشنایی و تأسیسات بدون آسیب به بنا اضافه شد.', 'The vaulted roofs were restored and lighting and services added without harming the fabric.'),
  P('school-pavilion', 'projects', 'آلاچیق مدرسه', 'School Pavilion', '1401', 'شیراز', 'Shiraz', '210',
    'فضای باز آموزشی با سازهٔ چوبی سبک برای حیاط مدرسه.', 'An open learning space with a light timber frame for a school yard.',
    'ساخت مرحله‌ای و قطعات پیش‌ساخته زمان اجرا را در تعطیلات تابستان جا داد.', 'Phased building with prefabricated parts fit the works into the summer break.'),
  E('sketching-basics', 'مبانی طراحی دستی', 'Sketching Basics', ['۸ ساعت', '8 hours'], ['مقدماتی', 'Beginner'],
    'کارگاه یک‌روزه برای یادگیری خط، سایه و پرسپکتیو در طراحی معماری.', 'A one-day workshop on line, shade and perspective for architectural sketching.',
    'ظرفیت محدود است و وسایل در محل تأمین می‌شود.', 'Places are limited and materials are provided on site.'),
  E('portfolio-review', 'بازبینی نمونه‌کار', 'Portfolio Review', ['۴ ساعت', '4 hours'], ['متوسط', 'Intermediate'],
    'جلسهٔ گروهی برای نقد و بهبود نمونه‌کار دانشجویان و فارغ‌التحصیلان.', 'A group session to critique and improve student and graduate portfolios.',
    'هر شرکت‌کننده حداکثر ده صفحه ارائه می‌کند.', 'Each participant presents up to ten pages.'),
  E('site-visit-day', 'روز بازدید کارگاه', 'Site Visit Day', ['۳ ساعت', '3 hours'], ['همه', 'All'],
    'بازدید از یک پروژهٔ در حال ساخت و گفت‌وگو با مجری و مهندس ناظر.', 'A visit to a building site with the contractor and site engineer.',
    'کلاه ایمنی و کفش مناسب همراه داشته باشید.', 'Bring a hard hat and sturdy shoes.'),
]

const pack = {
  key: 'graphite',
  siteType: 'portfolio',
  name: { fa: 'گرافیت — دفتر معماری', en: 'Graphite — architecture office' },
  description: {
    fa: 'دو دستهٔ «پروژه‌ها» و «آموزش» با ۶ پروژه و ۳ رویداد آموزشی، فارسی و انگلیسی، همراه با تصویر.',
    en: 'Projects and Education categories with 6 projects and 3 workshops, in Persian and English, with images.',
  },
  categories: [
    { slug: 'projects', title: { fa: 'پروژه‌ها', en: 'Projects' } },
    { slug: 'education', title: { fa: 'آموزش', en: 'Education' } },
  ],
  posts,
}
writeFileSync(join(here, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`)

// --- images: one deterministic line drawing per post --------------------------------

const rand = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const W = 1600
const H = 1000

const drawing = (slug, index) => {
  const r = rand(index * 7919 + 13)
  const ground = 760
  const parts = []
  const n = 3 + Math.floor(r() * 3)
  let x = 180
  for (let i = 0; i < n; i++) {
    const w = 170 + Math.floor(r() * 200)
    const h = 180 + Math.floor(r() * 360)
    const y = ground - h
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${i % 2 ? '#ece6d8' : '#f7f3ea'}" stroke="#111" stroke-width="3"/>`)
    const cols = 2 + Math.floor(r() * 3)
    const rows = 2 + Math.floor(r() * 4)
    for (let c = 0; c < cols; c++)
      for (let k = 0; k < rows; k++) {
        const wx = x + 22 + c * ((w - 44) / cols)
        const wy = y + 26 + k * ((h - 60) / rows)
        parts.push(`<rect x="${wx}" y="${wy}" width="${(w - 44) / cols - 14}" height="${(h - 60) / rows - 16}" fill="none" stroke="#111" stroke-width="1.5"/>`)
      }
    if (r() > 0.5) parts.push(`<rect x="${x}" y="${y - 16}" width="${w + 26}" height="16" fill="#8c6f4a"/>`)
    x += w + 10 + Math.floor(r() * 30)
  }
  const sunX = 1150 + Math.floor(r() * 300)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#efe9dc"/>
<circle cx="${sunX}" cy="240" r="90" fill="#8c6f4a" opacity="0.85"/>
${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${100 + i * 60}" x2="${W}" y2="${100 + i * 60}" stroke="#111" stroke-opacity="0.05"/>`).join('')}
${parts.join('\n')}
<line x1="80" y1="${ground}" x2="${W - 80}" y2="${ground}" stroke="#111" stroke-width="4"/>
<line x1="80" y1="${ground + 24}" x2="${W - 80}" y2="${ground + 24}" stroke="#111" stroke-width="1"/>
<text x="80" y="${H - 90}" font-family="sans-serif" font-size="26" fill="#111" opacity="0.5" letter-spacing="6">${slug.toUpperCase().replaceAll('-', ' ')}</text>
</svg>`
}

for (const [i, p] of posts.entries()) {
  await sharp(Buffer.from(drawing(p.slug, i))).jpeg({ quality: 82, mozjpeg: true }).toFile(join(here, 'images', p.image))
}
console.log(`graphite: ${posts.length} posts, ${posts.length} images`)
