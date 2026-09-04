import type { Form, Page, Site, Theme } from '@/payload-types'

import { richText } from './richText'

import { dirFor } from '@/lib/locales'

/** One row of a form's `fields` blocks, as the generated types see it. */
export type StarterFormField = NonNullable<Form['fields']>[number]

/** The three site types a `sites` doc can carry. */
export type SiteType = NonNullable<Site['type']>

/**
 * Platform locales, narrowed. Starter content is written for *both* — a freshly
 * provisioned site has no half-translated pages, whichever subset it serves.
 */
export type StarterLocale = 'en' | 'fa'

/** A string in every locale starter content is written for. */
export type Text = Record<StarterLocale, string>

/** Values the builders need that only exist at provision time. */
export type PageRefs = {
  /** The contact page, created first so later pages can link to it. */
  contactPageId: string
  /** The contact form, created before any page. */
  formId: string
  /** `info@client.ir` — derived from the domain, so it is plausible per site. */
  contactEmail: string
  /** The site's own name; the home page's hero heading. */
  siteName: string
}

/** Copy for one section. One type, optional sections, shared by all site types. */
type Copy = {
  home: {
    intro: string
    features: FeaturesCopy
    testimonials?: TestimonialsCopy
    cta: CtaCopy
  }
  about: {
    intro: string
    team?: TeamCopy
  }
  services: {
    title: string
    intro: string
    pricing?: PricingCopy
    faq?: FaqCopy
    features?: FeaturesCopy
    cta?: CtaCopy
  }
  contact: ContactCopy
  form: {
    intro: string
    labels: { email: string; message: string; name: string }
    submit: string
    confirmation: string
  }
}

type CtaCopy = { heading: string; linkLabel: string }
type ContactCopy = { address: string; heading: string; hours: string }
type FaqCopy = { heading: string; items: { answer: string; question: string }[] }
type FeaturesCopy = { heading: string; items: { description: string; title: string }[] }
type PricingCopy = {
  heading: string
  plans: { featured?: boolean; features: string[]; name: string; price: number }[]
}
type TeamCopy = { heading: string; members: { bio: string; name: string; role: string }[] }
type TestimonialsCopy = { heading: string; items: { author: string; quote: string; role: string }[] }

/**
 * One starter page. `build` runs per page, *at creation time*, so a page whose
 * CTA links to the contact page gets the real id — contact is created first.
 * Both locales run the same builders, so the block sequence is identical and the
 * translation pass can pair rows by index (see `provisionSite.ts`).
 */
export type StarterPage = {
  /**
   * ASCII and identical in every locale: a localized slug with no row for a locale
   * makes the page unreachable there, and the nav links to every starter page in
   * every locale the site serves.
   */
  slug: string
  title: string
  /**
   * The low-impact hero's single heading. The home page's hero is the site's own
   * name, substituted by `provisionSite` — it only exists at provision time.
   */
  hero: string
  /** Lead paragraph, also reused as the SEO description. */
  intro: string
  build: (refs: PageRefs) => Page['layout']
}

/** The header nav, in display order. Slugs must exist among the starter pages. */
export type StarterNavItem = { slug: string; label: Text }

/** The theme tokens a new site of this type starts from. */
export type StarterTheme = Pick<Theme, 'accent' | 'lineHeight' | 'primary' | 'radius'>

/** A single product a freshly provisioned store starts with. */
export type StarterProduct = {
  /** Price in the site's minor currency unit (Toman). */
  price: number
  compareAtPrice?: number
  title: Text
  summary: Text
  slug: Text
  trackInventory?: boolean
  inventory?: number
}

