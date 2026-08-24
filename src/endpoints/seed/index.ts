import type { CollectionSlug, Payload, PayloadRequest } from 'payload'

import type { Page } from '@/payload-types'

import { HOME_SLUG } from '@/lib/slug'
import { richText } from './richText'

/**
 * Two customers, three shapes of content, two locales — the minimum that can
 * actually prove tenant isolation. `acme` is bilingual, `studio` is Persian-only,
 * so a locale that one site serves and the other does not is testable.
 *
 * Every site gets a published page, a draft page and a post: the draft is what
 * the public-render tests assert is *not* visible.
 */
const sites = [
  {
    domain: 'acme.localhost',
    en: { tagline: 'Industrial supply, since 1974.', title: 'Acme' },
    locales: ['fa', 'en'],
    name: 'آکمه',
    slug: 'acme',
    tagline: 'تأمین قطعات صنعتی از سال ۱۳۵۳.',
    theme: { accent: '#f59e0b', lineHeight: 1.8, primary: '#0f766e', radius: 'sm' as const },
    type: 'business' as const,
  },
  {
    domain: 'studio.localhost',
    en: null,
    locales: ['fa'],
    name: 'استودیو نقش',
    slug: 'studio-naghsh',
    tagline: 'طراحی گرافیک و هویت بصری.',
    theme: { accent: '#0ea5e9', lineHeight: 1.9, primary: '#7c3aed', radius: 'lg' as const },
    type: 'portfolio' as const,
  },
]

/** Collections the seed owns end to end, cleared before it writes. */
const owned: CollectionSlug[] = [
  'categories',
  'form-submissions',
  'forms',
  'media',
  'pages',
  'posts',
  'redirects',
  'search',
  'header',
  'footer',
  'theme',
]

/**
 * The blocks a site of this type is allowed to use, with enough content to see
 * whether they render — the price and the phone numbers are what prove digits go
 * through `src/lib/format.ts`.
 */
const siteBlocks = (type: 'business' | 'portfolio' | 'store'): Page['layout'] => [
  {
    blockType: 'features',
    columns: '3',
    heading: 'چرا ما',
    items: [
      { description: 'سفارش‌ها را در همان روز کاری می‌فرستیم.', title: 'ارسال سریع' },
      { description: 'هر قطعه با ضمانت کتبی تحویل داده می‌شود.', title: 'ضمانت اصالت' },
      { description: 'پاسخ تلفنی و پیام‌رسان، هر روز هفته.', title: 'پشتیبانی همیشگی' },
    ],
  },
  {
    blockType: 'testimonials',
    heading: 'مشتری‌ها چه می‌گویند',
    items: [
      {
        author: 'رضا کریمی',
        quote: 'سه سال است قطعات خط تولید را از همین‌جا می‌گیریم و یک بار هم دیر نرسیده.',
        role: 'مدیر خرید',
      },
    ],
  },
  {
    blockType: 'team',
    columns: '3',
    heading: 'تیم ما',
    members: [
      { name: 'سارا موسوی', bio: 'ده سال سابقهٔ طراحی سامانه‌های صنعتی.', role: 'مدیر فنی' },
      { name: 'امیر رضایی', role: 'کارشناس فروش' },
    ],
  },
  ...((type === 'portfolio'
    ? []
    : [
        {
          blockType: 'pricing',
          heading: 'تعرفه‌ها',
          plans: [
            {
              name: 'پایه',
              features: ['۱۰ کاربر', 'پشتیبانی ایمیلی'],
              period: 'ماهانه',
              price: 29000,
              unit: 'تومان',
            },
            {
              name: 'حرفه‌ای',
              featured: true,
              features: ['کاربر نامحدود', 'پشتیبانی تلفنی', 'گزارش ماهانه'],
              period: 'ماهانه',
              price: 79000,
              unit: 'تومان',
            },
          ],
        },
      ]) as Page['layout']),
  {
    blockType: 'faq',
    heading: 'پرسش‌های پرتکرار',
    items: [
      {
        answer: 'سفارش‌های تهران یک روز کاری و شهرستان‌ها دو تا سه روز کاری.',
        question: 'ارسال چقدر طول می‌کشد؟',
      },
      { answer: 'بله، تا هفت روز پس از تحویل.', question: 'امکان مرجوع کردن هست؟' },
    ],
  },
]

