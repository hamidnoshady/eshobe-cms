import type { SourceInventory } from './discovery'
import { classifyCptCapability } from './discovery'

/**
 * The coverage matrix (issue #166 step 3): every discovered resource lands in
 * exactly one disposition, shown to the operator before anything is written.
 *
 *   - `supported` — the destination model represents it natively today.
 *   - `requires-mapping` — representable, but a human must confirm field
 *     mapping (taxonomies, money, statuses, SEO…) first.
 *   - `unsupported-blocking` — importing without it would lose data or break
 *     a running business process; the wizard must stop, not skip.
 *   - `archive-only` — preserved with provenance for audit/manual rebuild,
 *     explicitly not functional parity.
 *
 * Dispositions describe both destination readiness and the human decision a
 * run still needs. Woo order history is `requires-mapping`, for example: the
 * native multi-line model exists, but source/target money and the exact
 * reconciliation gate must be confirmed before a cutover may proceed. Rows
 * move deliberately as adapters land, with the mapping doc updated in the
 * same change.
 */

export type CoverageDisposition =
  | 'archive-only'
  | 'requires-mapping'
  | 'supported'
  | 'unsupported-blocking'

export type CoverageRow = {
  count?: number
  destination: string
  disposition: CoverageDisposition
  label: string
  reason: string
  resource: string
}

export type CoverageFacts = {
  /** Known record counts per resource key, from a preflight count pass. */
  counts?: Record<string, number>
  /** Active plugin slugs/names reported by the source, when available. */
  plugins?: string[]
  woo?: {
    hasOrders?: boolean
    hasSubscriptions?: boolean
    hasVariableProducts?: boolean
  }
}

const EXTENSION_RULES: { disposition: CoverageDisposition; match: RegExp; reason: string }[] = [
  {
    disposition: 'unsupported-blocking',
    match: /subscription|membership|booking|gift-?card|dokan|wcfm|multivendor|learndash|tutor|deposit|loyalty|bundle/i,
    reason:
      'این افزونه رفتار عملیاتی/مالی دارد و در ای‌شوب معادل بومی آماده نیست؛ انتقال خام رکوردها «کارکرد» را جابه‌جا نمی‌کند و تا ساخت تطبیق‌دهنده، مهاجرت عملیاتی این بخش متوقف می‌شود.',
  },
  {
    disposition: 'archive-only',
    match: /elementor|divi|beaver|wpbakery|visual[- ]composer|oxygen|bricks/i,
    reason:
      'خروجی صفحه‌ساز به‌صورت خام با منشأ نگهداری می‌شود؛ بازسازی معادل در قالب ای‌شوب کار جداگانه‌ای است و وعده بازتولید ۱:۱ داده نمی‌شود.',
  },
  {
    disposition: 'archive-only',
    match: /wpforms|contact[- ]form|gravity|ninja[- ]forms|forminator/i,
    reason:
      'تعریف و پاسخ‌های فرم برای بازبینی دستی بایگانی می‌شوند؛ فرم معادل باید در فرم‌ساز ای‌شوب ساخته و نگاشت شود.',
  },
  {
    disposition: 'requires-mapping',
    match: /advanced-custom-fields|acf|meta-box|pods|toolset/i,
    reason:
      'گروه‌های فیلد سفارشی به طرح فیلدهای نوع محتوای مقصد نگاشته می‌شوند؛ فیلد ناشناخته در unmappedMeta حفظ و گزارش می‌شود.',
  },
  {
    disposition: 'requires-mapping',
    match: /yoast|rank[- ]?math|seo|schema/i,
    reason: 'عنوان/توضیح سئو، کانونیکال و noindex باید فیلدبه‌فیلد به مقصد نگاشته و راستی‌آزمایی شوند.',
  },
  {
    disposition: 'requires-mapping',
    match: /wpml|polylang|translatepress|multilingual/i,
    reason: 'پیوند ترجمه‌ها و پیشوند زبان‌ها باید به زبان‌های فعال سایت مقصد نگاشته شوند.',
  },
]

