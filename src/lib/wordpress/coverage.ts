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
 * Dispositions describe *destination readiness*, not importer progress: Woo
 * order history is `unsupported-blocking` until the multi-line commerce
 * model lands, because the honest alternative — flattening an order into one
 * product — is named out of scope by the issue itself. As later PRs land
 * (commerce model, connectors), rows move up this list deliberately, with
 * the mapping doc updated in the same change.
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
          destination: 'products (+مدل تجارت کامل)',
          disposition: facts.woo?.hasVariableProducts ? 'unsupported-blocking' : 'requires-mapping',
          label: 'محصولات ووکامرس',
          reason: facts.woo?.hasVariableProducts
            ? 'محصول متغیر با ویژگی/تنوع در مدل فعلی محصول جا نمی‌شود؛ تا PR مدل تجارت (تنوع/ویژگی/نگارخانه) ورود محصول متغیر متوقف می‌شود.'
            : 'محصول ساده به کاتالوگ می‌آید؛ قیمت، مالیات، موجودی و نگارخانه نیاز به نگاشت صریح واحد پول و وضعیت دارند.',
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
    destination: 'کاربران CMS (با بازبینی دستی نقش)',
    disposition: 'requires-mapping',
    label: 'نویسندگان و کارکنان وردپرس',
    reason: 'نویسنده روی رکوردها حفظ می‌شود؛ ساخت حساب کارکنان و نقش سایت تصمیم دستی مالک سایت است، نه ورود خودکار.',
    resource: 'wp-users',
  })
  push({
    destination: 'هنوز ساخته نشده — مشتری فروشگاه',
    disposition: 'unsupported-blocking',
    label: 'مشتریان فروشگاه و حساب مشتری',
    reason:
      'حساب مشتری فروشگاه نباید با کاربران مدیر CMS یکی شود و گذرواژه وردپرس قابل کپی نیست؛ تا مدل مشتری و فرایند مطالبه حساب ساخته شود، مهاجرت فروشگاهی با حساب مشتری متوقف است.',
    resource: 'customers',
  })

  if (inventory.hasWooCommerce) {
    push({
      destination: 'هنوز ساخته نشده — سفارش چندسطری',
      disposition: 'unsupported-blocking',
      label: 'سفارش‌ها، سطرها، بازپرداخت و مالیات ووکامرس',
      reason:
        'مدل فعلی سفارش ای‌شوب تک‌محصولی است؛ تخت‌کردن سفارش چندسطری از دست‌دادن تاریخچه مالی است. تا PR مدل تجارت (سطر سفارش/جمع‌بندی/بازپرداخت) تاریخچه سفارش منتقل نمی‌شود.',
      resource: 'orders',
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