/** Starter catalogue for a store site — three products so the grid has something to show. */
export const starterProducts = (locale: StarterLocale): StarterProduct[] => {
  if (locale === 'fa') {
    return [
      {
        price: 480_000,
        summary: { en: 'Cardamom brittle, in a 750 g tin.', fa: 'شیرینی خشک هل، در قوطی فلزی ۷۵۰ گرمی.' },
        title: { en: 'Cardamom Brittle', fa: 'سوهان هل' },
        slug: { en: 'sohan-hel', fa: 'سوهان-هل' },
        trackInventory: true,
        inventory: 20,
      },
      {
        compareAtPrice: 260_000,
        price: 198_000,
        summary: { en: 'Premium saffron, 4 g pack.', fa: 'زعفران سرگل، بستهٔ ۴ گرمی.' },
        title: { en: 'Premium Saffron', fa: 'زعفران سرگل' },
        slug: { en: 'zaferan-sargol', fa: 'زعفران-سرگل' },
        trackInventory: false,
      },
      {
        price: 290_000,
        summary: { en: 'Rose water double-distilled, 500 ml bottle.', fa: 'گلاب دوآتیشه، بطری ۵۰۰ سی‌سی.' },
        title: { en: 'Rose Water', fa: 'گلاب دوآتیشه' },
        slug: { en: 'golab-do-atish', fa: 'گلاب-دوآتیشه' },
        trackInventory: true,
        inventory: 40,
      },
    ]
  }
  return [
    {
      price: 480_000,
      summary: { en: 'Cardamom brittle, in a 750 g tin.', fa: 'شیرینی خشک هل، در قوطی فلزی ۷۵۰ گرمی.' },
      title: { en: 'Cardamom Brittle', fa: 'سوهان هل' },
      slug: { en: 'sohan-hel', fa: 'سوهان-هل' },
      trackInventory: true,
      inventory: 20,
    },
    {
      compareAtPrice: 260_000,
      price: 198_000,
      summary: { en: 'Premium saffron, 4 g pack.', fa: 'زعفران سرگل، بستهٔ ۴ گرمی.' },
      title: { en: 'Premium Saffron', fa: 'زعفران سرگل' },
      slug: { en: 'zaferan-sargol', fa: 'زعفران-سرگل' },
      trackInventory: false,
    },
    {
      price: 290_000,
      summary: { en: 'Rose water double-distilled, 500 ml bottle.', fa: 'گلاب دوآتیشه، بطری ۵۰۰ سی‌سی.' },
      title: { en: 'Rose Water', fa: 'گلاب دوآتیشه' },
      slug: { en: 'golab-do-atish', fa: 'گلاب-دوآتیشه' },
      trackInventory: true,
      inventory: 40,
    },
  ]
}

// --- block builders -----------------------------------------------------------

const contentBlock = (locale: StarterLocale, paragraph: string): Page['layout'] => [
  {
    blockType: 'content',
    columns: [
      { size: 'full', richText: richText([{ text: paragraph, type: 'paragraph' }], dirFor(locale)) },
    ],
  },
]

const featuresBlock = (copy: FeaturesCopy): Page['layout'] => [
  {
    blockType: 'features',
    columns: '3',
    heading: copy.heading,
    items: copy.items.map(({ description, title }) => ({ description, title })),
  },
]

const testimonialsBlock = (copy: TestimonialsCopy): Page['layout'] => [
  {
    blockType: 'testimonials',
    heading: copy.heading,
    items: copy.items.map(({ author, quote, role }) => ({ author, quote, role })),
  },
]

const faqBlock = (copy: FaqCopy): Page['layout'] => [
  {
    blockType: 'faq',
    heading: copy.heading,
    items: copy.items.map(({ answer, question }) => ({ answer, question })),
  },
]

const teamBlock = (copy: TeamCopy): Page['layout'] => [
  {
    blockType: 'team',
    columns: '3',
    heading: copy.heading,
    members: copy.members.map(({ bio, name, role }) => ({ bio, name, role })),
  },
]

const pricingBlock = (copy: PricingCopy, locale: StarterLocale): Page['layout'] => [
  {
    blockType: 'pricing',
    heading: copy.heading,
    plans: copy.plans.map(({ featured, features, name, price }) => ({
      featured,
      features,
      name,
      period: locale === 'fa' ? 'ماهانه' : 'monthly',
      price,
      unit: locale === 'fa' ? 'تومان' : 'Toman',
    })),
  },
]

