/**
 * The SaaS rulebook — the pure half.
 *
 * Everything here is arithmetic and policy with no Payload import, for the same
 * reason `src/lib/platform-control.ts` is split this way: a quota decision, a
 * proration, a feature resolution and a period roll are the parts that are worth
 * asserting directly, and they must not need a database to be testable.
 *
 * Three properties this module exists to keep:
 *
 *  - **A missing limit is unlimited, and a zero limit is unlimited too.** A plan
 *    that forgot to name a quota must not silently become a plan of zero pages —
 *    the failure mode of "deny by default" here is a customer who cannot publish,
 *    which is worse than a customer who published one page too many.
 *  - **Money stays in minor units, per currency, exactly as the store does.** An
 *    invoice snapshots the currency it was issued in; adding two currencies
 *    together invents a number (CLAUDE.md, the platform-control rules).
 *  - **A feature resolves in one direction only**: catalogue default → plan grant →
 *    per-site override. Anything else and "why is this shop seeing checkout?" has
 *    no answer.
 */

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

/**
 * Everything a plan can cap, and the only strings anything else may use.
 *
 * A typed tuple rather than free text: a misspelt metric in a plan row would
 * otherwise read as "no limit" forever, silently, on the paying customer's side.
 */
export const QUOTA_METRICS = [
  'pages',
  'posts',
  'products',
  'media',
  'mediaStorageMb',
  'categories',
  'users',
  'apiKeys',
  'ordersPerMonth',
  'apiRequestsPerMonth',
  'domains',
] as const

export type QuotaMetric = (typeof QUOTA_METRICS)[number]

export type QuotaLimits = Partial<Record<QuotaMetric, null | number>>
export type UsageCounts = Partial<Record<QuotaMetric, number>>

/** Persian label per metric — one table, used by the admin, the API and the console. */
export const QUOTA_LABELS: Record<QuotaMetric, string> = {
  apiKeys: 'کلیدهای API',
  apiRequestsPerMonth: 'درخواست API در ماه',
  categories: 'دسته‌بندی‌ها',
  domains: 'دامنه‌ها',
  media: 'فایل‌های رسانه',
  mediaStorageMb: 'فضای رسانه (مگابایت)',
  ordersPerMonth: 'سفارش در ماه',
  pages: 'برگه‌ها',
  posts: 'نوشته‌ها',
  products: 'محصولات',
  users: 'کاربران',
}

/** Metrics whose usage is a *window*, not a lifetime count. */
export const WINDOWED_METRICS: QuotaMetric[] = ['ordersPerMonth', 'apiRequestsPerMonth']

export const isQuotaMetric = (value: unknown): value is QuotaMetric =>
  typeof value === 'string' && (QUOTA_METRICS as readonly string[]).includes(value)

/**
 * `null` means unlimited — and so does `0`, a negative number and anything
 * unparseable.
 *
 * The `0` case is the one that matters in practice: Payload writes an empty number
 * field as `null`, but an admin who types `0` means "I did not set this", never "no
 * pages at all". A plan that can lock a paying customer out of their own site by a
 * blank field is not a plan, it is an outage.
 */
export const normalizeLimit = (raw: unknown): null | number => {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n)
}

export type QuotaLine = {
  /** `null` when the plan does not cap this metric. */
  limit: null | number
  metric: QuotaMetric
  label: string
  over: boolean
  /** `null` when unlimited — a percentage of infinity is not a number a UI can draw. */
  percent: null | number
  /** `null` when unlimited. Never negative. */
  remaining: null | number
  used: number
  /** Windowed metrics are counted over the current period, lifetime ones are not. */
  windowed: boolean
}

export type QuotaReport = {
  lines: QuotaLine[]
  /** The metrics that are over their limit, in the order they appear above. */
  exceeded: QuotaMetric[]
  /** True when at least one metric is at or past its limit. */
  over: boolean
  /** Metrics at or above `warnAt` (default 80%) but not yet over. */
  warning: QuotaMetric[]
}

/**
 * Usage against limits, as the one shape every caller renders — the admin
 * dashboard, `GET /api/platform/sites/:id/quota`, the enforcement hook and the
 * console all read this, so "is this site over?" has exactly one answer.
 */
