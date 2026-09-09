/**
 * The platform control surface — the pure half.
 *
 * `src/endpoints/platformControl.ts` is the API a platform operator drives this
 * whole deployment through from *outside* it: the sibling `cafe-restaurant-pos`
 * super-admin console («سایت‌ساز» section) holds the CMS's address and a
 * `role: "platform"` key, and every superadmin function and every fleet-wide
 * report it shows is one call into that surface. This file is everything in it
 * that does not need Payload — parameter clamping, the report arithmetic, the
 * shape of an event record, and the snapshot rules for syncing content in both
 * directions — so it can be asserted directly instead of through HTTP.
 *
 * Two properties this module exists to keep:
 *
 *  - **A report never scans an unbounded table.** Counts come from
 *    `payload.count`, but money has to be summed row by row (Payload has no
 *    aggregate and this codebase does not reach for raw SQL outside a
 *    migration), so every sum is windowed by `days` and capped by
 *    `ORDER_SCAN_CAP`. A truncated sum says so in the response rather than
 *    quietly under-reporting revenue.
 *  - **A snapshot carries content, never identity.** `site`, `id`, timestamps
 *    and Payload's internal bookkeeping are stripped on the way out, so a
 *    snapshot cannot re-parent a document onto another tenant when it is
 *    imported — the importing endpoint sets `site` from the site it was called
 *    for, the same rule `forceApiKeySite` applies to a site key's own writes.
 */

// ---------------------------------------------------------------------------
// Request parameters
// ---------------------------------------------------------------------------

/** Longest window a report may cover. A year of orders is a report; five is an export. */
export const MAX_REPORT_DAYS = 365

/** How many order rows a windowed money sum will read before it gives up and says so. */
export const ORDER_SCAN_CAP = 5_000

export const clampReportDays = (raw: unknown, fallback = 30): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), 1), MAX_REPORT_DAYS)
}

export const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), 1), max)
}

export const clampPage = (raw: unknown): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.max(Math.trunc(n), 1)
}

/**
 * `?since=` on the event feed: an ISO instant the caller last saw.
 *
 * Clamped to 30 days back and never to the future — the feed is a tail for a log
 * shipper, not an archive, and a client whose clock is ahead must not be able to
 * ask for an empty answer forever.
 */
export const parseSince = (raw: unknown, now = new Date(), maxDays = 30): Date => {
  const floor = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000)
  if (typeof raw !== 'string' || !raw.trim()) return floor
  const parsed = new Date(raw.trim())
  if (Number.isNaN(parsed.getTime())) return floor
  if (parsed.getTime() < floor.getTime()) return floor
  if (parsed.getTime() > now.getTime()) return now
  return parsed
}

// ---------------------------------------------------------------------------
// Money in a report
// ---------------------------------------------------------------------------

/**
 * Sums stay per currency and in minor units, always.
 *
 * A site snapshots the currency it sold in onto each order (CLAUDE.md: "an order
 * snapshots both price *and* currency"), so a deployment holds orders in several
 * currencies at once and adding them together would invent a number. The console
 * renders one line per currency for the same reason.
 */
export type CurrencyTotals = Record<string, { minorTotal: number; orders: number }>

export type ScannedOrder = { currency?: unknown; total?: unknown }

export const accumulateOrderTotals = (
  rows: readonly ScannedOrder[],
  into: CurrencyTotals = {},
): CurrencyTotals => {
  for (const row of rows) {
    const currency = typeof row.currency === 'string' && row.currency ? row.currency : 'unknown'
    const total = Number(row.total)
    const bucket = (into[currency] ??= { minorTotal: 0, orders: 0 })
    bucket.orders += 1
    if (Number.isFinite(total)) bucket.minorTotal += Math.trunc(total)
  }
  return into
}

/** `[{ code, minorTotal, orders }]`, biggest first — a stable order for a table. */
export const currencyRows = (
  totals: CurrencyTotals,
): { code: string; minorTotal: number; orders: number }[] =>
  Object.entries(totals)
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => b.minorTotal - a.minorTotal || a.code.localeCompare(b.code))