// `revalidatePath`/`revalidateTag` throw outside a Next request scope, so every
// write with a revalidate hook must opt out — `pnpm seed` runs from the CLI.
const noRevalidate = { disableRevalidate: true }

export const seed = async ({
  payload,
  req,
}: {
  payload: Payload
  req: PayloadRequest
}): Promise<void> => {
  payload.logger.info('Seeding database...')

  payload.logger.info('— Clearing seeded collections...')

  for (const collection of owned) {
    await payload.db.deleteMany({ collection, req, where: {} })

    if (payload.collections[collection]?.config.versions) {
      await payload.db.deleteVersions({ collection, req, where: {} })
    }
  }

  // Seeded users and sites are matched by name so a hand-made platform admin
  // account survives re-seeding.
  await payload.delete({
    collection: 'users',
    context: noRevalidate,
    depth: 0,
    req,
    where: { email: { like: '@eshobe.test' } },
  })

  await payload.db.deleteMany({
    collection: 'sites',
    req,
    where: { domain: { in: sites.map(({ domain }) => domain) } },
  })

  // Created before the site owners on purpose: `Users.beforeChange` promotes the
  // first account on a database with no platform admin, so seeding an owner first
  // would hand one customer access to every site.
  await payload.create({
    collection: 'users',
    data: {
      name: 'مدیر پلتفرم',
      email: 'admin@eshobe.test',
      password: 'test1234',
      role: 'platformAdmin',
    },
    depth: 0,
    req,
  })

  for (const site of sites) {
    payload.logger.info(`— Seeding ${site.domain}...`)

    const siteDoc = await payload.create({
      collection: 'sites',
      data: {
        name: site.name,
        availableLocales: site.locales as ('en' | 'fa')[],
        defaultLocale: 'fa',
        domain: site.domain,
        slug: site.slug,
        status: 'active',
        type: site.type,
      },
      depth: 0,
      req,
    })

    // One owner and one editor per site, with access to nothing else. The
    // cross-tenant tests log in as these; the editor is what proves the publish gate.
    for (const role of ['owner', 'editor'] as const) {
      await payload.create({
        collection: 'users',
        data: {
          name: `${role === 'owner' ? 'مدیر' : 'ویرایشگر'} ${site.name}`,
          email: `${role === 'owner' ? site.slug : `${site.slug}-editor`}@eshobe.test`,
          password: 'test1234',
          role: 'user',
          tenants: [{ role, tenant: siteDoc.id }],
        },
        depth: 0,
        req,
      })
    }

    await payload.create({
      collection: 'theme',
      context: noRevalidate,
      data: { ...site.theme, site: siteDoc.id },
      depth: 0,
      req,
    })

    const page = async (
      slug: string,
      title: string,
      body: string,
      status: 'draft' | 'published',
      extra: Page['layout'] = [],
    ) =>
      payload.create({
        collection: 'pages',
        context: noRevalidate,
        data: {
          _status: status,
          hero: { type: 'lowImpact', richText: richText([{ text: title, type: 'heading' }]) },
          layout: [
            {
              blockType: 'content',
              columns: [
                { size: 'full', richText: richText([{ text: body, type: 'paragraph' }]) },
              ],
            },
            ...extra,
          ],
          meta: { description: body.slice(0, 150), title },
          site: siteDoc.id,
          slug,
          title,
        },
        depth: 0,
        locale: 'fa',
        req,
      })

    const home = await page(HOME_SLUG, site.name, site.tagline, 'published')

    // Contact sits on the translated page on purpose: its fields are flat, so the
    // English pass can rewrite them by row id without the nested-array problem the
    // blocks on `services` would have.
    const about = await page('about', 'درباره ما', `${site.name} — ${site.tagline}`, 'published', [
      {
        blockType: 'contact',
        address: 'تهران، خیابان ولیعصر، پلاک ۱۲',
        email: `info@${site.slug}.test`,
        heading: 'تماس با ما',
        hours: 'شنبه تا چهارشنبه، ۹ تا ۱۷',
        // ASCII in the data: the block renders Persian digits and keeps the raw
        // number for `tel:`, which does not dial with Persian-Indic digits.
        phones: ['02112345678', '09121234567'],
      },
    ])

    await page('coming-soon', 'به‌زودی', 'این صفحه هنوز منتشر نشده است.', 'draft')

    // Persian-only, and not translated: these blocks nest arrays inside arrays, and
    // a second-locale write would have to carry every inner row id to avoid wiping
    // the Persian copy. The `about` page is what exercises translation.
    //
    // ponytail: no `gallery` or `logos` — both need uploaded media, which arrives
    // with the storage adapter in Wave 6.
    await page(
      'services',
      site.type === 'portfolio' ? 'خدمات ما' : 'خدمات و تعرفه‌ها',
      'هر آنچه ارائه می‌دهیم، یک‌جا.',
      'published',
      siteBlocks(site.type),
    )

    const post = await payload.create({
      collection: 'posts',
      context: noRevalidate,
      data: {
        _status: 'published',
        content: richText([
          { text: 'اولین یادداشت', type: 'heading' },
          { text: 'این نوشته با داده‌های آزمایشی ساخته شده است.', type: 'paragraph' },
        ]),
        publishedAt: new Date().toISOString(),
        site: siteDoc.id,
        slug: 'first-post',
        title: 'اولین یادداشت',
      },
      depth: 0,
      locale: 'fa',
      req,
    })

    await payload.create({
      collection: 'header',
      context: noRevalidate,
      data: {
        navItems: [
          // No `/posts` item: Wave 5 builds that route, and a 404 in the header of
          // every seeded site is worse than a shorter nav.
          {
            link: {
              type: 'reference',
              label: 'درباره ما',
              reference: { relationTo: 'pages', value: about.id },
            },
          },
        ],
        site: siteDoc.id,
      },
      depth: 0,
      locale: 'fa',
      req,
    })

    await payload.create({
      collection: 'footer',
      context: noRevalidate,
      data: {
        navItems: [{ link: { type: 'custom', label: 'تماس با ما', url: '/about' } }],
        site: siteDoc.id,
      },
      depth: 0,
      locale: 'fa',
      req,
    })

    if (!site.en) continue

    // Written as a second pass, not a second document: a localized field is one row
    // per locale on the same document.
    const translate = (doc: Page, slug: string, title: string, body: string) =>
      payload.update({
        id: doc.id,
        collection: 'pages',
        context: noRevalidate,
        data: {
          hero: { type: 'lowImpact', richText: richText([{ text: title, type: 'heading' }], 'ltr') },
          /**
           * Built from the document's own rows, keeping every `id`. `layout` is not
           * localized (§3.7), so a freshly built array does not translate the page —
           * it *replaces* the rows and takes the Persian copy with them. The row id
           * is the whole difference between a translation and a rewrite.
           */
          layout: doc.layout.map((row) => {
            if (row.blockType === 'content') {
              return {
                ...row,
                columns: row.columns?.map((column) => ({
                  ...column,
                  richText: richText([{ text: body, type: 'paragraph' }], 'ltr'),
                })),
              }
            }

            if (row.blockType === 'contact') {
              return {
                ...row,
                address: 'No. 12, Valiasr St., Tehran',
                heading: 'Contact us',
                hours: 'Sat–Wed, 9 to 17',
              }
            }

            return row
          }),
          // `meta` too, not just `title`: localized fields fall back, so an untranslated
          // `meta.title` would put the Persian SEO title on the English page.
          meta: { description: body.slice(0, 150), title },
          // `slug` is localized, so the English route is set explicitly rather than
          // left to auto-generate off the title.
          slug,
          title,
        },
        depth: 0,
        locale: 'en',
        req,
      })

    // `home` in both locales, deliberately: bare `/` and `/en` resolve by looking up
    // the reserved slug, so a per-locale home slug would make `/en` unreachable.
    await translate(home, HOME_SLUG, site.en.title, site.en.tagline)
    // Translated too, not left Persian-only: a `where` on a localized slug does not
    // fall back, so an untranslated page 404s — and the nav links to it in every locale.
    await translate(about, 'about', 'About us', `${site.en.title} — ${site.en.tagline}`)

    await payload.update({
      id: post.id,
      collection: 'posts',
      context: noRevalidate,
      data: {
        content: richText([{ text: 'First note', type: 'paragraph' }], 'ltr'),
        slug: 'first-post-en',
        title: 'First note',
      },
      depth: 0,
      locale: 'en',
      req,
    })
  }

  payload.logger.info('Seeded database successfully!')
}