export const buildQuotaReport = (
  limits: QuotaLimits,
  usage: UsageCounts,
  opts: { warnAt?: number } = {},
): QuotaReport => {
  const warnAt = typeof opts.warnAt === 'number' && opts.warnAt > 0 ? opts.warnAt : 0.8
  const lines: QuotaLine[] = []
  const exceeded: QuotaMetric[] = []
  const warning: QuotaMetric[] = []

  for (const metric of QUOTA_METRICS) {
    const limit = normalizeLimit(limits[metric])
    const used = Math.max(0, Math.trunc(Number(usage[metric] ?? 0)) || 0)
    const over = limit !== null && used > limit
    const percent = limit === null ? null : Math.round((used / limit) * 100)

    if (over) exceeded.push(metric)
    else if (limit !== null && percent !== null && percent >= warnAt * 100) warning.push(metric)

    lines.push({
      label: QUOTA_LABELS[metric],
      limit,
      metric,
      over,
      percent,
      remaining: limit === null ? null : Math.max(0, limit - used),
      used,
      windowed: WINDOWED_METRICS.includes(metric),
    })
  }

  return { exceeded, lines, over: exceeded.length > 0, warning }
}

/**
 * The question the enforcement hook asks before a create: "would one more of these
 * cross the line?"
 *
 * Unlimited answers `true` without reading usage at all, which is what keeps the
 * hook free on the overwhelming majority of writes.
 */
