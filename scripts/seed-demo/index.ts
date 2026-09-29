/**
 * Demo content: `pnpm seed:demo`.
 *
 * Fills the three dev sites (`studio.localhost` portfolio, `acme.localhost`
 * business, `shop.localhost` store) with Persian pages, posts, products and
 * generated artwork, so every page a theme or the built-in renderer draws has a
 * title, copy and an image.
 *
 * Idempotent: media is keyed by filename, categories/posts/products/pages by
 * slug, so a second run updates what the first one wrote instead of duplicating it.
 *
 * ponytail: `studio` and `shop` are Persian only; `acme` also serves `en`, so its pages are
 * written in both (see `withIds` for why the second pass copies row ids).
 */
import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import type { Media, Page, Post } from '@/payload-types'
import { richText } from '@/provisioning/richText'
import { slugify } from '@/lib/slug'

import { renderArt, renderMark, type ArtKind, type PaletteName } from './art'

const ctx = { disableRevalidate: true }
const base = { context: ctx, depth: 0, locale: 'fa' as const, overrideAccess: true }

type Ctx = { payload: Payload; siteId: string; domain: string; palette: PaletteName }

const rt = (...blocks: [text: string, tag?: string][]) =>
  richText(blocks.map(([text, tag]) => (tag ? { tag, text, type: 'heading' as const } : { text, type: 'paragraph' as const })))

/* ------------------------------------------------------------------ media */

const media = async (
  c: Ctx,
  key: string,
  kind: ArtKind | 'mark',
  alt: string,
  opts: { palette?: PaletteName; width?: number } = {},
): Promise<string> => {
  const mark = kind === 'mark'
  const filename = `demo-${c.domain.split('.')[0]}-${key}.${mark ? 'png' : 'jpg'}`
  const found = await c.payload.find({
    ...base,
    collection: 'media',
    limit: 1,
    where: { and: [{ filename: { equals: filename } }, { site: { equals: c.siteId } }] },
  })
  if (found.docs[0]) return String(found.docs[0].id)

  const seed = `${c.domain}/${key}`
  const data = mark
    ? await renderMark(seed, opts.palette ?? c.palette)
    : await renderArt(kind, seed, opts.palette ?? c.palette, { width: opts.width })
  const doc = await c.payload.create({
    ...base,
    collection: 'media',
    data: { alt, site: c.siteId } as Partial<Media>,
    file: { data, mimetype: mark ? 'image/png' : 'image/jpeg', name: filename, size: data.length },
  })
  return String(doc.id)
}

/* ------------------------------------------------------------- upserts */

const upsertBySlug = async <T extends 'categories' | 'pages' | 'posts' | 'products'>(
  c: Ctx,
  collection: T,
  slug: string,
  data: Record<string, unknown>,
): Promise<string> => {
  const found = await c.payload.find({
    ...base,
    collection,
    limit: 1,
    where: { and: [{ slug: { equals: slug } }, { site: { equals: c.siteId } }] },
  })
  const payload = { ...data, site: c.siteId, slug }
  const doc = found.docs[0]
    ? await c.payload.update({ ...base, collection, data: payload as never, id: found.docs[0].id })
    : await c.payload.create({ ...base, collection, data: payload as never })
  return String(doc.id)
}

const category = (c: Ctx, slug: string, title: string, parent?: string) =>
  upsertBySlug(c, 'categories', slug, { generateSlug: false, parent, title })

const page = (
  c: Ctx,
  slug: string,
  title: string,
  hero: Page['hero'],
  layout: Page['layout'],
  description: string,
) =>
  upsertBySlug(c, 'pages', slug, {
    _status: 'published',
    generateSlug: false,
    hero,
    layout,
    meta: { description, title },
    publishedAt: new Date().toISOString(),
    title,
  })

const lowHero = (heading: string, sub?: string): Page['hero'] => ({
  richText: rt([heading, 'h1'], ...(sub ? ([[sub]] as [string][]) : [])),
  type: 'lowImpact',
})

const imageHero = (heading: string, sub: string, mediaId: string): Page['hero'] => ({
  media: mediaId,
  richText: rt([heading, 'h1'], [sub]),
  type: 'mediumImpact',
})

const link = (label: string, url: string) => ({
  link: { appearance: 'default' as const, label, type: 'custom' as const, url },
})

const pageRef = (label: string, id: string) => ({
  link: { label, reference: { relationTo: 'pages' as const, value: id }, type: 'reference' as const },
})

const customNav = (label: string, url: string) => ({ link: { label, type: 'custom' as const, url } })

const setNav = async (c: Ctx, collection: 'footer' | 'header', items: (ReturnType<typeof pageRef> | ReturnType<typeof customNav>)[]) => {
  const found = await c.payload.find({ ...base, collection, limit: 1, where: { site: { equals: c.siteId } } })
  const data = { navItems: items, site: c.siteId } as never
  if (found.docs[0]) await c.payload.update({ ...base, collection, data, id: found.docs[0].id })
  else await c.payload.create({ ...base, collection, data })
}