const productGridBlock = (): Page['layout'] => [
  {
    blockType: 'productGrid',
    columns: '3',
    limit: 6,
    populateBy: 'collection',
    showBuyButton: true,
  },
]

/** A reference link to the contact page — the target is not localized, the label is. */
const ctaBlock = (locale: StarterLocale, refs: PageRefs, copy: CtaCopy): Page['layout'] => [
  {
    blockType: 'cta',
    links: [
      {
        link: {
          label: copy.linkLabel,
          reference: { relationTo: 'pages', value: refs.contactPageId },
          type: 'reference',
        },
      },
    ],
    richText: richText([{ tag: 'h3', text: copy.heading, type: 'heading' }], dirFor(locale)),
  },
]

const contactBlocks = (locale: StarterLocale, refs: PageRefs, copy: ContactCopy, form: Copy['form']): Page['layout'] => [
  {
    address: copy.address,
    blockType: 'contact',
    email: refs.contactEmail,
    // ASCII on purpose: the block renders Persian digits on `fa` and keeps the raw
    // number for `tel:`, which does not dial with Persian-Indic digits.
    heading: copy.heading,
    hours: copy.hours,
    phones: ['02112345678'],
  },
  {
    blockType: 'formBlock',
    enableIntro: true,
    form: refs.formId,
    introContent: richText([{ text: form.intro, type: 'heading' }], dirFor(locale)),
  },
]

// --- the contact form ---------------------------------------------------------

/** The contact form's copy — identical for every site type, written in both locales. */
const formCopy: Record<StarterLocale, Copy['form']> = {
  en: {
    confirmation: 'Your message arrived; we will reply soon.',
    intro: 'Leave us a message',
    labels: { email: 'Email', message: 'Message', name: 'Name' },
    submit: 'Send message',
  },
  fa: {
    confirmation: 'پیام شما رسید؛ به‌زودی پاسخ می‌دهیم.',
    intro: 'برای ما پیام بگذارید',
    labels: { email: 'رایانامه', message: 'پیام', name: 'نام' },
    submit: 'ارسال پیام',
  },
}

/** Every starter site gets one contact form. Field labels are localized. */
export const starterForm = (
  locale: StarterLocale,
): {
  confirmationMessage: ReturnType<typeof richText>
  fields: StarterFormField[]
  submitButtonLabel: string
} => {
  const copy = formCopy[locale]

  return {
    confirmationMessage: richText([{ text: copy.confirmation, type: 'paragraph' }], dirFor(locale)),
    fields: [
      { blockType: 'text', label: copy.labels.name, name: 'name', required: true, width: 50 },
      { blockType: 'email', label: copy.labels.email, name: 'email', required: true, width: 50 },
      { blockType: 'textarea', label: copy.labels.message, name: 'message', required: true, width: 100 },
    ],
    submitButtonLabel: copy.submit,
  }
}

/** The form's own title is not a localized field — Persian reads fine as the internal name. */
export const starterFormTitle = (siteName: string): string => `فرم تماس ${siteName}`

// --- per-site-type copy -------------------------------------------------------