export const withinQuota = (
  limit: null | number | undefined,
  used: number,
  adding = 1,
): boolean => {
  const normalized = normalizeLimit(limit)
  if (normalized === null) return true
  return used + adding <= normalized
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export type FeatureSource = 'default' | 'plan' | 'site'

export type ResolvedFeature = {
  enabled: boolean
  key: string
  label: string
  /** Which of the three layers decided it — the whole point of the type. */
  source: FeatureSource
}

export type FeatureCatalogueEntry = {
  defaultEnabled: boolean
  key: string
  label?: null | string
}

/**
 * Catalogue default → plan grant → per-site override, in that order, last wins.
 *
 * The `source` on every answer is not decoration: "this shop has checkout because
 * its plan grants it" and "…because somebody ticked a box on the site" are
 * different facts, and the second one is the one an operator needs to find when a
 * customer downgrades and keeps a feature they no longer pay for.
 *
 * A key that only appears in `planFeatures` or `siteOverrides` — never in the
 * catalogue — still resolves. A feature flag created by a newer version of the
 * console must not vanish because this deployment's catalogue has not caught up.
 */
export const resolveFeatures = (args: {
  catalogue: FeatureCatalogueEntry[]
  planFeatures?: null | string[]
  siteOverrides?: null | { enabled: boolean; key: string }[]
}): ResolvedFeature[] => {
  const resolved = new Map<string, ResolvedFeature>()

  for (const entry of args.catalogue) {
    if (!entry?.key) continue
    resolved.set(entry.key, {
      enabled: entry.defaultEnabled === true,
      key: entry.key,
      label: entry.label?.trim() || entry.key,
      source: 'default',
    })
  }

  for (const key of args.planFeatures ?? []) {
    if (!key) continue
    const existing = resolved.get(key)
    resolved.set(key, {
      enabled: true,
      key,
      label: existing?.label ?? key,
      source: 'plan',
    })
  }

  for (const override of args.siteOverrides ?? []) {
    if (!override?.key) continue
    const existing = resolved.get(override.key)
    resolved.set(override.key, {
      enabled: override.enabled === true,
      key: override.key,
      label: existing?.label ?? override.key,
      source: 'site',
    })
  }

  return [...resolved.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** The map shape a client app actually consumes: `{ "store.checkout": true }`. */
export const featureMap = (features: ResolvedFeature[]): Record<string, boolean> =>
  Object.fromEntries(features.map((feature) => [feature.key, feature.enabled]))

// ---------------------------------------------------------------------------
// Billing periods
// ---------------------------------------------------------------------------

export type BillingInterval = 'monthly' | 'quarterly' | 'yearly' | 'lifetime'

export const INTERVAL_MONTHS: Record<Exclude<BillingInterval, 'lifetime'>, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

export const isBillingInterval = (value: unknown): value is BillingInterval =>
  value === 'monthly' || value === 'quarterly' || value === 'yearly' || value === 'lifetime'

/**
 * The end of a billing period that starts at `from`.
 *
 * Calendar months, not 30-day blocks: a customer billed on the 31st is billed on
 * the last day of a short month, not silently moved into the next one. `lifetime`
 * has no end, and saying so with `null` is what stops a renewal job from inventing
 * one.
 *
 * Deliberately UTC. The platform's own clock is UTC everywhere else (`createdAt`,
 * the event cursor), and a period boundary that moves with Tehran's DST would make
 * an invoice's window disagree with the rows it counted.
 */
export const periodEnd = (from: Date, interval: BillingInterval): Date | null => {
  if (interval === 'lifetime') return null
  const months = INTERVAL_MONTHS[interval]
  const year = from.getUTCFullYear()
  const month = from.getUTCMonth()
  const day = from.getUTCDate()
  const target = new Date(Date.UTC(year, month + months, 1))
  // Clamp to the target month's own length: 31 Jan + 1 month is 28/29 Feb, never 3 Mar.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), 0)
  return target
}

/** The current UTC calendar month as an inclusive/exclusive ISO pair — what a windowed metric counts over. */
export const currentMonthWindow = (now = new Date()): { end: string; start: string } => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { end: end.toISOString(), start: start.toISOString() }
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'pastDue'
  | 'suspended'
  | 'cancelled'
  | 'expired'

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'trialing',
  'active',
  'pastDue',
  'suspended',
  'cancelled',
  'expired',
]

export const isSubscriptionStatus = (value: unknown): value is SubscriptionStatus =>
  typeof value === 'string' && (SUBSCRIPTION_STATUSES as string[]).includes(value)

/**
 * Whether a subscription in this state should still be *serving*.
 *
 * `pastDue` is deliberately live: an unpaid invoice is a dunning problem, and
 * taking a customer's website down the hour a card fails is how a SaaS loses the
 * customer *and* the invoice. Suspension is an explicit operator action
 * (`status: 'suspended'`), which is also the one the site's own `status` field
 * already models.
 */
export const isEntitled = (status: unknown): boolean =>
  status === 'active' || status === 'trialing' || status === 'pastDue'

/** A subscription whose period has run out and which nothing has renewed. */
export const isExpired = (currentPeriodEnd: null | string | undefined, now = new Date()): boolean => {
  if (!currentPeriodEnd) return false
  const end = new Date(currentPeriodEnd)
  if (Number.isNaN(end.getTime())) return false
  return end.getTime() < now.getTime()
}

// ---------------------------------------------------------------------------
// Invoice arithmetic
// ---------------------------------------------------------------------------

export type InvoiceLineInput = {
  description?: null | string
  quantity?: null | number
  unitAmount?: null | number
}

export type InvoiceTotals = {
  discount: number
  lines: { amount: number; description: string; quantity: number; unitAmount: number }[]
  subtotal: number
  tax: number
  total: number
}

/**
 * Invoice totals, in minor units, from its lines.
 *
 * Integer arithmetic throughout: a float `unitAmount` is rounded *before* it is
 * multiplied, because `0.1 * 3` is the classic way an invoice ends in `…0.30000000000000004`
 * and a customer's receipt stops matching their bank statement. Tax is applied to
 * the discounted subtotal — the other order overcharges tax on money nobody paid.
 */
export const invoiceTotals = (
  lines: InvoiceLineInput[] | null | undefined,
  opts: { discount?: null | number; taxPercent?: null | number } = {},
): InvoiceTotals => {
  const rows = (lines ?? []).map((line) => {
    const quantity = Math.max(0, Math.trunc(Number(line?.quantity ?? 1)) || 0)
    const unitAmount = Math.max(0, Math.trunc(Number(line?.unitAmount ?? 0)) || 0)
    return {
      amount: quantity * unitAmount,
      description: String(line?.description ?? '').slice(0, 500),
      quantity,
      unitAmount,
    }
  })

  const subtotal = rows.reduce((sum, row) => sum + row.amount, 0)
  const discount = Math.min(subtotal, Math.max(0, Math.trunc(Number(opts.discount ?? 0)) || 0))
  const taxPercent = Math.max(0, Number(opts.taxPercent ?? 0) || 0)
  const taxable = subtotal - discount
  const tax = Math.round((taxable * taxPercent) / 100)

  return { discount, lines: rows, subtotal, tax, total: taxable + tax }
}

/**
 * `INV-1405-000123` — the human-readable side of an invoice.
 *
 * Sequence per year, zero-padded, and the *Gregorian* year deliberately: the number
 * is also a database key an operator greps, and a Jalali year here would be a
 * second calendar to reconcile. The Persian date belongs on the rendered invoice,
 * not in its identifier.
 */
export const invoiceNumber = (sequence: number, now = new Date()): string =>
  `INV-${now.getUTCFullYear()}-${String(Math.max(1, Math.trunc(sequence))).padStart(6, '0')}`

// ---------------------------------------------------------------------------
// Request parsing helpers shared by the SaaS routes
// ---------------------------------------------------------------------------

export const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/** A short, safe identifier: `[a-z0-9._-]`, lower-cased, never longer than 64. */
export const slugKey = (raw: unknown): string =>
  String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
