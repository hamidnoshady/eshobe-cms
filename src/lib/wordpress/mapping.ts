import { createHash } from 'node:crypto'

import type { EntryStatus } from '@/lib/entry-status'
import { currencies, isCurrencyCode, rialToToman } from '@/lib/money'

/**
 * Field-level source→target mapping primitives (issue #166 §4).
 *
 * Every function here is total and explicit: it either converts exactly or
 * throws a coded error the dry-run report can show. The two rules that matter
 * most:
 *
 * - **Money is never a float and never guessed.** WooCommerce prices are
 *   decimal strings in the *source store's* currency with a configured number
 *   of decimals; Eshobe stores integer minor units of the *site's* currency
 *   (`src/lib/money.ts`). Conversion parses the string with `BigInt`, refuses
 *   precision loss, and refuses the Rial↔Toman step unless the operator has
 *   confirmed which Iranian unit the source numbers are in — a silent 10×
 *   error is the failure this module exists to prevent.
 * - **Source slugs are preserved verbatim.** A legacy URL is SEO capital; the
 *   importer must not re-slugify a Persian slug into a different one. Shape is
 *   validated (no path separators, no control characters), spelling is not.
 */

export class MappingError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MappingError'
    this.code = code
  }
}

/**
 * WordPress `post_status` → entry status. `auto-draft`/`inherit` are
 * WordPress internals with no visitor-visible meaning: they archive, they do
 * not import as content.
 */
export const mapWordPressStatus = (
  status: string,
): { disposition: 'archive-only' | 'import'; original: string; target: EntryStatus | null } => {
  switch (status) {
    case 'publish':
      return { disposition: 'import', original: status, target: 'published' }
    case 'draft':
      return { disposition: 'import', original: status, target: 'draft' }
    case 'pending':
      return { disposition: 'import', original: status, target: 'pending' }
    case 'private':
      return { disposition: 'import', original: status, target: 'private' }
    case 'future':
      return { disposition: 'import', original: status, target: 'scheduled' }
    case 'trash':
      return { disposition: 'import', original: status, target: 'trash' }
    case 'auto-draft':
    case 'inherit':
      return { disposition: 'archive-only', original: status, target: null }
    default:
      // A plugin-registered status is preserved as a draft with its original
      // name on the record — visible and re-mappable, never silently public.
      return { disposition: 'import', original: status, target: 'draft' }
  }
}

/**
 * WooCommerce order status → the closest Eshobe order status, for the future
 * commerce import. `lossy` marks mappings where Woo separates payment from
 * fulfilment (`processing`/`completed`) and Eshobe's current model does not:
 * the original must ride in provenance until the commerce model grows a
 * fulfilment state. History imports stay blocked until then (coverage).
 */
export const mapWooOrderStatus = (
  status: string,
): { lossy: boolean; original: string; target: 'cancelled' | 'paid' | 'pending' | 'refunded' } => {
  switch (status) {
    case 'pending':
    case 'on-hold':
      return { lossy: status === 'on-hold', original: status, target: 'pending' }
    case 'processing':
    case 'completed':
      return { lossy: true, original: status, target: 'paid' }
    case 'cancelled':
    case 'failed':
    case 'trash':
    case 'checkout-draft':
      return { lossy: status !== 'cancelled', original: status, target: 'cancelled' }
    case 'refunded':
      return { lossy: false, original: status, target: 'refunded' }
    default:
      return { lossy: true, original: status, target: 'pending' }
  }
}

/**
 * Exact decimal-string → minor-units conversion (`"12.30"`, 2 → `1230`).
 * Fractions longer than `decimals` are allowed only when the excess digits
 * are all zeros (Woo happily emits `"120000.00"` for a 0-decimal currency);
 * anything else would be rounding money, which is refused by name.
 */
export const decimalStringToMinor = (value: number | string, decimals: number): number => {
  const text = String(value).trim()

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MappingError('NOT_A_DECIMAL', `مبلغ «${text}» عدد اعشاری معتبر نیست.`)
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    throw new MappingError('BAD_DECIMALS', 'تعداد رقم اعشار واحد پول مبدأ معتبر نیست.')
  }

  const negative = text.startsWith('-')
  const [whole = '0', fractionRaw = ''] = (negative ? text.slice(1) : text).split('.')

  if (fractionRaw.length > decimals && /[^0]/.test(fractionRaw.slice(decimals))) {
    throw new MappingError(
      'PRECISION_LOSS',
      `مبلغ «${text}» دقیق‌تر از واحد خرد مقصد است و بدون گرد کردن قابل تبدیل نیست.`,
    )
  }

  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, '0')
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || '0')
  const signed = negative ? -minor : minor

  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MappingError('AMOUNT_TOO_LARGE', 'مبلغ از دامنه امن عدد صحیح بزرگ‌تر است.')
  }

  return Number(signed)
}

export type WooMoneyConversion = {
  /** The operator confirmed the source amounts are Rial and the site prices in Toman. */
  confirmedRialToToman?: boolean
  sourceCurrency: string
  /** Woo's configured price decimals for the source store. */
  sourceDecimals: number
  targetCurrency: string
  value: number | string
}