const businessCopy: Record<StarterLocale, Copy> = {
  fa: {
    about: {
      intro:
        'کمی دربارهٔ تاریخچه، مأموریت و ارزش‌های شرکت خود بنویسید. یک پاراگراف کوتاه، صادقانه و انسانی بهتر از یک متن تبلیغاتی طولانی جواب می‌دهد.',
      team: {
        heading: 'تیم ما',
        members: [
          { bio: 'یک جمله دربارهٔ تخصص و سابقهٔ این عضو تیم.', name: 'نام و نام خانوادگی', role: 'مدیرعامل' },
          { bio: 'یک جمله دربارهٔ تخصص و سابقهٔ این عضو تیم.', name: 'نام و نام خانوادگی', role: 'مدیر فروش' },
          { bio: 'یک جمله دربارهٔ تخصص و سابقهٔ این عضو تیم.', name: 'نام و نام خانوادگی', role: 'کارشناس فنی' },
        ],
      },
    },
    contact: {
      address: 'تهران، خیابان نمونه، پلاک ۱۰',
      heading: 'اطلاعات تماس',
      hours: 'شنبه تا چهارشنبه، ۹ تا ۱۷',
    },
    form: {
      confirmation: 'پیام شما رسید؛ به‌زودی پاسخ می‌دهیم.',
      intro: 'برای ما پیام بگذارید',
      labels: { email: 'رایانامه', message: 'پیام', name: 'نام' },
      submit: 'ارسال پیام',
    },
    home: {
      cta: { heading: 'آمادهٔ شروع هستید؟', linkLabel: 'تماس با ما' },
      features: {
        heading: 'چرا ما؟',
        items: [
          { description: 'سال‌ها کار با مشتری‌هایی مثل شما.', title: 'تجربهٔ اثبات‌شده' },
          { description: 'تیم ما همان روز کاری پاسخ می‌دهد.', title: 'پاسخ‌گویی سریع' },
          { description: 'بدون هزینهٔ پنهان؛ همه‌چیز از پیش هماهنگ می‌شود.', title: 'قیمت شفاف' },
        ],
      },
      intro:
        'این نخستین پاراگراف سایت شماست. آن را با چند جمله دربارهٔ آنچه ارائه می‌دهید جایگزین کنید — چه می‌کنید، برای چه کسی و چه چیزی شما را متفاوت می‌کند.',
      testimonials: {
        heading: 'مشتری‌ها چه می‌گویند',
        items: [
          {
            author: 'مشتری نمونه',
            quote: 'همکاری با این مجموعه از همان روز اول روان و قابل‌اعتماد بود؛ قطعاً ادامه می‌دهیم.',
            role: 'مدیر محصول',
          },
        ],
      },
    },
    services: {
      faq: {
        heading: 'پرسش‌های پرتکرار',
        items: [
          { answer: 'شنبه تا چهارشنبه، ۹ تا ۱۷.', question: 'ساعات کاری شما چگونه است؟' },
          {
            answer: 'از طریق فرم تماس با ما در همین سایت پیام بگذارید تا با شما تماس بگیریم.',
            question: 'چگونه می‌توانم سفارش ثبت کنم؟',
          },
        ],
      },
      intro: 'فهرست خدمات اصلی خود را با چند کلمهٔ توضیح بنویسید؛ جزئیات را بعداً اضافه کنید.',
      pricing: {
        heading: 'تعرفه‌ها',
        plans: [
          { features: ['یک سرویس اصلی', 'پشتیبانی ایمیلی'], name: 'پایه', price: 4_900_000 },
          {
            features: ['همهٔ خدمات پایه', 'پشتیبانی تلفنی', 'گزارش ماهانه'],
            featured: true,
            name: 'حرفه‌ای',
            price: 9_900_000,
          },
        ],
      },
      title: 'خدمات و تعرفه‌ها',
    },
  },
  en: {
    about: {
      intro:
        "Write a little about your company's history, mission and values. One short, honest, human paragraph works better than a long promotional text.",
      team: {
        heading: 'Our team',
        members: [
          { bio: 'One sentence about this member\u2019s expertise and background.', name: 'Full Name', role: 'CEO' },
          { bio: 'One sentence about this member\u2019s expertise and background.', name: 'Full Name', role: 'Sales Manager' },
          { bio: 'One sentence about this member\u2019s expertise and background.', name: 'Full Name', role: 'Technical Specialist' },
        ],
      },
    },
    contact: {
      address: 'No. 10, Sample Street, Tehran',
      heading: 'Contact details',
      hours: 'Saturday to Wednesday, 9 to 17',
    },
    form: {
      confirmation: 'Your message arrived; we will reply soon.',
      intro: 'Leave us a message',
      labels: { email: 'Email', message: 'Message', name: 'Name' },
      submit: 'Send message',
    },
    home: {
      cta: { heading: 'Ready to start?', linkLabel: 'Contact us' },
      features: {
        heading: 'Why us',
        items: [
          { description: 'Years of work with clients like you.', title: 'Proven experience' },
          { description: 'Our team replies within the same business day.', title: 'Fast responses' },
          { description: 'No hidden costs; everything is agreed upfront.', title: 'Transparent pricing' },
        ],
      },
      intro:
        'This is the first paragraph of your website. Replace it with a few sentences about what you offer — what you do, for whom, and what makes you different.',
      testimonials: {
        heading: 'What clients say',
        items: [
          {
            author: 'Sample Client',
            quote: 'Working with this team was smooth and dependable from day one; we are definitely continuing.',
            role: 'Product Manager',
          },
        ],
      },
    },
    services: {
      faq: {
        heading: 'Frequently asked questions',
        items: [
          { answer: 'Saturday to Wednesday, 9 to 17.', question: 'What are your working hours?' },
          {
            answer: 'Leave a message through the contact form on this site and we will get back to you.',
            question: 'How can I place an order?',
          },
        ],
      },
      intro: 'List your main services with a few words of description; you can add the details later.',
      pricing: {
        heading: 'Pricing',
        plans: [
          { features: ['One core service', 'Email support'], name: 'Basic', price: 4_900_000 },
          {
            features: ['Everything in Basic', 'Phone support', 'Monthly report'],
            featured: true,
            name: 'Professional',
            price: 9_900_000,
          },
        ],
      },
      title: 'Services and pricing',
    },
  },
}