/** `[{ value, count }]` from a list of statuses/types — what every "by X" chip row is built from. */
export const tally = (values: readonly (string | null | undefined)[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const value of values) {
    const key = value && String(value) ? String(value) : 'unknown'
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Site lifecycle patch
// ---------------------------------------------------------------------------

export const SITE_TYPES = ['business', 'portfolio', 'store'] as const
export const SITE_STATUSES = ['active', 'suspended', 'archived'] as const

export type SitePatchResult = {
  data: Record<string, unknown>
  errors: string[]
}

/**
 * What an operator may change about a site from outside the admin UI.
 *
 * An allowlist rather than a pass-through of the request body: `Sites` also holds
 * `domain` (whose one write path is `PATCH /api/site/domain`, so that a domain
 * move keeps resetting `domainVerified` and re-checking uniqueness) and a slug
 * that other documents point at. Everything here is the lifecycle an operator
 * actually administers — is it on, what is it called, which locales does it
 * serve, has its DNS been checked.
 */
export const parseSitePatch = (body: unknown): SitePatchResult => {
  const input = (body ?? {}) as Record<string, unknown>
  const data: Record<string, unknown> = {}
  const errors: string[] = []

  if ('name' in input) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 120) errors.push('نام سایت باید بین ۱ تا ۱۲۰ نویسه باشد.')
    else data.name = name
  }

  if ('type' in input) {
    if (!SITE_TYPES.includes(input.type as (typeof SITE_TYPES)[number])) {
      errors.push('نوع سایت نامعتبر است.')
    } else data.type = input.type
  }

  if ('status' in input) {
    if (!SITE_STATUSES.includes(input.status as (typeof SITE_STATUSES)[number])) {
      errors.push('وضعیت سایت نامعتبر است.')
    } else data.status = input.status
  }

  if ('domainVerified' in input) {
    if (typeof input.domainVerified !== 'boolean') errors.push('تأیید دامنه باید بله/خیر باشد.')
    else data.domainVerified = input.domainVerified
  }

  if ('availableLocales' in input) {
    const list = Array.isArray(input.availableLocales) ? input.availableLocales : null
    if (!list || list.length === 0 || list.some((code) => typeof code !== 'string')) {
      errors.push('فهرست زبان‌ها نامعتبر است.')
    } else data.availableLocales = list
  }

  if ('defaultLocale' in input) {
    if (typeof input.defaultLocale !== 'string' || !input.defaultLocale.trim()) {
      errors.push('زبان پیش‌فرض نامعتبر است.')
    } else data.defaultLocale = input.defaultLocale.trim()
  }

  if ('domains' in input) {
    const list = Array.isArray(input.domains) ? input.domains : null
    if (!list) errors.push('فهرست دامنه‌های فرعی نامعتبر است.')
    else {
      const rows = list.map((row) => {
        const item = (row ?? {}) as Record<string, unknown>
        return {
          ...(typeof item.id === 'string' ? { id: item.id } : {}),
          hostname: typeof item.hostname === 'string' ? item.hostname.trim() : '',
          verified: item.verified === true,
        }
      })
      if (rows.some((row) => !row.hostname)) errors.push('هر دامنهٔ فرعی باید یک میزبان داشته باشد.')
      else data.domains = rows
    }
  }

  if (Object.keys(data).length === 0 && errors.length === 0) {
    errors.push('چیزی برای تغییر ارسال نشده است.')
  }

  return { data, errors }
}

// ---------------------------------------------------------------------------
// The event feed
// ---------------------------------------------------------------------------

/**
 * One record of the tail the POS ships into OpenObserve.
 *
 * `id` is what makes the shipper idempotent: the POS keeps the newest `at` it has
 * seen as a cursor and drops any `id` it already sent, so a re-poll of an
 * overlapping window (which is what a cursor with second granularity guarantees)
 * cannot double-count. `level` is the log level the record will carry there, so
 * the log store's own level filter means the same thing for CMS events as for
 * everything else in the stream.
 */
export type ControlEventKind =
  | 'domain.unverified'
  | 'gateway.selftest'
  | 'key.issued'
  | 'order.placed'
  | 'site.changed'
  | 'site.suspended'