export const coverageMatrix = (
  inventory: SourceInventory,
  facts: CoverageFacts = {},
): CoverageRow[] => {
  const rows: CoverageRow[] = []
  const count = (resource: string): number | undefined => facts.counts?.[resource]
  const push = (row: CoverageRow): void => {
    rows.push({ ...row, count: row.count ?? count(row.resource) })
  }

  for (const type of inventory.postTypes) {
    const resource = `post-type:${type.slug}`

    switch (type.capability) {
      case 'core-post':
        push({
          destination: 'posts',
          disposition: 'requires-mapping',
          label: 'نوشته‌ها',
          reason: 'به مجموعه نوشته‌ها نگاشته می‌شود؛ بلوک‌های گوتنبرگ و فراداده نیاز به نگاشت و آزمون وفاداری دارند.',
          resource,
        })
        break
      case 'core-page':
        push({
          destination: 'pages',
          disposition: 'requires-mapping',
          label: 'برگه‌ها',
          reason: 'به مجموعه برگه‌ها نگاشته می‌شود؛ بلوک‌ها، شورت‌کدها و سلسله‌مراتب برگه نیاز به نگاشت دارند.',
          resource,
        })
        break
      case 'attachment':
        push({
          destination: 'media',
          disposition: 'supported',
          label: 'رسانه و پیوست‌ها',
          reason: 'فایل، متن جایگزین، شرح و فراداده اندازه‌ها به کتابخانه رسانه سایت می‌آید و با هش فایل راستی‌آزمایی می‌شود.',
          resource,
        })
        break
      case 'product':
        push({
          destination: 'products (+ویژگی/تنوع/نگارخانه)',
          disposition: 'requires-mapping',
          label: 'محصولات ووکامرس',
          reason:
            'محصول ساده و متغیر هر دو در کاتالوگ می‌نشینند: ویژگی‌ها، تنوع‌ها با قیمت/موجودی جدا، نگارخانه، فروش مکمل و واژه‌ها. آنچه بازبینی انسانی می‌خواهد واحد پول و Decimals مبدأ است، نه مدل مقصد.',
          resource,
        })
        break
      case 'internal':
        push({
          destination: 'بایگانی مهاجرت',
          disposition: 'archive-only',
          label: `داخلی وردپرس (${type.slug})`,
          reason: 'ساختار داخلی هسته است؛ برای منشأ نگهداری می‌شود، محتوای نمایشی نیست.',
          resource,
        })
        break
      default: {
        const capability = classifyCptCapability(type)
        push({
          destination: 'content-entries (موتور محتوای سفارشی)',
          disposition: capability.mode === 'requires-review' ? 'unsupported-blocking' : 'supported',
          label: `${type.name} (${type.slug})`,
          reason:
            capability.mode === 'requires-review'
              ? `داده این نوع در موتور محتوای سفارشی جا می‌شود، اما ${capability.reason} تا تأیید تطبیق‌دهنده عملیاتی، برش عملیاتی متوقف است.`
              : 'تعریف، رکوردها، سلسله‌مراتب، فیلدهای سفارشی و رابطه‌ها به‌صورت بومی در content-type-definitions/content-entries ساخته و قابل ویرایش‌اند.',
          resource,
        })
      }
    }
  }

  for (const taxonomy of inventory.taxonomies) {
    push({
      destination: 'taxonomy-definitions + taxonomy-terms',
      disposition: 'supported',
      label: `${taxonomy.name} (${taxonomy.slug})`,
      reason: taxonomy.hierarchical
        ? 'درخت واژه‌ها با والد/فرزند، شناسه مبدأ و نشانی بایگانی حفظ می‌شود؛ هر طبقه‌بندی تعریف جدا می‌ماند و با دسته‌بندی ادغام نمی‌شود.'
        : 'برچسب‌گونه و تخت می‌ماند (hierarchical=false) و با دسته‌بندی‌های سلسله‌مراتبی یکی نمی‌شود.',
      resource: `taxonomy:${taxonomy.slug}`,
    })
  }

  push({
    destination: 'منشأ رکوردها (source)',
    disposition: 'supported',
    label: 'شناسه‌ها و منشأ مبدأ',
    reason: 'شناسه، نشانی، زمان ویرایش و هش محتوای هر رکورد مبدأ در گروه منشأ ذخیره می‌شود تا ورود مجدد بدون تکرار و قابل تطبیق باشد.',
    resource: 'provenance',
  })
  push({
    destination: 'کاربران CMS (دعوت صریح از مرکز مهاجرت)',
    disposition: 'requires-mapping',
    label: 'نویسندگان و کارکنان وردپرس',
    reason: 'نویسنده روی رکوردها حفظ می‌شود؛ مرکز مهاجرت کاربران دارای نقش کارکنان را از endpoint احراز‌شده وردپرس می‌خواند و مالک برای هر نفر نقش ای‌شوب را صریح انتخاب می‌کند. فقط administrator می‌تواند مالک شود و حساب تازه با ایمیل تعیین گذرواژه ساخته می‌شود؛ هیچ نقش یا گذرواژه‌ای خودکار کپی نمی‌شود.',
    resource: 'wp-users',
  })
  push({
    destination: 'menus',
    disposition: 'requires-mapping',
    label: 'منوهای ناوبری',
    reason:
      'منو و درخت آیتم‌هایش با جایگاه، ترتیب، والد و سند مقصد وارد menus می‌شود؛ این‌که قالب زنده کدام جایگاه را در سربرگ/پابرگ نشان دهد باید در قالب مقصد دیده شود.',
    resource: 'menus',
  })
  push({
    destination: 'comments',
    disposition: 'requires-mapping',
    label: 'دیدگاه‌ها و بازخوردها',
    reason:
      'دیدگاه و بازخورد محصول با وضعیت بررسی، پاسخ والد و سند مقصد وارد comments می‌شود؛ رایانامهٔ نویسنده فقط برای کارکنان است و وضعیت هرزنامه/در انتظار بدون تغییر معنا حفظ می‌شود.',
    resource: 'comments',
  })
  push({
    destination: 'customers (جدا از کاربران CMS)',
    disposition: 'requires-mapping',
    label: 'مشتریان فروشگاه و حساب مشتری',
    reason:
      'پروفایل، نشانی‌ها و رابطه با سفارش‌ها وارد customers می‌شود — هرگز به‌صورت کاربر مدیر CMS. گذرواژه وردپرس کپی نمی‌شود؛ مرکز مهاجرت برای مشتری دعوت یک‌بارمصرف و دارای انقضا می‌فرستد و قالب فروشگاه با مبادله آن نشانه، هویت تأییدشده مشتری را به حساب خودش پیوند می‌دهد (claimStatus).',
    resource: 'customers',
  })

  if (inventory.hasWooCommerce) {
    push({
      destination: 'orders (سطرهای چندگانه + جمع‌بندی کامل)',
      disposition: 'requires-mapping',
      label: 'سفارش‌ها، سطرها، بازپرداخت و مالیات ووکامرس',
      reason:
        'سفارش با همه سطرها، تخفیف/کوپن، ارسال، مالیات، هزینه‌ها، بازپرداخت و تاریخچه پرداخت وارد می‌شود و فیلدهای قدیمی تک‌محصولی فقط آینه سطر نخست‌اند. ورود تاریخی در بافت مهاجرت انجام می‌شود تا موجودی امروز و رویدادهای پرداخت دست نخورند؛ برش نهایی منوط به تطبیق دقیق جمع‌هاست.',
      resource: 'orders',
    })
    push({
      destination: 'coupons',
      disposition: 'supported',
      label: 'کوپن‌های تخفیف ووکامرس',
      reason: 'کد، گونه و مقدار، سقف استفاده، محدودیت محصول و بازه اعتبار منتقل می‌شود و سفارش‌های تاریخی به همین ردیف‌ها ارجاع می‌دهند.',
      resource: 'coupons',
    })
    if (facts.woo?.hasSubscriptions) {
      push({
        destination: '—',
        disposition: 'unsupported-blocking',
        label: 'اشتراک‌ها و پرداخت دوره‌ای',
        reason: 'توکن‌های پرداخت دوره‌ای کپی نمی‌شوند؛ نیاز به بازمجوزدهی نزد درگاه و تأیید جداگانه دارد.',
        resource: 'subscriptions',
      })
    }
  }

  for (const plugin of facts.plugins ?? []) {
    const rule = EXTENSION_RULES.find((candidate) => candidate.match.test(plugin))
    push({
      destination: rule ? 'طبق قاعده افزونه' : 'بازبینی دستی',
      disposition: rule?.disposition ?? 'requires-mapping',
      label: `افزونه: ${plugin}`,
      reason:
        rule?.reason ??
        'رفتار این افزونه هنوز دسته‌بندی نشده است؛ داده آن بدون دسته‌بندی وارد نمی‌شود و باید دستی تعیین تکلیف شود.',
      resource: `plugin:${plugin}`,
    })
  }

  return rows
}

/** The rows that must stop a production cutover until resolved or waived by a human. */
export const coverageBlockers = (rows: CoverageRow[]): CoverageRow[] =>
  rows.filter((row) => row.disposition === 'unsupported-blocking')