const portfolioCopy: Record<StarterLocale, Copy> = {
  fa: {
    about: {
      intro:
        'کمی دربارهٔ مسیر حرفه‌ای خود بنویسید: از کجا شروع کردید، روی چه کارهایی تمرکز دارید و چه چیزی شما را هیجان‌زده می‌کند.',
      team: {
        heading: 'دربارهٔ من',
        members: [
          { bio: 'یک جمله دربارهٔ تخصص و سبک کاری شما.', name: 'نام شما', role: 'بنیان‌گذار و طراح' },
          { bio: 'یک جمله دربارهٔ تخصص و سبک کاری این همکار.', name: 'نام همکار', role: 'طراح ارشد' },
        ],
      },
    },
    contact: {
      address: 'تهران، خیابان نمونه، پلاک ۱۰',
      heading: 'اطلاعات تماس',
      hours: 'شنبه تا چهارشنبه، ۹ تا ۱۷',
    },
    form: {
      confirmation: 'پیام شما رسید؛ به‌زودی پاسخ می‌دهیم.',
      intro: 'برای ما پیام بگذارید',
      labels: { email: 'رایانامه', message: 'پیام', name: 'نام' },
      submit: 'ارسال پیام',
    },
    home: {
      cta: { heading: 'بیایید با هم چیزی بسازیم.', linkLabel: 'شروع همکاری' },
      features: {
        heading: 'با چه کاری کمک می‌کنم؟',
        items: [
          { description: 'از لوگو تا سیستم کامل برند.', title: 'طراحی هویت بصری' },
          { description: 'طراحی رابط تمیز و قابل‌استفاده برای وب و موبایل.', title: 'رابط کاربری' },
          { description: 'یک نگاه تازه به مسائل قدیمی برند شما.', title: 'مشاورهٔ خلاقانه' },
        ],
      },
      intro:
        'نمونه‌کارهای خود را اینجا معرفی کنید. چند خط دربارهٔ سبک، تخصص و کاری که می‌خواهید بیشتر از همه ببینید.',
      testimonials: {
        heading: 'کارفرماها چه می‌گویند',
        items: [
          {
            author: 'کارفرمای نمونه',
            quote: 'خلاقیت و نظم را با هم دارند؛ نتیجهٔ کار از انتظارم هم بهتر شد.',
            role: 'مدیر بازاریابی',
          },
        ],
      },
    },
    services: {
      faq: {
        heading: 'پرسش‌های پرتکرار',
        items: [
          {
            answer: 'پس از گفت‌وگوی اولیه، پیشنهاد کاری می‌فرستم و پس از تأیید، کار را شروع می‌کنیم.',
            question: 'فرایند همکاری چگونه است؟',
          },
          { answer: 'بسته به دامنهٔ کار؛ معمولاً بین دو تا شش هفته.', question: 'هر پروژه چقدر طول می‌کشد؟' },
        ],
      },
      intro: 'خدمات و بسته‌های کاری خود را همراه با توضیح کوتاه فهرست کنید.',
      title: 'خدمات',
    },
  },
  en: {
    about: {
      intro:
        'Write a little about your professional path: where you started, what you focus on, and what excites you.',
      team: {
        heading: 'About me',
        members: [
          { bio: 'One sentence about your expertise and working style.', name: 'Your Name', role: 'Founder & Designer' },
          { bio: 'One sentence about this collaborator\u2019s expertise.', name: 'Collaborator Name', role: 'Senior Designer' },
        ],
      },
    },
    contact: {
      address: 'No. 10, Sample Street, Tehran',
      heading: 'Contact details',
      hours: 'Saturday to Wednesday, 9 to 17',
    },
    form: {
      confirmation: 'Your message arrived; we will reply soon.',
      intro: 'Leave us a message',
      labels: { email: 'Email', message: 'Message', name: 'Name' },
      submit: 'Send message',
    },
    home: {
      cta: { heading: 'Let\u2019s build something together.', linkLabel: 'Start a project' },
      features: {
        heading: 'What I help with',
        items: [
          { description: 'From logo to a complete brand system.', title: 'Brand identity design' },
          { description: 'Clean, usable interfaces for web and mobile.', title: 'User interface' },
          { description: 'A fresh look at your brand\u2019s old problems.', title: 'Creative consulting' },
        ],
      },
      intro:
        'Introduce your work here. A few lines about your style, specialty and the kind of projects you want more of.',
      testimonials: {
        heading: 'What clients say',
        items: [
          {
            author: 'Sample Client',
            quote: 'They bring creativity and discipline together; the result was better than I expected.',
            role: 'Marketing Manager',
          },
        ],
      },
    },
    services: {
      faq: {
        heading: 'Frequently asked questions',
        items: [
          {
            answer: 'After an initial conversation I send a work proposal, and once approved we begin.',
            question: 'What is the collaboration process?',
          },
          { answer: 'Depends on scope; usually two to six weeks.', question: 'How long does each project take?' },
        ],
      },
      intro: 'List your services and work packages with a short description each.',
      title: 'Services',
    },
  },
}

