import type { PayloadRequest } from 'payload'

import type { MigrationJob, MigrationSource, Site } from '@/payload-types'
import type { SiteStaffRole } from '@/deploy/tenantSettings'
import { idOf, isUuid } from '@/lib/ids'
import { isCurrencyCode } from '@/lib/money'

import { asRecord, type Loose } from './context'

/**
 * The sanitized read model behind «مرکز مهاجرت» and its endpoints.
 *
 * The collections stay the system of record; this module decides what a
 * browser may see. Source credentials are represented only by the stored
 * fingerprint summary, raw source payloads never leave the ledger, and job
 * settings pass through the same allowlist on the way in and out — a setting
 * the engine does not understand cannot be smuggled into a job row by a
 * hand-written request.
 */

export const canManageMigration = (role: null | SiteStaffRole): boolean =>
  role === 'owner' || role === 'platform'

const BOOLEAN_SETTINGS = [
  'allowCommerceOnNonStoreSite',
  'applyRedirects',
  'confirmedRialToToman',
  'includeComments',
  'includeContent',
  'includeCoupons',
  'includeCustomers',
  'includeMedia',
  'includeMenus',
  'includeOrders',
  'includeProducts',
] as const

export const sanitizeMigrationSettings = (
  input: unknown,
): { errors: string[]; settings: Record<string, unknown> } => {
  const raw = asRecord(input)
  const settings: Record<string, unknown> = {}
  const errors: string[] = []

  for (const key of BOOLEAN_SETTINGS) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'boolean') settings[key] = raw[key]
    else errors.push(`تنظیم «${key}» باید بله/خیر باشد.`)
  }

  for (const key of ['sourceCurrency', 'targetCurrency'] as const) {
    if (raw[key] === undefined || raw[key] === '') continue
    const value = String(raw[key]).trim().toUpperCase()
    if (isCurrencyCode(value)) settings[key] = value
    else errors.push('کد واحد پول معتبر نیست.')
  }

  if (raw.sourceDecimals !== undefined && raw.sourceDecimals !== '') {
    const value = Number(raw.sourceDecimals)
    if (Number.isInteger(value) && value >= 0 && value <= 4) settings.sourceDecimals = value
    else errors.push('تعداد اعشار ووکامرس باید عددی میان ۰ تا ۴ باشد.')
  }

  if (raw.locale !== undefined && raw.locale !== '') {
    const value = String(raw.locale).trim()
    if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(value)) settings.locale = value
    else errors.push('کد زبان معتبر نیست.')
  }

  if (raw.modifiedAfter !== undefined && raw.modifiedAfter !== '') {
    const time = Date.parse(String(raw.modifiedAfter))
    if (Number.isFinite(time)) settings.modifiedAfter = new Date(time).toISOString()
    else errors.push('مرز زمانی هم‌گام‌سازی معتبر نیست.')
  }

  for (const key of ['rollbackJobId', 'targetJobId'] as const) {
    if (raw[key] === undefined || raw[key] === '') continue
    if (isUuid(String(raw[key]))) settings[key] = String(raw[key])
    else errors.push('شناسه کار بازگشت معتبر نیست.')
  }

  return { errors, settings }
}

const sourceView = (source: MigrationSource) => ({
  baseUrl: source.baseUrl,
  coverage: source.coverage ?? [],
  createdAt: source.createdAt,
  credentialsSummary: source.credentialsSummary ?? null,
  id: String(source.id),
  inventory: source.inventory ?? null,
  lastCheckedAt: source.lastCheckedAt ?? null,
  lastError: source.lastError ?? null,
  name: source.name,
  status: source.status,
  updatedAt: source.updatedAt,
  wpUsername: source.wpUsername ?? null,
})

const jobView = (job: MigrationJob) => ({
  blockers: Array.isArray(job.blockers) ? job.blockers : [],
  counts: job.counts ?? {},
  coverage: job.coverage ?? [],
  createdAt: job.createdAt,
  cutoverAt: job.cutoverAt ?? null,
  dryRunReport: job.dryRunReport ?? null,
  finishedAt: job.finishedAt ?? null,
  id: String(job.id),
  inventory: job.inventory ?? null,
  lastError: job.lastError ?? null,
  lastSyncAt: job.lastSyncAt ?? null,
  operation: job.operation,
  phase: job.phase ?? null,
  reconciliationReport: job.reconciliationReport ?? null,
  rolledBackAt: job.rolledBackAt ?? null,
  settings: sanitizeMigrationSettings(job.settings).settings,
  sourceId: idOf(job.source),
  sourceWriteFenceConfirmedAt: job.sourceWriteFenceConfirmedAt ?? null,
  startedAt: job.startedAt ?? null,
  status: job.status,
  summary: job.summary ?? {},
  title: job.title,
  updatedAt: job.updatedAt,
})