/**
 * One Woo amount → Eshobe integer minor units. Same-currency only, except the
 * one Iranian step the platform understands (IRR→IRT, confirmed, exact).
 */
export const convertWooMoney = ({
  confirmedRialToToman = false,
  sourceCurrency,
  sourceDecimals,
  targetCurrency,
  value,
}: WooMoneyConversion): number => {
  const source = sourceCurrency.toUpperCase()
  const target = targetCurrency.toUpperCase()

  if (!isCurrencyCode(source) || !isCurrencyCode(target)) {
    throw new MappingError(
      'UNSUPPORTED_CURRENCY',
      `تبدیل «${sourceCurrency}» به «${targetCurrency}» پشتیبانی نمی‌شود؛ واحد پول سایت را با فروشگاه مبدأ هم‌خوان کنید.`,
    )
  }

  if (source === target) {
    if (sourceDecimals !== currencies[target].minorDigits) {
      throw new MappingError(
        'DECIMAL_MISMATCH',
        'تعداد اعشار قیمت در ووکامرس با واحد خرد سایت مقصد هم‌خوان نیست؛ نگاشت باید صریح بازبینی شود.',
      )
    }
    return decimalStringToMinor(value, sourceDecimals)
  }

  if (source === 'IRR' && target === 'IRT') {
    if (!confirmedRialToToman) {
      throw new MappingError(
        'RIAL_NOT_CONFIRMED',
        'مبالغ مبدأ ریالی است و سایت تومانی؛ تبدیل ریالی فقط با تأیید صریح اپراتور انجام می‌شود.',
      )
    }
    if (sourceDecimals !== 0) {
      throw new MappingError('DECIMAL_MISMATCH', 'مبلغ ریالی اعشار ندارد؛ تنظیم اعشار ووکامرس را بررسی کنید.')
    }
    try {
      return rialToToman(decimalStringToMinor(value, 0))
    } catch {
      throw new MappingError('NOT_WHOLE_TOMAN', 'مبلغ ریالی مضرب ۱۰ نیست و به تومانِ کامل تبدیل نمی‌شود.')
    }
  }

  throw new MappingError(
    'UNSUPPORTED_CONVERSION',
    `تبدیل خودکار «${source}» به «${target}» انجام نمی‌شود؛ نرخ تبدیل پول داده مهاجرت نیست.`,
  )
}

/**
 * Preserve a source slug exactly (percent-decoded, NFC). Throws when the
 * value cannot be one URL segment — the importer records that row as an
 * exception instead of inventing a replacement URL.
 */
export const preserveWordPressSlug = (raw: unknown): string => {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MappingError('EMPTY_SLUG', 'پیوسته‌نام مبدأ خالی است.')
  }

  let slug = raw.trim()
  try {
    slug = decodeURIComponent(slug)
  } catch {
    throw new MappingError('BAD_SLUG_ENCODING', 'کدگذاری پیوسته‌نام مبدأ معتبر نیست.')
  }

  slug = slug.normalize('NFC')

  // One segment, no controls, no URL syntax. Script/letters are untouched.
  if (/[/\\?#\u0000-\u001f\u007f]/.test(slug) || /\s/.test(slug)) {
    throw new MappingError('BAD_SLUG', `پیوسته‌نام «${slug}» یک بخشِ نشانی معتبر نیست.`)
  }

  return slug
}

/**
 * A WP REST date pair → one UTC instant. `date` is the *site timezone*
 * wall-clock with no offset, so `date_gmt` wins whenever WordPress provides
 * it; falling back to the wall-clock read as UTC is flagged by the caller via
 * provenance, never silently "corrected".
 */
export const wpRestDateToIso = (record: {
  date?: unknown
  date_gmt?: unknown
  modified?: unknown
  modified_gmt?: unknown
}, field: 'date' | 'modified' = 'date'): string => {
  const gmt = record[`${field}_gmt`]
  const local = record[field]
  const candidate = typeof gmt === 'string' && gmt ? gmt : local

  if (typeof candidate !== 'string' || !candidate) {
    throw new MappingError('MISSING_DATE', 'تاریخ رکورد مبدأ خالی است.')
  }

  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(candidate) ? candidate : `${candidate}Z`
  const time = Date.parse(withZone)

  if (Number.isNaN(time)) {
    throw new MappingError('BAD_DATE', `تاریخ «${candidate}» خوانا نیست.`)
  }

  return new Date(time).toISOString()
}

/** Deterministic JSON (sorted keys) so equal payloads hash equally. */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Content hash for idempotent re-import: same source bytes → same hash. */
export const contentHashOf = (raw: unknown): string =>
  createHash('sha256').update(stableStringify(raw)).digest('hex')

/**
 * The idempotency key of one source record on one site:
 * `(site, source installation, resource type, source id)` — the composite the
 * issue requires for replay-safe upserts. Segments are URI-encoded so a
 * source id containing separators cannot collide with a different split.
 */
export const sourceRecordKey = ({
  installation,
  resourceType,
  siteId,
  sourceId,
}: {
  installation: string
  resourceType: string
  siteId: string
  sourceId: number | string
}): string =>
  [siteId, installation, resourceType, String(sourceId)].map(encodeURIComponent).join('|')