const storeCopy: Record<StarterLocale, Copy> = {
  fa: {
    about: {
      intro: 'داستان فروشگاه خود را تعریف کنید: از کجا شروع کردید و چه چیزی شما را خاص می‌کند.',
    },
    contact: {
      address: 'تهران، خیابان نمونه، پلاک ۱۰',
      heading: 'اطلاعات تماس',
      hours: 'شنبه تا چهارشنبه، ۹ تا ۱۷',
    },
    form: {
      confirmation: 'پیام شما رسید؛ به‌زودی پاسخ می‌دهیم.',
      intro: 'برای ما پیام بگذارید',
      labels: { email: 'رایانامه', message: 'پیام', name: 'نام' },
      submit: 'ارسال پیام',
    },
    home: {
      cta: { heading: 'فروشگاه را ببینید.', linkLabel: 'محصولات' },
      features: {
        heading: 'چرا از ما خرید کنید؟',
        items: [
          { description: 'سفارش‌ها با پست پیشتاز به سراسر کشور ارسال می‌شود.', title: 'ارسال به سراسر کشور' },
          { description: 'تا هفت روز، بدون قید و شرط.', title: 'ضمانت بازگشت کالا' },
          { description: 'پرداخت آنلاین از طریق درگاه‌های معتبر.', title: 'پرداخت امن' },
        ],
      },
      intro:
        'به فروشگاه ما خوش آمدید. محصولات اصلی خود را اینجا معرفی کنید و به مشتری‌ها بگویید چرا از شما بخرند.',
    },
    services: {
      cta: { heading: 'سؤالی دربارهٔ محصولات دارید؟', linkLabel: 'بپرسید' },
      features: {
        heading: 'دسته‌بندی‌ها',
        items: [
          { description: 'محصولات این دسته را اینجا معرفی کنید.', title: 'دستهٔ نخست' },
          { description: 'محصولات این دسته را اینجا معرفی کنید.', title: 'دستهٔ دوم' },
          { description: 'محصولات این دسته را اینجا معرفی کنید.', title: 'دستهٔ سوم' },
        ],
      },
      faq: {
        heading: 'پرسش‌های پرتکرار',
        items: [
          {
            answer: 'برای سفارش‌های بالای یک میلیون تومان رایگان؛ در غیر این صورت هنگام پرداخت محاسبه می‌شود.',
            question: 'هزینهٔ ارسال چقدر است؟',
          },
          { answer: 'پس از ارسال، کد رهگیری برای شما پیامک می‌شود.', question: 'چطور سفارشم را پیگیری کنم؟' },
        ],
      },
      intro:
        'فهرست محصولات و دسته‌بندی‌های خود را اینجا بسازید. با افزودن تصویر و قیمت، فروش را شروع کنید.',
      title: 'محصولات',
    },
  },
  en: {
    about: {
      intro: "Tell your shop's story: where you started and what makes you special.",
    },
    contact: {
      address: 'No. 10, Sample Street, Tehran',
      heading: 'Contact details',
      hours: 'Saturday to Wednesday, 9 to 17',
    },
    form: {
      confirmation: 'Your message arrived; we will reply soon.',
      intro: 'Leave us a message',
      labels: { email: 'Email', message: 'Message', name: 'Name' },
      submit: 'Send message',
    },
    home: {
      cta: { heading: 'Browse the shop.', linkLabel: 'Products' },
      features: {
        heading: 'Why buy from us',
        items: [
          { description: 'Orders ship nationwide via express post.', title: 'Nationwide shipping' },
          { description: 'Up to seven days, no questions asked.', title: 'Return guarantee' },
          { description: 'Online payment through trusted gateways.', title: 'Secure payment' },
        ],
      },
      intro:
        'Welcome to our shop. Introduce your main products here and tell customers why they should buy from you.',
    },
    services: {
      cta: { heading: 'A question about the products?', linkLabel: 'Ask us' },
      features: {
        heading: 'Categories',
        items: [
          { description: 'Introduce the products in this category here.', title: 'First category' },
          { description: 'Introduce the products in this category here.', title: 'Second category' },
          { description: 'Introduce the products in this category here.', title: 'Third category' },
        ],
      },
      faq: {
        heading: 'Frequently asked questions',
        items: [
          {
            answer: 'Free for orders above one million Toman; otherwise calculated at checkout.',
            question: 'How much is shipping?',
          },
          { answer: 'Once shipped, a tracking code is sent to you by SMS.', question: 'How do I track my order?' },
        ],
      },
      intro: 'Build your product list and categories here. Add an image and a price to start selling.',
      title: 'Products',
    },
  },
}