const briefEvent = (doc: Loose) => ({
  createdAt: doc.createdAt ?? null,
  eventType: doc.eventType ?? null,
  id: String(doc.id),
  level: doc.level ?? null,
  message: doc.message ?? null,
  resource: doc.resource ?? null,
  sourceRecordId: doc.sourceRecordId ?? null,
})

const briefError = (doc: Loose) => ({
  attempts: doc.attempts ?? null,
  code: doc.code ?? null,
  createdAt: doc.createdAt ?? null,
  id: String(doc.id),
  message: doc.message ?? null,
  resource: doc.resource ?? null,
  retryable: doc.retryable ?? null,
  sourceRecordId: doc.sourceRecordId ?? null,
  status: doc.status ?? null,
})

const briefAudit = (doc: Loose) => ({
  action: doc.action ?? null,
  createdAt: doc.createdAt ?? null,
  id: String(doc.id),
  summary: doc.summary ?? null,
})

const briefMapping = (doc: Loose) => ({
  destination: doc.destination ?? null,
  disposition: doc.disposition ?? null,
  id: String(doc.id),
  reason: doc.reason ?? null,
  resource: doc.resource ?? null,
  sourceField: doc.sourceField ?? null,
  status: doc.status ?? null,
})

const countWhere = async (
  req: PayloadRequest,
  collection: string,
  where: Loose,
): Promise<number> => {
  const { totalDocs } = await req.payload.count({
    collection: collection as never,
    overrideAccess: true,
    req,
    where: where as never,
  })

  return totalDocs
}

export type MigrationCenterView = Awaited<ReturnType<typeof migrationCenterView>>

export const migrationCenterView = async (
  req: PayloadRequest,
  siteId: string,
  role: null | SiteStaffRole,
) => {
  const site = (await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: siteId,
    overrideAccess: true,
    req,
  })) as Site | null
  const siteWhere = { site: { equals: siteId } }
  const [sources, jobs, errors, events, audits, mappings] = await Promise.all([
    req.payload.find({
      collection: 'migration-sources',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      pagination: false,
      req,
      sort: '-updatedAt',
      where: siteWhere,
    }),
    req.payload.find({
      collection: 'migration-jobs',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      pagination: false,
      req,
      sort: '-updatedAt',
      where: siteWhere,
    }),
    req.payload.find({
      collection: 'migration-errors',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      pagination: false,
      req,
      sort: '-updatedAt',
      where: { and: [siteWhere, { status: { equals: 'open' } }] },
    }),
    req.payload.find({
      collection: 'migration-events',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      pagination: false,
      req,
      sort: '-createdAt',
      where: siteWhere,
    }),
    req.payload.find({
      collection: 'migration-audits',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      pagination: false,
      req,
      sort: '-createdAt',
      where: siteWhere,
    }),
    req.payload.find({
      collection: 'migration-mappings',
      depth: 0,
      limit: 100,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'resource',
      where: siteWhere,
    }),
  ])
  const dispositions = [
    'archived',
    'blocked',
    'deleted',
    'error',
    'imported',
    'planned',
    'rolled-back',
    'unchanged',
    'updated',
  ] as const
  const redirectStatuses = [
    'applied',
    'conflict',
    'ignored',
    'proposed',
    'rolled-back',
    'unchanged',
  ] as const
  const [recordCounts, redirectCounts] = await Promise.all([
    Promise.all(
      dispositions.map(async (disposition) => [
        disposition,
        await countWhere(req, 'migration-records', {
          and: [siteWhere, { disposition: { equals: disposition } }],
        }),
      ] as const),
    ),
    Promise.all(
      redirectStatuses.map(async (status) => [
        status,
        await countWhere(req, 'migration-redirects', {
          and: [siteWhere, { status: { equals: status } }],
        }),
      ] as const),
    ),
  ])

  return {
    audits: (audits.docs as unknown as Loose[]).map(briefAudit),
    canManage: canManageMigration(role),
    errors: (errors.docs as unknown as Loose[]).map(briefError),
    events: (events.docs as unknown as Loose[]).map(briefEvent),
    jobs: (jobs.docs as MigrationJob[]).map(jobView),
    mappings: (mappings.docs as unknown as Loose[]).map(briefMapping),
    recordCounts: Object.fromEntries(recordCounts),
    redirectCounts: Object.fromEntries(redirectCounts),
    site: site
      ? {
          availableLocales: site.availableLocales,
          defaultLocale: site.defaultLocale,
          id: String(site.id),
          name: site.name,
          type: site.type,
        }
      : null,
    sources: (sources.docs as MigrationSource[]).map(sourceView),
  }
}

export const migrationJobView = jobView
export const migrationSourceView = sourceView