const branding = async (c: Ctx, displayName: string, tagline: string) => {
  const logo = await media(c, 'logo', 'mark', `نشان ${displayName}`)
  const found = await c.payload.find({ ...base, collection: 'site-branding', limit: 1, where: { site: { equals: c.siteId } } })
  const data = { compactLogo: logo, displayName, favicon: logo, primaryLogo: logo, site: c.siteId, tagline } as never
  if (found.docs[0]) await c.payload.update({ ...base, collection: 'site-branding', data, id: found.docs[0].id })
  else await c.payload.create({ ...base, collection: 'site-branding', data })
}

const formId = async (c: Ctx): Promise<string | undefined> => {
  const forms = await c.payload.find({ ...base, collection: 'forms', limit: 1, where: { site: { equals: c.siteId } } })
  return forms.docs[0] ? String(forms.docs[0].id) : undefined
}

const post = async (
  c: Ctx,
  slug: string,
  title: string,
  body: ReturnType<typeof rt>,
  extra: Partial<Post> & { heroImage: string; categories: string[] },
) =>
  upsertBySlug(c, 'posts', slug, {
    _status: 'published',
    content: body,
    generateSlug: false,
    meta: { description: title, image: extra.heroImage, title },
    title,
    ...extra,
  })

/* ------------------------------------------------------- studio (portfolio) */