const copyFor = (type: SiteType, locale: StarterLocale): Copy => {
  switch (type) {
    case 'portfolio':
      return portfolioCopy[locale]
    case 'store':
      return storeCopy[locale]
    default:
      return businessCopy[locale]
  }
}

// --- pages, nav and theme -----------------------------------------------------

/**
 * The starter pages of a site type, in *creation* order: contact first, so every
 * later page's CTA can reference it; home last. Nav display order is
 * `starterNav`, not this order.
 */
export const starterPages = (type: SiteType, locale: StarterLocale): StarterPage[] => {
  const copy = copyFor(type, locale)

  const contact: StarterPage = {
    hero: locale === 'fa' ? 'تماس با ما' : 'Contact us',
    intro: locale === 'fa'
      ? 'نشانی و راه‌های ارتباطی خود را اینجا بنویسید تا مشتری‌ها به‌راحتی شما را پیدا کنند.'
      : 'Write your address and contact channels here so customers can find you easily.',
    build: (refs) => contactBlocks(locale, refs, copy.contact, formCopy[locale]),
    slug: 'contact',
    title: locale === 'fa' ? 'تماس با ما' : 'Contact us',
  }

  const about: StarterPage = {
    hero: locale === 'fa' ? 'درباره ما' : 'About us',
    intro: copy.about.intro,
    build: () => [
      ...contentBlock(locale, copy.about.intro),
      ...(copy.about.team ? teamBlock(copy.about.team) : []),
    ],
    slug: 'about',
    title: locale === 'fa' ? 'درباره ما' : 'About us',
  }

  const services: StarterPage = {
    hero: copy.services.title,
    intro: copy.services.intro,
    build: (refs) => [
      ...contentBlock(locale, copy.services.intro),
      ...(type === 'store' ? productGridBlock() : []),
      ...(copy.services.features ? featuresBlock(copy.services.features) : []),
      ...(copy.services.pricing ? pricingBlock(copy.services.pricing, locale) : []),
      ...(copy.services.faq ? faqBlock(copy.services.faq) : []),
      ...(copy.services.cta ? ctaBlock(locale, refs, copy.services.cta) : []),
    ],
    slug: type === 'store' ? 'products' : 'services',
    title: copy.services.title,
  }

  const home: StarterPage = {
    // Overridden by `provisionSite` with the site's own name — it only exists at
    // provision time. See the note on `StarterPage.hero`.
    hero: '',
    intro: copy.home.intro,
    build: (refs) => [
      ...contentBlock(locale, copy.home.intro),
      ...featuresBlock(copy.home.features),
      ...(copy.home.testimonials ? testimonialsBlock(copy.home.testimonials) : []),
      ...ctaBlock(locale, refs, copy.home.cta),
    ],
    slug: 'home',
    title: locale === 'fa' ? 'خانه' : 'Home',
  }

  return [contact, about, services, home]
}