export type ControlEvent = {
  at: string
  data?: Record<string, unknown>
  id: string
  kind: ControlEventKind
  level: 'error' | 'info' | 'warn'
  message: string
  siteDomain: null | string
  siteId: null | string
}

/** Newest first, `id` breaking a tie so a page boundary is deterministic. */
export const compareEventsDesc = (a: ControlEvent, b: ControlEvent): number =>
  b.at.localeCompare(a.at) || b.id.localeCompare(a.id)

// ---------------------------------------------------------------------------
// Snapshots (sync in both directions)
// ---------------------------------------------------------------------------

/**
 * The collections a snapshot may carry, and how each one is matched on import.
 *
 * `slug` collections are upserted by `{ site, slug }` — the same key the CMS's own
 * per-site uniqueness hook enforces, so an import is a second edit of the same
 * document rather than a duplicate of it. `singleton` collections are the per-site
 * `isGlobal: true` rows: exactly one exists per site, so there is nothing to match
 * on and the row is updated in place.
 */
export const SNAPSHOT_COLLECTIONS = {
  categories: 'slug',
  footer: 'singleton',
  header: 'singleton',
  pages: 'slug',
  posts: 'slug',
  products: 'slug',
  store: 'singleton',
  theme: 'singleton',
} as const

export type SnapshotCollection = keyof typeof SNAPSHOT_COLLECTIONS

export const snapshotCollections = Object.keys(SNAPSHOT_COLLECTIONS) as SnapshotCollection[]

export const isSnapshotCollection = (value: unknown): value is SnapshotCollection =>
  typeof value === 'string' && value in SNAPSHOT_COLLECTIONS

/**
 * `?collections=posts,products` → the subset, deduped and in a stable order.
 * Anything unrecognised is *rejected* rather than ignored: a typo that silently
 * exported nothing is how an operator ends up believing they have a backup.
 */
export const parseSnapshotCollections = (
  raw: unknown,
): { collections: SnapshotCollection[]; unknown: string[] } => {
  const parts =
    typeof raw === 'string'
      ? raw.split(',')
      : Array.isArray(raw)
        ? raw.map((v) => String(v))
        : []
  const wanted = parts.map((p) => p.trim()).filter(Boolean)
  if (wanted.length === 0) return { collections: snapshotCollections, unknown: [] }
  const unknown = wanted.filter((name) => !isSnapshotCollection(name))
  const collections = snapshotCollections.filter((name) => wanted.includes(name))
  return { collections, unknown }
}

/**
 * Payload's own bookkeeping and the document's tenant, removed.
 *
 * `site` is the important one — see this module's header. `id`, `createdAt`,
 * `updatedAt` go because the importing deployment owns them; `_status` stays,
 * because an operator restoring a snapshot must get the published/draft state
 * back exactly as it was (an import that silently unpublished a live site would
 * be a worse outcome than refusing the import).
 */
export const stripSnapshotFields = (doc: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'id' || key === 'site' || key === 'createdAt' || key === 'updatedAt') continue
    if (key === 'sizes' || key === 'tenant') continue
    out[key] = value
  }
  return out
}

/** How many documents a snapshot holds, per collection — what both sides show as the summary. */
export const snapshotCounts = (
  snapshot: Partial<Record<SnapshotCollection, unknown>>,
): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const name of snapshotCollections) {
    const value = snapshot[name]
    if (value === undefined) continue
    out[name] = Array.isArray(value) ? value.length : value === null ? 0 : 1
  }
  return out
}

export type ImportPlanRow = {
  action: 'create' | 'skip' | 'update'
  collection: SnapshotCollection
  key: null | string
  reason?: string
}

/** A dry run and a real run agree because both are this function's output. */
export const summarizeImportPlan = (
  rows: readonly ImportPlanRow[],
): { created: number; skipped: number; updated: number } => ({
  created: rows.filter((r) => r.action === 'create').length,
  skipped: rows.filter((r) => r.action === 'skip').length,
  updated: rows.filter((r) => r.action === 'update').length,
})