const seedStudio = async (c: Ctx) => {
  const office = await media(c, 'office', 'interior', 'فضای کار استودیو نقش')
  const cover = await media(c, 'cover', 'facade', 'نمای شهری پروژه‌های استودیو نقش')

  // Roots are looked up by slug in either locale — the theme finds them by `projects` / `education`.
  const projects = await category(c, 'projects', 'پروژه‌ها')
  const education = await category(c, 'education', 'آموزش')
  const cats = {
    culture: await category(c, 'cultural', 'فرهنگی', projects),
    housing: await category(c, 'residential', 'مسکونی', projects),
    office: await category(c, 'commercial', 'تجاری', projects),
    notes: await category(c, 'technical-notes', 'یادداشت‌های فنی', education),
    workshop: await category(c, 'workshops', 'کارگاه‌ها', education),
  }

  const work: {
    slug: string
    title: string
    kind: ArtKind
    palette: PaletteName
    cat: string
    meta: NonNullable<Post['projectMetadata']>
    text: [string, string]
    at: string
  }[] = [
    {
      at: '2025-03-10',
      cat: cats.culture,
      kind: 'arch',
      meta: { area: '۲٬۴۰۰ متر مربع', client: 'شهرداری منطقه ۶', date: '2025-01-01', location: 'تهران، خیابان انقلاب', status: 'در حال ساخت' },
      palette: 'sand',
      slug: 'khaneh-honar',
      text: ['خانهٔ هنر ولیعصر', 'مرکز فرهنگی با هشت گنبد کوچک آجری که نور روز را به تالار نمایش می‌رسانند.'],
      title: 'خانهٔ هنر ولیعصر',
    },
    {
      at: '2025-01-22',
      cat: cats.housing,
      kind: 'facade',
      meta: { area: '۱٬۲۰۰ متر مربع', client: 'شرکت سرمایه‌گذاری آراد', date: '2024-01-01', location: 'شیراز، بلوار چمران', status: 'تحویل‌شده' },
      palette: 'clay',
      slug: 'baagh-manzel',
      text: ['مجتمع مسکونی باغ‌منزل', 'دوازده واحد مسکونی که میان درختان انار و نارنج باغ قدیمی جای گرفته‌اند.'],
      title: 'مجتمع مسکونی باغ‌منزل',
    },
    {
      at: '2024-11-05',
      cat: cats.office,
      kind: 'facade',
      meta: { area: '۳٬۸۰۰ متر مربع', client: 'گروه صنعتی نوین', date: '2024-01-01', location: 'اصفهان، شهرک علمی', status: 'تحویل‌شده' },
      palette: 'slate',
      slug: 'bourj-noor',
      text: ['برج اداری نور', 'یک ساختمان اداری با پوستهٔ دوجداره که مصرف انرژی را حدود سی درصد کاهش داد.'],
      title: 'برج اداری نور',
    },
    {
      at: '2024-08-14',
      cat: cats.housing,
      kind: 'interior',
      meta: { area: '۳۲۰ متر مربع', client: 'خانوادهٔ کیانی', date: '2023-01-01', location: 'کرج، مهرشهر', status: 'تحویل‌شده' },
      palette: 'olive',
      slug: 'villa-sabz',
      text: ['ویلای سبز', 'خانه‌ای دوطبقه با حیاط مرکزی که تهویهٔ طبیعی و سایهٔ تابستانی را تأمین می‌کند.'],
      title: 'ویلای سبز',
    },
    {
      at: '2024-05-30',
      cat: cats.culture,
      kind: 'plan',
      meta: { area: '۹۵۰ متر مربع', client: 'اداره کل میراث فرهنگی', date: '2023-01-01', location: 'یزد، محلهٔ فهادان', status: 'مرمت‌شده' },
      palette: 'sand',
      slug: 'ehya-kaarvansara',
      text: ['احیای کاروانسرای قدیمی', 'مرمت یک کاروانسرای قاجاری و تبدیل آن به اقامتگاه و کارگاه صنایع دستی.'],
      title: 'احیای کاروانسرای قدیمی',
    },
    {
      at: '2024-02-12',
      cat: cats.office,
      kind: 'arch',
      meta: { area: '۶۰۰ متر مربع', client: 'کافه کتاب پاتوق', date: '2022-01-01', location: 'تبریز، ولیعصر', status: 'تحویل‌شده' },
      palette: 'night',
      slug: 'cafe-patogh',
      text: ['کافه‌کتاب پاتوق', 'طراحی داخلی یک کافه‌کتاب با قفسه‌های چوبی بلند و نورگیرهای سقفی.'],
      title: 'کافه‌کتاب پاتوق',
    },
  ]

  for (const w of work) {
    const hero = await media(c, w.slug, w.kind, w.title, { palette: w.palette })
    await post(
      c,
      w.slug,
      w.title,
      rt(
        ['دربارهٔ پروژه', 'h2'],
        [w.text[1]],
        ['ایدهٔ طراحی', 'h2'],
        ['طراحی از خوانش دقیق بستر آغاز شد: اقلیم، مصالح در دسترس و شیوهٔ زندگی مردمی که از این فضا استفاده می‌کنند. هر تصمیم، از جهت‌گیری حجم‌ها تا انتخاب آجر و چوب، با همین سه پرسش سنجیده شد.'],
        ['ساخت و اجرا', 'h2'],
        ['اجرا با پیمانکاران محلی و مصالح بومی انجام شد تا هم هزینه‌ها مهار شود و هم ساختمان با محیط پیرامون خود هم‌زبان بماند.'],
      ),
      {
        categories: [w.cat],
        heroImage: hero,
        projectMetadata: w.meta,
        publishedAt: `${w.at}T09:00:00.000Z`,
      },
    )
  }

  const lessons: { slug: string; title: string; kind: ArtKind; cat: string; text: string; at: string }[] = [
    {
      at: '2025-02-01',
      cat: cats.workshop,
      kind: 'plan',
      slug: 'kargah-memari-paydar',
      text: 'در این کارگاه دو روزه، دانشجویان و مهندسان با اصول طراحی همساز با اقلیم و محاسبهٔ ساده‌شدهٔ مصرف انرژی آشنا می‌شوند.',
      title: 'کارگاه معماری پایدار در اقلیم گرم و خشک',
    },
    {
      at: '2024-12-09',
      cat: cats.notes,
      kind: 'arch',
      slug: 'mosaleh-bomi',
      text: 'آجر، خشت و گچ چه‌قدر به کار امروز می‌آیند؟ مروری بر مزیت‌ها و محدودیت‌های مصالح بومی ایران در ساختمان‌های معاصر.',
      title: 'مصالح بومی در معماری معاصر',
    },
    {
      at: '2024-09-18',
      cat: cats.notes,
      kind: 'plan',
      slug: 'khaandan-e-plan',
      text: 'راهنمای مرحله‌به‌مرحله برای خواندن پلان‌های معماری: مقیاس، خطوط ضخیم و نازک، علامت‌ها و قراردادهای رایج.',
      title: 'خواندن پلان معماری برای مبتدیان',
    },
  ]
  for (const l of lessons) {
    await post(
      c,
      l.slug,
      l.title,
      rt([l.title, 'h2'], [l.text], ['سرفصل‌ها', 'h3'], ['۱. مفاهیم پایه · ۲. نمونه‌های واقعی · ۳. تمرین عملی و پرسش‌وپاسخ.']),
      { categories: [l.cat], heroImage: await media(c, l.slug, l.kind, l.title), publishedAt: `${l.at}T09:00:00.000Z` },
    )
  }

  const team = await Promise.all(
    [
      ['سارا کریمی', 'معمار ارشد و مدیر استودیو', 'دو دهه تجربهٔ طراحی فضاهای فرهنگی و مسکونی؛ دانش‌آموختهٔ دانشگاه تهران.'],
      ['امیر حسینی', 'مدیر اجرا', 'مسئول هماهنگی اجرا و کنترل کیفیت در کارگاه‌های ساختمانی.'],
      ['نگار رستمی', 'طراح شهری', 'پژوهشگر بافت‌های تاریخی و طراح فضاهای عمومی.'],
      ['پویا محمدی', 'مهندس سازه', 'طراح سازه‌های آجری و فولادی با تمرکز بر ایمنی در برابر زلزله.'],
    ].map(async ([name, role, bio], i) => ({
      bio,
      name,
      photo: await media(c, `team-${i + 1}`, 'portrait', name, { palette: (['sand', 'slate', 'clay', 'olive'] as const)[i], width: 800 }),
      role,
    })),
  )

  const iconArt = ['arch', 'plan', 'interior'] as const
  const services = await Promise.all(
    [
      ['طراحی معماری', 'از ایده تا نقشه‌های اجرایی؛ با بررسی بستر، اقلیم و نیاز کارفرما.'],
      ['طراحی داخلی', 'چیدمان، مصالح و نورپردازی فضاهای مسکونی و تجاری.'],
      ['نظارت و اجرا', 'حضور در کارگاه، کنترل کیفیت و تحویل در زمان و بودجهٔ توافق‌شده.'],
    ].map(async ([title, description], i) => ({
      description,
      icon: await media(c, `service-${i + 1}`, iconArt[i], title, { width: 600 }),
      title,
    })),
  )

  const gallery = await Promise.all(
    work.slice(0, 4).map((w) => media(c, w.slug, w.kind, w.title, { palette: w.palette })),
  )

  const contactId = await page(
    c,
    'contact',
    'تماس با ما',
    lowHero('گفت‌وگو را شروع کنیم', 'برای مشاوره یا درخواست همکاری با ما در ارتباط باشید.'),
    [
      {
        address: 'تهران، خیابان ولیعصر، بالاتر از پارک ملت، کوچهٔ لاله، پلاک ۱۴، طبقهٔ سوم',
        blockType: 'contact',
        email: 'hello@studio-naghsh.ir',
        heading: 'دفتر مرکزی',
        hours: 'شنبه تا چهارشنبه، ۹ تا ۱۷',
        intro: 'برای بازدید از دفتر، لطفاً از پیش هماهنگ کنید.',
        latitude: 35.7912,
        longitude: 51.4098,
        phones: ['021-88776655', '0912-1234567'],
      },
      ...(((await formId(c)) ? [{ blockType: 'formBlock' as const, enableIntro: false, form: (await formId(c))! }] : []) as Page['layout']),
    ],
    'راه‌های ارتباط با استودیو نقش: نشانی، تلفن و فرم تماس.',
  )

  const homeId = await page(
    c,
    'home',
    'استودیو نقش',
    lowHero('استودیو نقش', 'معماری، طراحی داخلی و نظارت — با نگاهی به بستر و مصالح بومی.'),
    [
      { blockType: 'mediaBlock', media: cover },
      {
        blockType: 'content',
        columns: [
          {
            richText: rt(['درباره استودیو', 'h2'], ['استودیو نقش از سال ۱۳۸۴ با تمرکز بر معماری فرهنگی و مسکونی فعالیت می‌کند. ما باور داریم ساختمان خوب، ساختمانی است که با شهر و مردمش گفت‌وگو کند.']),
            size: 'twoThirds',
          },
        ],
      },
      { blockType: 'gallery', columns: '4', heading: 'چند پروژهٔ برگزیده', images: gallery, intro: 'نمونه‌ای از کارهای اخیر ما.' },
      {
        blockType: 'cta',
        links: [link('مشاهدهٔ پروژه‌ها', '/projects'), link('تماس با ما', '/contact')],
        richText: rt(['برای پروژهٔ بعدی‌تان آماده‌ایم', 'h3'], ['یک گفتگوی اولیه هیچ هزینه‌ای ندارد.']),
      },
    ],
    'استودیو نقش؛ دفتر معماری و طراحی داخلی در تهران.',
  )

  const aboutId = await page(
    c,
    'about',
    'درباره ما',
    lowHero('درباره استودیو نقش', 'داستان ما، ارزش‌ها و تیمی که پروژه‌ها را می‌سازد.'),
    [
      { blockType: 'mediaBlock', media: office },
      {
        blockType: 'content',
        columns: [
          { richText: rt(['ماجرای ما', 'h2'], ['استودیو نقش با یک اتاق کوچک و سه معمار جوان آغاز شد و امروز تیمی از بیست متخصص در معماری، سازه و طراحی شهری است.']), size: 'half' },
          { richText: rt(['ارزش‌های ما', 'h2'], ['صداقت در طراحی، احترام به بستر و پایبندی به زمان و هزینه؛ سه اصلی که هیچ‌گاه از آن‌ها کوتاه نیامده‌ایم.']), size: 'half' },
        ],
      },
      { blockType: 'team', columns: '4', heading: 'تیم ما', intro: 'متخصصانی که هر پروژه را از نقشه تا تحویل همراهی می‌کنند.', members: team },
    ],
    'آشنایی با تاریخچه، ارزش‌ها و تیم استودیو نقش.',
  )

  const servicesId = await page(
    c,
    'services',
    'خدمات ما',
    lowHero('از طرح تا تحویل', 'هر آنچه برای ساختن یک بنای خوب لازم است.'),
    [
      { blockType: 'features', columns: '3', heading: 'حوزه‌های فعالیت', intro: 'خدمات ما از نخستین طرح تا کلید تحویلی.', items: services },
      {
        blockType: 'faq',
        heading: 'پرسش‌های متداول',
        items: [
          { answer: 'بسته به مساحت و نوع پروژه بین چهار تا شانزده هفته؛ زمان‌بندی دقیق در جلسهٔ اول توافق می‌شود.', question: 'طراحی یک خانهٔ ویلایی چقدر زمان می‌برد؟' },
          { answer: 'بله، نظارت عالیه و در صورت نیاز نظارت مقیم را نیز ارائه می‌دهیم.', question: 'آیا نظارت بر اجرا هم انجام می‌دهید؟' },
          { answer: 'مشاورهٔ اولیه رایگان است و هزینهٔ طراحی پس از تعیین دامنهٔ کار اعلام می‌شود.', question: 'هزینهٔ مشاوره چگونه محاسبه می‌شود؟' },
        ],
      },
      { blockType: 'cta', links: [link('درخواست مشاوره', '/contact')], richText: rt(['هنوز سؤال دارید؟', 'h3'], ['با ما تماس بگیرید.']) },
    ],
    'خدمات معماری، طراحی داخلی و نظارت در استودیو نقش.',
  )

  await page(c, 'projects', 'پروژه‌ها', lowHero('ساختمان‌هایی که ساخته‌ایم', 'گزیده‌ای از کارهای دو دههٔ اخیر.'), [{ blockType: 'mediaBlock', media: cover }], 'فهرست پروژه‌های معماری استودیو نقش.')
  await page(c, 'education', 'آموزش', lowHero('یاد بگیریم، یاد بدهیم', 'کارگاه‌ها و یادداشت‌های فنی برای دانشجویان و همکاران.'), [{ blockType: 'mediaBlock', media: office }], 'کارگاه‌ها و مقالات آموزشی معماری.')

  const nav = [
    customNav('پروژه‌ها', '/projects'),
    customNav('آموزش', '/education'),
    pageRef('خدمات', servicesId),
    pageRef('درباره ما', aboutId),
    pageRef('تماس', contactId),
  ]
  await setNav(c, 'header', nav)
  await setNav(c, 'footer', nav)
  await branding(c, 'استودیو نقش', 'معماری با نگاه به بستر و مصالح بومی')
  return { aboutId, contactId, homeId, projects, education }
}