/**
 * The header and footer nav. The footer repeats the header: both are per-site
 * singletons with their own `navItems`, and a footer that links nowhere is a
 * wasted half of the shell.
 */
export const starterNav = (type: SiteType): StarterNavItem[] => {
  const servicesLabel: Text =
    type === 'store' ? { en: 'Products', fa: 'محصولات' } : { en: 'Services', fa: 'خدمات' }

  return [
    { label: { en: 'About us', fa: 'درباره ما' }, slug: 'about' },
    { label: servicesLabel, slug: type === 'store' ? 'products' : 'services' },
    { label: { en: 'Contact', fa: 'تماس' }, slug: 'contact' },
  ]
}

/**
 * Where a new site's design starts, by type. Only the tokens `themeCss` knows how
 * to emit; everything else keeps the platform palette.
 */
export const starterTheme = (type: SiteType): StarterTheme => {
  switch (type) {
    case 'portfolio':
      // Roomier leading and rounder corners: galleries and portfolios read as
      // visual work, not documents.
      return { accent: '#0ea5e9', lineHeight: 1.9, primary: '#7c3aed', radius: 'lg' }
    case 'store':
      return { accent: '#0d9488', lineHeight: 1.8, primary: '#be123c', radius: 'md' }
    default:
      return { accent: '#f59e0b', lineHeight: 1.8, primary: '#0f766e', radius: 'sm' }
  }
}
