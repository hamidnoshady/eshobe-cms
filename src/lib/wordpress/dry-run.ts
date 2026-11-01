import type { CoverageRow } from './coverage'
import { coverageBlockers } from './coverage'
import type { SourceInventory } from './discovery'
import { contentHashOf, decimalStringToMinor, MappingError, sourceRecordKey } from './mapping'

/**
 * The dry-run report (issue #166 step 5, "never silently skip").
 *
 * Pure and write-free: given an inventory, its coverage matrix and a batch of
 * sampled raw records, it says *exactly* what a real import would do with
 * each record — create, update, leave unchanged, archive, block, or fail —
 * plus the unknowns it found (unmapped meta keys, order totals that do not
 * reconcile). The wizard renders this before any write; the importer will
 * later be held to the same accounting (imported + archived + blocked +
 * errored ≡ seen, per resource).
 */

export const KNOWN_WP_META_KEYS = new Set([
  '_edit_last',
  '_edit_lock',
  '_encloseme',
  '_pingme',
  '_thumbnail_id',
  '_wp_old_date',
  '_wp_old_slug',
  '_wp_page_template',
])

export type DryRunSample = {
  records: Record<string, unknown>[]
  /** e.g. `post-type:portfolio`, `taxonomy:genre`, `product`, `orders`, `media` */
  resource: string
}

export type DryRunResourceReport = {
  archived: number
  blocked: number
  errors: { message: string; sourceId: string }[]
  resource: string
  seen: number
  unchanged: number
  wouldCreate: number
  wouldUpdate: number
}

export type DryRunReport = {
  blockers: string[]
  installation: string
  moneyChecks: { message: string; ok: boolean; orderSourceId: string }[]
  readyToImport: boolean
  resources: DryRunResourceReport[]
  siteId: string
  unknownMetaKeysByResource: Record<string, string[]>
}

const sourceIdOf = (record: Record<string, unknown>): string | null => {
  const id = record.id ?? record.ID

  return typeof id === 'number' || (typeof id === 'string' && id) ? String(id) : null
}

const metaKeysOf = (record: Record<string, unknown>): string[] => {
  const keys: string[] = []
  const meta = record.meta
  const acf = record.acf

  if (meta && typeof meta === 'object' && !Array.isArray(meta)) keys.push(...Object.keys(meta))
  if (acf && typeof acf === 'object' && !Array.isArray(acf)) keys.push(...Object.keys(acf))

  return keys
}

/**
 * Reconcile one Woo order's money: Σ line subtotals − discount + shipping +
 * tax + fees ≡ total, in exact minor units at the source's decimals. A
 * mismatch is not "close enough" — it is listed, and it blocks.
 */
const checkOrderMoney = (
  order: Record<string, unknown>,
  sourceDecimals: number,
): { message: string; ok: boolean; orderSourceId: string } => {
  const orderSourceId = sourceIdOf(order) ?? '?'

  try {
    const minor = (value: unknown): number => decimalStringToMinor((value ?? '0') as string, sourceDecimals)
    const lines = Array.isArray(order.line_items) ? (order.line_items as Record<string, unknown>[]) : []
    const fees = Array.isArray(order.fee_lines) ? (order.fee_lines as Record<string, unknown>[]) : []
    const computed =
      lines.reduce((sum, line) => sum + minor(line.subtotal), 0) -
      minor(order.discount_total) +
      minor(order.shipping_total) +
      minor(order.total_tax) +
      fees.reduce((sum, fee) => sum + minor(fee.total), 0)
    const declared = minor(order.total)

    return computed === declared
      ? { message: 'جمع سطرها، تخفیف، ارسال و مالیات با مبلغ کل برابر است.', ok: true, orderSourceId }
      : {
          message: `مبلغ محاسباتی ${computed} با مبلغ کل مبدأ ${declared} (واحد خرد) برابر نیست.`,
          ok: false,
          orderSourceId,
        }
  } catch (error) {
    return {
      message:
        error instanceof MappingError
          ? error.message
          : 'مبالغ سفارش خوانا نیستند و تطبیق داده نشدند.',
      ok: false,
      orderSourceId,
    }
  }
}

export const buildDryRunReport = ({
  coverage,
  existingHashes = new Map<string, string>(),
  installation,
  inventory,
  knownMetaKeys = KNOWN_WP_META_KEYS,
  samples,
  siteId,
  sourceDecimals = 2,
}: {
  coverage: CoverageRow[]
  /** Idempotency key → stored content hash, as a previous run recorded. */
  existingHashes?: Map<string, string>
  installation: string
  inventory: SourceInventory
  knownMetaKeys?: Set<string>
  samples: DryRunSample[]
  siteId: string
  sourceDecimals?: number
}): DryRunReport => {
  const dispositionByResource = new Map(coverage.map((row) => [row.resource, row.disposition]))
  const blockers: string[] = [
    ...inventory.warnings.filter((w) => w.severity === 'blocking').map((w) => w.message),
    ...coverageBlockers(coverage).map((row) => `${row.label}: ${row.reason}`),
  ]
  const unknownMetaKeysByResource: Record<string, string[]> = {}
  const moneyChecks: DryRunReport['moneyChecks'] = []

  const resources = samples.map(({ records, resource }) => {
    const report: DryRunResourceReport = {
      archived: 0,
      blocked: 0,
      errors: [],
      resource,
      seen: records.length,
      unchanged: 0,
      wouldCreate: 0,
      wouldUpdate: 0,
    }
    const disposition = dispositionByResource.get(resource)
    const unknown = new Set<string>()

    for (const record of records) {
      const sourceId = sourceIdOf(record)

      if (!sourceId) {
        report.errors.push({ message: 'رکورد شناسه مبدأ ندارد؛ بدون شناسه، ورود بدون تکرار ممکن نیست.', sourceId: '?' })
        continue
      }

      for (const key of metaKeysOf(record)) {
        if (!knownMetaKeys.has(key)) unknown.add(key)
      }

      if (disposition === 'unsupported-blocking') {
        report.blocked += 1
        continue
      }
      if (disposition === 'archive-only') {
        report.archived += 1
        continue
      }

      const key = sourceRecordKey({ installation, resourceType: resource, siteId, sourceId })
      const known = existingHashes.get(key)

      if (known === undefined) report.wouldCreate += 1
      else if (known === contentHashOf(record)) report.unchanged += 1
      else report.wouldUpdate += 1

      if (resource === 'orders') moneyChecks.push(checkOrderMoney(record, sourceDecimals))
    }

    if (unknown.size) unknownMetaKeysByResource[resource] = [...unknown].sort()

    return report
  })

  for (const check of moneyChecks) {
    if (!check.ok) blockers.push(`سفارش مبدأ ${check.orderSourceId}: ${check.message}`)
  }

  return {
    blockers,
    installation,
    moneyChecks,
    readyToImport: blockers.length === 0,
    resources,
    siteId,
    unknownMetaKeysByResource,
  }
}