/* ------------------------------------------------------------- acme (business) */

type Lang = 'en' | 'fa'

/**
 * Copy the ids of `prev` (the default-locale document) onto `next`, row by row.
 *
 * `layout` and `navItems` are unlocalized arrays with localized text inside. A row
 * written in a second locale without its id is a *new* row, and the array is replaced —
 * which deletes the Persian text inside every row (CLAUDE.md, «Payload»). Pairing by
 * index is safe here because both locales are built by the same function.
 */
const withIds = <T,>(next: T, prev: unknown): T => {
  if (Array.isArray(next)) {
    return next.map((row, i) => withIds(row, Array.isArray(prev) ? prev[i] : undefined)) as T
  }
  if (next && typeof next === 'object') {
    const before = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(next)) out[key] = withIds(value, before[key])
    if (typeof before.id === 'string' && !('id' in out)) out.id = before.id
    return out as T
  }
  return next
}

/** Second-locale write of an existing page or nav document. */
const inLocale = async (
  c: Ctx,
  collection: 'footer' | 'header' | 'pages',
  id: string,
  locale: Lang,
  data: Record<string, unknown>,
) => {
  const fa = (await c.payload.findByID({ ...base, collection, id })) as unknown as Record<string, unknown>
  const merged = { ...data }
  for (const key of ['layout', 'navItems']) if (key in merged) merged[key] = withIds(merged[key], fa[key])
  await c.payload.update({ ...base, collection, data: merged as never, id, locale })
}

const seedAcme = async (c: Ctx) => {
  const heroImg = await media(c, 'hero', 'facade', 'ساختمان مرکزی شرکت آکمه')
  const officeImg = await media(c, 'office', 'interior', 'فضای کار شرکت آکمه')
  const planImg = await media(c, 'plan', 'plan', 'نقشهٔ دفتر آکمه')
  const contactForm = await formId(c)

  const staff = await Promise.all(
    [0, 1, 2].map(async (i) => ({
      photo: await media(c, `team-${i + 1}`, 'portrait', ['علی رضایی', 'مریم صادقی', 'حسین نوری'][i], {
        palette: (['slate', 'sand', 'olive'] as const)[i],
        width: 800,
      }),
    })),
  )
  const icons = await Promise.all(
    [0, 1, 2].map((i) =>
      media(c, `feat-${i + 1}`, (['arch', 'plan', 'interior'] as const)[i], ['پشتیبانی همیشگی', 'امنیت داده', 'استقرار سریع'][i], {
        width: 600,
      }),
    ),
  )
  const avatars = await Promise.all(
    [0, 1].map((i) =>
      media(c, `avatar-${i + 1}`, 'portrait', ['دکتر فرهاد امینی', 'نازنین یگانه'][i], {
        palette: (['clay', 'slate'] as const)[i],
        width: 400,
      }),
    ),
  )

  /** Every page, in one language. Both locales run this, so rows pair by index. */
  const content = (lang: Lang) => {
    const L = (fa: string, en: string) => (lang === 'fa' ? fa : en)
    const features = [
      { description: L('تیم پشتیبانی ما در تمام روزهای هفته پاسخگوی شماست.', 'Our support team answers every day of the week.'), icon: icons[0], title: L('پشتیبانی همیشگی', 'Always-on support') },
      { description: L('داده‌های شما رمزنگاری و روزانه پشتیبان‌گیری می‌شود.', 'Your data is encrypted and backed up daily.'), icon: icons[1], title: L('امنیت داده', 'Data security') },
      { description: L('راه‌اندازی کامل در کمتر از یک هفته.', 'Fully up and running in under a week.'), icon: icons[2], title: L('استقرار سریع', 'Fast rollout') },
    ]
    return {
      about: {
        description: L('آشنایی با تیم و ماموریت آکمه.', 'Meet the team and the mission behind Acme.'),
        hero: imageHero(L('درباره ما', 'About us'), L('تیمی که پشت محصول ایستاده است.', 'The people behind the product.'), officeImg),
        layout: [
          {
            blockType: 'content',
            columns: [
              {
                richText: rt(
                  [L('ماموریت ما', 'Our mission'), 'h2'],
                  [L('ساده‌کردن کار سازمان‌ها با ابزارهایی که واقعاً استفاده می‌شوند.', 'Making work simpler for organisations, with tools people actually use.')],
                ),
                size: 'full',
              },
            ],
          },
          {
            blockType: 'team',
            columns: '3',
            heading: L('تیم ما', 'Our team'),
            members: [
              { bio: L('سیزده سال تجربه در مدیریت پروژه‌های فناوری.', 'Thirteen years running technology projects.'), name: L('علی رضایی', 'Ali Rezaei'), photo: staff[0].photo, role: L('مدیرعامل', 'CEO') },
              { bio: L('مسئول معماری نرم‌افزار و کیفیت محصول.', 'Owns software architecture and product quality.'), name: L('مریم صادقی', 'Maryam Sadeghi'), photo: staff[1].photo, role: L('مدیر فنی', 'CTO') },
              { bio: L('همراه مشتریان در انتخاب راه‌حل مناسب.', 'Helps customers pick the right solution.'), name: L('حسین نوری', 'Hossein Nouri'), photo: staff[2].photo, role: L('مدیر فروش', 'Head of Sales') },
            ],
          },
        ],
        title: L('درباره ما', 'About us'),
      },
      contact: {
        description: L('نشانی و راه‌های تماس با آکمه.', 'Where to find Acme and how to reach us.'),
        hero: lowHero(L('گفت‌وگو را شروع کنیم', 'Let us talk')),
        layout: [
          {
            address: L('تهران، میدان ونک، خیابان ملاصدرا، پلاک ۵۰', '50 Mollasadra St., Vanak Sq., Tehran'),
            blockType: 'contact',
            email: 'info@acme.ir',
            heading: L('دفتر مرکزی', 'Head office'),
            hours: L('شنبه تا پنجشنبه، ۸ تا ۱۷', 'Saturday–Thursday, 8:00–17:00'),
            latitude: 35.7575,
            longitude: 51.4097,
            phones: ['021-55443322'],
          },
          ...(contactForm ? [{ blockType: 'formBlock' as const, enableIntro: false, form: contactForm }] : []),
        ],
        title: L('تماس با ما', 'Contact us'),
      },
      home: {
        description: L('آکمه؛ راه‌حل‌های سازمانی ساده و امن.', 'Acme — simple, secure software for organisations.'),
        hero: imageHero(L('آکمه', 'Acme'), L('راه‌حل‌های سازمانی که کار شما را ساده می‌کنند.', 'Business software that gets out of your way.'), heroImg),
        layout: [
          { blockType: 'features', columns: '3', heading: L('چرا آکمه؟', 'Why Acme?'), items: features },
          {
            blockType: 'testimonials',
            heading: L('مشتریان ما چه می‌گویند', 'What customers say'),
            items: [
              { author: L('دکتر فرهاد امینی', 'Dr. Farhad Amini'), avatar: avatars[0], quote: L('«پس از همکاری با آکمه، زمان گزارش‌گیری ما از سه روز به یک ساعت رسید.»', '“After moving to Acme our reporting went from three days to one hour.”'), role: L('مدیر عملیات، گروه پارس', 'Operations lead, Pars Group') },
              { author: L('نازنین یگانه', 'Nazanin Yeganeh'), avatar: avatars[1], quote: L('«پشتیبانی سریع و حرفه‌ای؛ دقیقاً همان چیزی که یک شرکت در حال رشد نیاز دارد.»', '“Fast, professional support — exactly what a growing company needs.”'), role: L('بنیان‌گذار، فروشگاه رایان', 'Founder, Rayan Store') },
            ],
          },
          { blockType: 'gallery', columns: '3', heading: L('نگاهی به دفتر ما', 'A look inside our office'), images: [officeImg, heroImg, planImg] },
          {
            blockType: 'cta',
            links: [link(L('درخواست نسخهٔ آزمایشی', 'Request a trial'), '/contact')],
            richText: rt([L('امروز شروع کنید', 'Start today'), 'h3'], [L('چهارده روز رایگان امتحان کنید.', 'Try it free for fourteen days.')]),
          },
        ],
        title: L('آکمه', 'Acme'),
      },
      services: {
        description: L('خدمات و تعرفه‌های آکمه.', 'Acme services and pricing.'),
        hero: lowHero(L('خدمات و تعرفه‌ها', 'Services and pricing')),
        layout: [
          { blockType: 'features', columns: '3', heading: L('خدمات', 'Services'), items: features },
          {
            blockType: 'faq',
            heading: L('پرسش‌های متداول', 'Frequently asked questions'),
            items: [
              { answer: L('بله، در هر زمان می‌توانید بسته را ارتقا دهید.', 'Yes — you can change plan at any time.'), question: L('آیا می‌توانم بستهٔ خود را تغییر دهم؟', 'Can I change my plan?') },
              { answer: L('داده‌ها در مراکز داده‌ای داخل کشور نگهداری می‌شوند.', 'Data is kept in data centres inside the country.'), question: L('داده‌های من کجا نگهداری می‌شود؟', 'Where is my data stored?') },
            ],
          },
        ],
        title: L('خدمات و تعرفه‌ها', 'Services and pricing'),
      },
    }
  }

  const slugs = ['about', 'contact', 'home', 'services'] as const
  const fa = content('fa')
  const ids: Record<string, string> = {}
  for (const slug of slugs) {
    const p = fa[slug]
    ids[slug] = await page(c, slug, p.title, p.hero, p.layout as Page['layout'], p.description)
  }

  // Second locale: same builders, English text, row ids paired with the Persian rows.
  const en = content('en')
  for (const slug of slugs) {
    const p = en[slug]
    await inLocale(c, 'pages', ids[slug], 'en', {
      hero: p.hero,
      layout: p.layout,
      meta: { description: p.description, title: p.title },
      slug,
      title: p.title,
    })
  }

  const nav = (lang: Lang) => {
    const L = (a: string, b: string) => (lang === 'fa' ? a : b)
    return [pageRef(L('خدمات', 'Services'), ids.services), pageRef(L('درباره ما', 'About'), ids.about), pageRef(L('تماس', 'Contact'), ids.contact)]
  }
  await setNav(c, 'header', nav('fa'))
  await setNav(c, 'footer', nav('fa'))
  for (const collection of ['header', 'footer'] as const) {
    const doc = (await c.payload.find({ ...base, collection, limit: 1, where: { site: { equals: c.siteId } } })).docs[0]
    if (doc) await inLocale(c, collection, String(doc.id), 'en', { navItems: nav('en') })
  }
  await branding(c, 'آکمه', 'راه‌حل‌های سازمانی ساده و امن')
  return { homeId: ids.home }
}

/* -------------------------------------------------------------- shop (store) */

const seedShop = async (c: Ctx) => {
  const hero = await media(c, 'hero', 'product', 'سوغات ایرانی فروشگاه پارسه')
  const items: { slug: string; title: string; summary: string; price: number; compare?: number; palette: PaletteName; stock?: number }[] = [
    { palette: 'clay', price: 480_000, slug: 'sohan-hel', summary: 'شیرینی خشک هل، در قوطی فلزی ۷۵۰ گرمی.', stock: 20, title: 'سوهان هل' },
    { compare: 260_000, palette: 'sand', price: 198_000, slug: 'zaferan-sargol', summary: 'زعفران سرگل، بستهٔ ۴ گرمی.', title: 'زعفران سرگل' },
    { palette: 'olive', price: 290_000, slug: 'golab-do-atish', summary: 'گلاب دوآتیشه، بطری ۵۰۰ سی‌سی.', stock: 35, title: 'گلاب دوآتیشه' },
    { palette: 'sand', price: 350_000, slug: 'asal-kohestan', summary: 'عسل طبیعی کوهستان، شیشهٔ ۹۰۰ گرمی.', stock: 18, title: 'عسل کوهستان' },
    { palette: 'slate', price: 220_000, slug: 'chai-golestan', summary: 'چای سیاه ممتاز گیلان، بستهٔ ۴۵۰ گرمی.', stock: 40, title: 'چای ممتاز گیلان' },
    { palette: 'clay', price: 420_000, slug: 'gaz-esfahan', summary: 'گز اصفهان با مغز پسته، جعبهٔ ۶۰۰ گرمی.', stock: 25, title: 'گز اصفهان' },
  ]
  const productIds: string[] = []
  for (const p of items) {
    const image = await media(c, p.slug, 'product', p.title, { palette: p.palette, width: 1000 })
    productIds.push(
      await upsertBySlug(c, 'products', p.slug, {
        _status: 'published',
        compareAtPrice: p.compare,
        generateSlug: false,
        image,
        price: p.price,
        summary: p.summary,
        title: p.title,
        ...(p.stock ? { inventory: p.stock, trackInventory: true } : { trackInventory: false }),
      }),
    )
  }
  const feats = await Promise.all(
    [
      ['ارسال به سراسر کشور', 'بسته‌بندی ایمن و ارسال تا ۴۸ ساعت پس از سفارش.'],
      ['ضمانت اصالت', 'همهٔ محصولات مستقیم از تولیدکننده تأمین می‌شوند.'],
      ['پرداخت امن', 'پرداخت آنلاین از درگاه‌های معتبر بانکی.'],
    ].map(async ([title, description], i) => ({
      description,
      icon: await media(c, `feat-${i + 1}`, 'product', title, { palette: (['sand', 'olive', 'slate'] as const)[i], width: 600 }),
      title,
    })),
  )
  const contactId = await page(c, 'contact', 'تماس با ما', lowHero('تماس با ما'), [
    { address: 'تهران، بازار بزرگ، راستهٔ زعفران‌فروش‌ها، پلاک ۲۱', blockType: 'contact', email: 'shop@parseh.ir', heading: 'فروشگاه حضوری', hours: 'هر روز، ۱۰ تا ۲۰', latitude: 35.6738, longitude: 51.4212, phones: ['021-33112233'] },
  ], 'نشانی و تماس فروشگاه پارسه.')
  await page(
    c,
    'home',
    'فروشگاه پارسه',
    imageHero('فروشگاه پارسه', 'بهترین سوغات و خوراکی‌های ایرانی، درِ خانهٔ شما.', hero),
    [
      { blockType: 'productGrid', columns: '3', heading: 'پرفروش‌ترین‌ها', limit: 6, populateBy: 'collection', showBuyButton: true },
      { blockType: 'features', columns: '3', heading: 'چرا پارسه؟', items: feats },
      { blockType: 'cta', links: [link('مشاهدهٔ همهٔ محصولات', '/products')], richText: rt(['ارسال رایگان برای خرید بالای ۵۰۰ هزار تومان', 'h3']) },
    ],
    'فروشگاه اینترنتی پارسه؛ سوغات و خوراکی‌های ایرانی.',
  )
  await page(c, 'products', 'محصولات', lowHero('محصولات'), [
    { blockType: 'productGrid', columns: '3', heading: 'همهٔ محصولات', limit: 24, populateBy: 'collection', showBuyButton: true },
  ], 'فهرست محصولات فروشگاه پارسه.')
  const aboutId = await page(c, 'about', 'درباره ما', imageHero('درباره ما', 'از سال ۱۳۷۲ در خدمت مشتریان.', await media(c, 'about', 'interior', 'داخل فروشگاه پارسه')), [
    { blockType: 'content', columns: [{ richText: rt(['داستان پارسه', 'h2'], ['فروشگاه پارسه با یک دکهٔ کوچک در بازار تهران شروع شد و امروز به‌صورت آنلاین به سراسر کشور ارسال می‌کند.']), size: 'full' }] },
  ], 'داستان فروشگاه پارسه.')
  const nav = [customNav('محصولات', '/products'), pageRef('درباره ما', aboutId), pageRef('تماس', contactId)]
  await setNav(c, 'header', nav)
  await setNav(c, 'footer', nav)
  await branding(c, 'فروشگاه پارسه', 'سوغات و خوراکی‌های اصیل ایرانی')
}

/* ---------------------------------------------------------------- main */

const payload = await getPayload({ config })

const bySite = async (domain: string, palette: PaletteName): Promise<Ctx> => {
  const found = await payload.find({ ...base, collection: 'sites', limit: 1, where: { domain: { equals: domain } } })
  if (!found.docs[0]) throw new Error(`No site for ${domain} — run \`pnpm seed\` or provision it first`)
  return { domain, palette, payload, siteId: String(found.docs[0].id) }
}

for (const [domain, palette, run] of [
  ['studio.localhost', 'sand', seedStudio],
  ['acme.localhost', 'slate', seedAcme],
  ['shop.localhost', 'clay', seedShop],
] as const) {
  try {
    await run(await bySite(domain, palette))
    payload.logger.info(`demo content ready: ${domain}`)
  } catch (error) {
    payload.logger.error({ err: error, msg: `demo seed failed for ${domain}` })
    process.exitCode = 1
  }
}

process.exit(process.exitCode ?? 0)
