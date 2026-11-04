import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { CollectionSlug, PayloadRequest } from 'payload'

import type { MigrationJob, MigrationSource, Site } from '@/payload-types'
import { entryPath, termArchivePath } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'
import { setMigrationContext } from '@/lib/migration-context'
import { pagePath, postPath, productPath, slugify } from '@/lib/slug'
import { WordPressApiError } from '@/lib/wordpress/client'
import { coverageBlockers, coverageMatrix, type CoverageFacts, type CoverageRow } from '@/lib/wordpress/coverage'
import {
  classifyCptCapability,
  discoverWordPress,
  type DiscoveredPostType,
  type SourceInventory,
} from '@/lib/wordpress/discovery'
import { buildDryRunReport, reconcileWooOrderMoney, type DryRunReport } from '@/lib/wordpress/dry-run'
import {
  contentHashOf,
  mapWordPressStatus,
  preserveWordPressSlug,
} from '@/lib/wordpress/mapping'
import { validateSourceBaseUrl } from '@/lib/wordpress/source-url'

import {
  asArray,
  asRecord,
  checkControl,
  commerceAllowed,
  findDestinationDoc,
  intOf,
  isoOf,
  MigrationImportError,
  MigrationStoppedError,
  money,
  plainText,
  processPages,
  recordDisposition,
  recordDryDisposition,
  resolveMigrationSettings,
  str,
  strOrNull,
  updateJob,
  updateSource,
  type Ctx,
  type Loose,
} from './context'
import { wordpressContentToLexical } from './gutenberg'
import {
  acfContentRelationRaw,
  applyCurrentStock,
  collectWordPressMenus,
  collectWooReviewRatings,
  commentRatingOf,
  commentStatusOf,
  convertedOrder,
  customValuesOf,
  CONTENT_RELATION_TARGET_FIELDS,
  entryTermRelationRaw,
  importComments,
  importContent,
  importCoupons,
  importCustomers,
  importDefinitions,
  importMedia,
  importMenus,
  importOrders,
  importProducts,
  importTerms,
  inferFieldSchema,
  menuAggregateRaw,
  menuOrphanRecords,
  relationshipFieldSupported,
  sourceIdsFromRelationValue,
  syncAcfRelationships,
  variationRows,
  WORDPRESS_COMMENTS_PATH,
  WORDPRESS_COMMENTS_STATUS,
  WORDPRESS_COMMENT_TYPES,
  wpTaxonomyPath,
  wpTypePath,
} from './importers'
import { redactRawPayload, safeErrorMessage } from './redact'
import {
  findMigrationRecord,
  recordMigrationAudit,
  recordMigrationError,
  recordMigrationEvent,
  sourceRecordIdOf,
} from './records'
import { analyzeRedirectRules, normalizeRedirectPath, pathFromPermalink } from './redirects'
import { buildSourceClients, findOwnMigrationJob } from './source'
import {
  emptyCounts,
  type DownloadedFile,
  type MigrationCounts,
  type MigrationEngineOptions,
  type MigrationOperation,
  type RawRecord,
  type RecordDisposition,
} from './types'

/**
 * The migration orchestrator (issue #166 steps 2–5).
 *
 * Discovery, dry-run, import, delta sync, reconciliation, cutover and
 * rollback are operations over the same job/ledger. That is deliberate: the
 * dry-run's `planned` rows are the import's idempotency keys, reconciliation
 * reads the same hashes the importer wrote, and rollback can only remove
 * destination documents the ledger proves this migration created untouched.
 */

const INTERNAL_TAXONOMIES = new Set(['link_category', 'nav_menu', 'product_type', 'product_visibility'])
const SUPPORTED_MEDIA = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
])
const TERMINAL_JOB_STATUSES = new Set(['cancelled', 'completed', 'rolled-back'])

const nowIso = (): string => new Date().toISOString()

const asInventory = (value: unknown): null | SourceInventory => {
  const record = asRecord(value)

  return Array.isArray(record.postTypes) && Array.isArray(record.taxonomies)
    ? (record as unknown as SourceInventory)
    : null
}

const asCoverage = (value: unknown): CoverageRow[] =>
  Array.isArray(value) ? (value as CoverageRow[]) : []

const patchJob = async (
  req: PayloadRequest,
  jobId: string,
  data: Loose,
): Promise<MigrationJob> =>
  (await req.payload.update({
    id: jobId,
    collection: 'migration-jobs',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as MigrationJob

const allDocs = async (
  req: PayloadRequest,
  collection: string,
  where: Loose,
): Promise<Loose[]> => {
  const { docs } = await req.payload.find({
    collection: collection as CollectionSlug,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: where as never,
  })

  return docs as unknown as Loose[]
}

const loadJob = async (
  req: PayloadRequest,
  jobId: string,
  siteId?: string,
): Promise<MigrationJob | null> => {
  if (siteId) return findOwnMigrationJob(req, jobId, siteId)

  return (await req.payload.findByID({
    collection: 'migration-jobs',
    depth: 0,
    disableErrors: true,
    id: jobId,
    overrideAccess: true,
    req,
  })) as MigrationJob | null
}

// --- Source media download -----------------------------------------------------

const extensionMime = (name: string): string => {
  const extension = name.split('.').pop()?.toLowerCase()

  switch (extension) {
    case 'avif':
      return 'image/avif'
    case 'gif':
      return 'image/gif'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

const sameSourceHost = (a: string, b: string): boolean =>
  a.replace(/^www\./, '').toLowerCase() === b.replace(/^www\./, '').toLowerCase()

/**
 * Production media download. A source can name any URL in `source_url`, so
 * the downloader is held to the same SSRF shape as the source itself: public
 * HTTPS, source host (allowing the `www.` twin), redirects re-validated one
 * hop at a time, and a hard 25 MB ceiling read from the stream itself.
 */
export const defaultMediaDownloader =
  (source: MigrationSource) =>
  async (input: string): Promise<DownloadedFile> => {
    const sourceHost = new URL(String(source.baseUrl)).hostname
    let current = input

    for (let hop = 0; hop <= 5; hop += 1) {
      const url = new URL(current)

      if (url.protocol !== 'https:' || !sameSourceHost(url.hostname, sourceHost)) {
        throw new MigrationImportError(
          'MEDIA_URL_REFUSED',
          'نشانی پرونده رسانه بیرون از دامنه عمومی مبدأ است و بارگیری نمی‌شود.',
          'blocked',
        )
      }

      const checked = await validateSourceBaseUrl(url.origin, {
        lookup: async (hostname) => lookup(hostname, { all: true }),
      })

      if (!checked.ok) {
        throw new MigrationImportError('MEDIA_URL_REFUSED', checked.message, 'blocked')
      }

      const response = await fetch(url, {
        headers: { accept: 'image/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || hop === 5) throw new Error('تغییرمسیر پرونده رسانه قابل دنبال‌کردن نیست.')
        current = new URL(location, url).toString()
        continue
      }

      if (!response.ok) throw new Error(`بارگیری رسانه با وضعیت ${response.status} ناتمام ماند.`)

      const reader = response.body?.getReader()
      if (!reader) throw new Error('بدنه پاسخ رسانه خالی است.')

      const chunks: Uint8Array[] = []
      let size = 0

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 25 * 1024 * 1024) {
          await reader.cancel()
          throw new MigrationImportError(
            'MEDIA_TOO_LARGE',
            'پرونده رسانه از سقف ۲۵ مگابایت بزرگ‌تر است.',
            'blocked',
          )
        }
        chunks.push(value)
      }

      const name =
        decodeURIComponent(url.pathname.split('/').pop() ?? '') || `media-${Date.now()}`
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim()

      return {
        data: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        mimetype: contentType || extensionMime(name),
        name,
      }
    }

    throw new Error('بارگیری رسانه به نتیجه نرسید.')
  }

// --- Context -------------------------------------------------------------------

const loadDefinitionCaches = async (ctx: Ctx): Promise<void> => {
  const [taxonomies, types] = await Promise.all([
    allDocs(ctx.req, 'taxonomy-definitions', { site: { equals: ctx.siteId } }),
    allDocs(ctx.req, 'content-type-definitions', { site: { equals: ctx.siteId } }),
  ])

  for (const doc of taxonomies) ctx.taxonomyDefinitions.set(str(doc.key), doc)
  for (const doc of types) ctx.typeDefinitions.set(str(doc.key), doc)
}

const buildContext = async (
  req: PayloadRequest,
  {
    job,
    operation,
    options,
    resume,
    runId,
    site,
    source,
  }: {
    job: MigrationJob
    operation: MigrationOperation
    options: MigrationEngineOptions
    resume: boolean
    runId: string
    site: Site
    source: MigrationSource
  },
): Promise<Ctx> => {
  const siteId = String(site.id)
  setMigrationContext(req, { jobId: String(job.id), siteId, source: 'wordpress' })

  const rawSettings = asRecord(job.settings)
  const settings = await resolveMigrationSettings(req, job, site)
  const clients =
    options.clients ?? (await buildSourceClients(req, source, { perPage: options.perPage }))
  const modifiedAfter =
    strOrNull(rawSettings.modifiedAfter) ??
    (operation === 'sync' || operation === 'cutover' ? strOrNull(job.lastSyncAt) : null)
  const ctx: Ctx = {
    clients,
    counts: emptyCounts(),
    coverage: asCoverage(job.coverage ?? source.coverage),
    currentBatchId: null,
    destinationCache: new Map(),
    download: options.download ?? defaultMediaDownloader(source),
    installation: String(source.installation),
    inventory: asInventory(job.inventory ?? source.inventory),
    job,
    jobId: String(job.id),
    mediaByUrl: new Map(),
    modifiedAfter,
    operation,
    pendingContentRelations: [],
    pendingParents: [],
    perPage: options.perPage,
    req,
    resume,
    runId,
    settings,
    site,
    siteId,
    source,
    sourceId: String(source.id),
    startedAt: nowIso(),
    taxonomyDefinitions: new Map(),
    typeDefinitions: new Map(),
  }

  await loadDefinitionCaches(ctx)

  return ctx
}

// --- Discovery -----------------------------------------------------------------

type WooFacts = {
  currency: null | string
  decimals: null | number
  hasSubscriptions: boolean
  plugins: string[]
  productTypes: string[]
}

const pluginName = (value: unknown): string => {
  const record = asRecord(value)

  return str(record.plugin) || str(record.name) || str(record.slug)
}

const collectWooFacts = async (ctx: Ctx): Promise<WooFacts> => {
  const facts: WooFacts = {
    currency: null,
    decimals: null,
    hasSubscriptions: false,
    plugins: [],
    productTypes: [],
  }
  const woo = ctx.clients.woo
  if (!woo) return facts

  const settings = (await woo
    .collect<RawRecord>('/wp-json/wc/v3/settings/general')
    .catch(() => [])) as RawRecord[]
  const valueOf = (id: string): null | string =>
    strOrNull(settings.find((row) => str(row.id) === id)?.value)
  facts.currency = valueOf('woocommerce_currency')?.toUpperCase() ?? null
  const decimals = Number(valueOf('woocommerce_price_num_decimals'))
  facts.decimals = Number.isInteger(decimals) && decimals >= 0 && decimals <= 4 ? decimals : null

  if (!facts.currency) {
    const current = asRecord(
      await woo.getJson('/wp-json/wc/v3/data/currencies/current').catch(() => ({})),
    )
    facts.currency = strOrNull(current.code)?.toUpperCase() ?? null
  }

  const systemStatus = asRecord(
    await woo.getJson('/wp-json/wc/v3/system_status').catch(() => ({})),
  )
  facts.plugins = asArray(systemStatus.active_plugins).map(pluginName).filter(Boolean)

  try {
    for await (const { items } of woo.pages<RawRecord>('/wp-json/wc/v3/products', {
      status: 'any',
    })) {
      facts.productTypes = [...new Set(items.map((item) => str(item.type)).filter(Boolean))]
      break
    }
  } catch {
    // The product stream itself will report its own failure in dry-run/import;
    // discovery's type sample is a planning hint, not a second failure path.
  }

  facts.hasSubscriptions =
    facts.plugins.some((plugin) => /subscription/i.test(plugin)) ||
    facts.productTypes.some((type) => /subscription/i.test(type))

  return facts
}

const upsertMapping = async (
  ctx: Ctx,
  {
    destination,
    disposition,
    reason,
    resource,
    sourceField = null,
    transform,
  }: {
    destination: string
    disposition: CoverageRow['disposition'] | 'excluded'
    reason?: string
    resource: string
    sourceField?: null | string
    transform?: Loose
  },
): Promise<void> => {
  const { docs } = await ctx.req.payload.find({
    collection: 'migration-mappings',
    depth: 0,
    limit: 50,
    overrideAccess: true,
    req: ctx.req,
    where: {
      and: [
        { job: { equals: ctx.jobId } },
        { resource: { equals: resource } },
        { destination: { equals: destination } },
      ],
    },
  })
  const existing = (docs as unknown as Loose[]).find(
    (doc) => (strOrNull(doc.sourceField) ?? null) === sourceField,
  )
  const data = {
    destination,
    disposition,
    job: ctx.jobId,
    ...(reason ? { reason } : {}),
    resource,
    site: ctx.siteId,
    source: ctx.sourceId,
    ...(sourceField ? { sourceField } : {}),
    status: existing?.status === 'confirmed' ? 'confirmed' : 'proposed',
    ...(transform ? { transform } : {}),
  }

  if (existing) {
    await ctx.req.payload.update({
      id: String(existing.id),
      collection: 'migration-mappings',
      data: data as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
    return
  }

  await ctx.req.payload.create({
    collection: 'migration-mappings',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })
}

export const ensureDiscovery = async (
  ctx: Ctx,
  { force = true }: { force?: boolean } = {},
): Promise<{ coverage: CoverageRow[]; inventory: SourceInventory; woo: WooFacts }> => {
  if (ctx.inventory && !force) {
    return {
      coverage: ctx.coverage.length ? ctx.coverage : coverageMatrix(ctx.inventory),
      inventory: ctx.inventory,
      woo: { currency: null, decimals: null, hasSubscriptions: false, plugins: [], productTypes: [] },
    }
  }

  await updateJob(ctx, { phase: 'discovery' })
  const inventory = await discoverWordPress(ctx.clients.wp)
  const wpPluginsRaw = (await ctx.clients.wp
    .getJson('/wp-json/wp/v2/plugins', { context: 'edit', status: 'active' })
    .catch(() => [])) as unknown
  const wpPlugins = (Array.isArray(wpPluginsRaw) ? wpPluginsRaw : [])
    .map(pluginName)
    .filter(Boolean)
  const woo = inventory.hasWooCommerce
    ? await collectWooFacts(ctx)
    : { currency: null, decimals: null, hasSubscriptions: false, plugins: [], productTypes: [] }
  const plugins = [...new Set([...wpPlugins, ...woo.plugins])].slice(0, 200)
  const facts: CoverageFacts = {
    plugins,
    woo: {
      hasSubscriptions: woo.hasSubscriptions,
      hasVariableProducts: woo.productTypes.includes('variable'),
    },
  }
  const coverage = coverageMatrix(inventory, facts)

  if (inventory.hasWooCommerce && !ctx.clients.woo) {
    coverage.push({
      destination: '—',
      disposition: 'unsupported-blocking',
      label: 'اعتبارنامه ووکامرس',
      reason: 'مبدأ ووکامرس دارد اما کلید/رمز فقط‌خواندنی REST ثبت نشده؛ محصولات، مشتریان و سفارش‌ها خوانده نمی‌شوند.',
      resource: 'woocommerce-credentials',
    })
  }

  const unsupportedTypes = woo.productTypes.filter(
    (type) => !['external', 'grouped', 'simple', 'variable'].includes(type),
  )
  if (unsupportedTypes.length) {
    coverage.push({
      destination: '—',
      disposition: 'unsupported-blocking',
      label: 'گونه‌های محصول بدون معادل',
      reason: `گونه‌های دیده‌شده در نمونه نخست (${unsupportedTypes.join('، ')}) معادل بومی ندارند و رکوردهایشان مسدود می‌مانند.`,
      resource: 'product-types',
    })
  }

  const rawSettings = asRecord(ctx.job.settings)
  let moneyMismatch: null | string = null

  if (woo.currency) {
    if (!str(rawSettings.sourceCurrency)) ctx.settings.sourceCurrency = woo.currency
    else if (str(rawSettings.sourceCurrency).toUpperCase() !== woo.currency) {
      moneyMismatch = `واحد پول تنظیم‌شده (${str(rawSettings.sourceCurrency)}) با واحد ووکامرس (${woo.currency}) یکی نیست.`
    }
  }
  if (woo.decimals !== null) {
    if (typeof rawSettings.sourceDecimals !== 'number') ctx.settings.sourceDecimals = woo.decimals
    else if (rawSettings.sourceDecimals !== woo.decimals) {
      moneyMismatch = `اعشار تنظیم‌شده (${String(rawSettings.sourceDecimals)}) با اعشار ووکامرس (${woo.decimals}) یکی نیست.`
    }
  }
  if (moneyMismatch) {
    coverage.push({
      destination: 'تنظیمات پول کار',
      disposition: 'unsupported-blocking',
      label: 'ناهماهنگی پول مبدأ',
      reason: moneyMismatch,
      resource: 'woocommerce-money-settings',
    })
  }

  ctx.inventory = inventory
  ctx.coverage = coverage
  const blockingWarnings = inventory.warnings.filter((warning) => warning.severity === 'blocking')

  await updateJob(ctx, {
    blockers: [
      ...blockingWarnings.map((warning) => warning.message),
      ...coverageBlockers(coverage).map((row) => `${row.label}: ${row.reason}`),
    ],
    coverage,
    inventory,
    summary: {
      discoveredAt: nowIso(),
      plugins,
      woo,
    },
  })
  await updateSource(ctx, {
    coverage,
    inventory,
    lastCheckedAt: nowIso(),
    lastError: blockingWarnings[0]?.message ?? null,
    status: blockingWarnings.length ? 'blocked' : 'ready',
  })

  for (const row of coverage) {
    await upsertMapping(ctx, {
      destination: row.destination,
      disposition: row.disposition,
      reason: row.reason,
      resource: row.resource,
    })
  }
  for (const warning of inventory.warnings) {
    await recordMigrationEvent(ctx.req, {
      eventType: `discovery.${warning.code}`,
      jobId: ctx.jobId,
      level: warning.severity === 'blocking' ? 'error' : 'warning',
      message: warning.message,
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
    })
  }
  await recordMigrationAudit(ctx.req, {
    action: 'source.discover',
    details: {
      coverageRows: coverage.length,
      postTypes: inventory.postTypes.map((type) => type.slug),
      taxonomies: inventory.taxonomies.map((taxonomy) => taxonomy.slug),
      woo,
    },
    jobId: ctx.jobId,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    summary: blockingWarnings.length
      ? 'کشف مبدأ کامل شد اما موجودی برای شروع مهاجرت قابل اتکا نیست.'
      : 'کشف مبدأ و ماتریس پوشش به‌روز شد.',
  })

  if (blockingWarnings.length && ctx.operation !== 'discover') {
    throw new MigrationImportError(
      'DISCOVERY_BLOCKED',
      blockingWarnings[0]!.message,
      'blocked',
    )
  }
  if (moneyMismatch && ctx.operation !== 'discover') {
    throw new MigrationImportError('WOO_MONEY_SETTINGS_MISMATCH', moneyMismatch, 'blocked')
  }

  return { coverage, inventory, woo }
}

// --- Redirect inventory ----------------------------------------------------------

type RedirectExpectation = {
  destinationCollection?: null | string
  destinationId?: null | string
  fromUrl: string
  resource: string
  sourceRecordId: string
  toUrl: string
}

const archiveSlugForType = (ctx: Ctx, type: DiscoveredPostType): string => {
  const definition = ctx.typeDefinitions.get(type.slug)

  return str(definition?.archiveSlug) || slugify(typeof type.hasArchive === 'string' && type.hasArchive ? type.hasArchive : type.slug)
}

export const targetPathFor = (
  ctx: Ctx,
  resource: string,
  raw: RawRecord,
): null | string => {
  const slug = str(raw.slug)
  if (!slug) return null

  let preserved: string
  try {
    preserved = preserveWordPressSlug(slug)
  } catch {
    return null
  }

  if (resource === 'product') return productPath(preserved)
  if (resource === 'post-type:post') return postPath(preserved)
  if (resource === 'post-type:page') return pagePath(preserved)

  if (resource.startsWith('post-type:')) {
    const typeSlug = resource.slice('post-type:'.length)
    const definition = ctx.typeDefinitions.get(typeSlug)
    const type = ctx.inventory?.postTypes.find((candidate) => candidate.slug === typeSlug)

    if (definition) {
      return entryPath(
        definition as never,
        { id: sourceRecordIdOf(raw) ?? preserved, slug: preserved },
      )
    }

    return type ? `/${archiveSlugForType(ctx, type)}/${preserved}` : `/${typeSlug}/${preserved}`
  }

  if (resource.startsWith('taxonomy:')) {
    const taxonomySlug = resource.slice('taxonomy:'.length)
    if (taxonomySlug === 'category') return null
    const definition = ctx.taxonomyDefinitions.get(taxonomySlug)

    return definition
      ? termArchivePath(definition as never, [preserved])
      : `/${slugify(taxonomySlug)}/${preserved}`
  }

  return null
}

const redirectExpectation = (
  ctx: Ctx,
  resource: string,
  raw: RawRecord,
  destinationCollection?: null | string,
  destinationId?: null | string,
): null | RedirectExpectation => {
  const sourceRecordId = sourceRecordIdOf(raw)
  const fromUrl = pathFromPermalink(
    typeof raw.link === 'string' ? raw.link : typeof raw.permalink === 'string' ? raw.permalink : null,
    String(ctx.source.baseUrl),
  )
  const toUrl = targetPathFor(ctx, resource, raw)

  if (!sourceRecordId || !fromUrl || !toUrl) return null

  return {
    destinationCollection: destinationCollection ?? null,
    destinationId: destinationId ?? null,
    fromUrl: normalizeRedirectPath(fromUrl),
    resource,
    sourceRecordId,
    toUrl: normalizeRedirectPath(toUrl),
  }
}

export const planMigrationRedirect = async (
  ctx: Ctx,
  expectation: RedirectExpectation,
): Promise<Loose> => {
  const rows = await allDocs(ctx.req, 'migration-redirects', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      { fromUrl: { equals: expectation.fromUrl } },
    ],
  })
  const existing = rows[0]
  const record = await findMigrationRecord(ctx.req, {
    installation: ctx.installation,
    jobId: ctx.jobId,
    resource: expectation.resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId: expectation.sourceRecordId,
  })
  const samePath = expectation.fromUrl === expectation.toUrl
  const existingApplied =
    existing?.status === 'applied' && str(existing.toUrl) === expectation.toUrl
  const data: Loose = {
    destinationCollection: expectation.destinationCollection ?? existing?.destinationCollection ?? null,
    destinationId: expectation.destinationId ?? existing?.destinationId ?? null,
    fromUrl: expectation.fromUrl,
    job: ctx.jobId,
    message:
      existing && str(existing.toUrl) !== expectation.toUrl && existing.status === 'applied'
        ? 'مقصد مبدأ از آخرین قاعده اعمال‌شده تغییر کرده و نیازمند بازبینی است.'
        : samePath
          ? 'نشانی مقصد با نشانی مبدأ یکسان است؛ قاعده لازم نیست.'
          : null,
    ...(record ? { record: String(record.id) } : {}),
    resource: expectation.resource,
    site: ctx.siteId,
    source: ctx.sourceId,
    sourceRecordId: expectation.sourceRecordId,
    status: samePath
      ? 'unchanged'
      : existingApplied
        ? 'applied'
        : existing?.status === 'ignored'
          ? 'ignored'
          : existing && str(existing.toUrl) !== expectation.toUrl && existing.status === 'applied'
            ? 'conflict'
            : 'proposed',
    toUrl: expectation.toUrl,
  }

  if (existingApplied && existing?.redirect) data.redirect = idOf(existing.redirect)

  if (existing) {
    return (await ctx.req.payload.update({
      id: String(existing.id),
      collection: 'migration-redirects',
      data: data as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })) as unknown as Loose
  }

  return (await ctx.req.payload.create({
    collection: 'migration-redirects',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })) as unknown as Loose
}

export const planMigrationRedirectsFromLedger = async (
  ctx: Ctx,
): Promise<RedirectExpectation[]> => {
  const records = await allDocs(ctx.req, 'migration-records', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      {
        disposition: {
          in: ['archived', 'imported', 'planned', 'unchanged', 'updated'],
        },
      },
    ],
  })
  const expectations: RedirectExpectation[] = []

  for (const record of records) {
    const resource = str(record.resource)
    if (!resource.startsWith('post-type:') && !resource.startsWith('taxonomy:') && resource !== 'product') {
      continue
    }
    const raw = {
      ...asRecord(record.rawPayload),
      id: str(record.sourceRecordId),
      link: str(record.sourcePermalink) || asRecord(record.rawPayload).link,
      slug: str(record.sourceSlug) || asRecord(record.rawPayload).slug,
    }
    const expectation = redirectExpectation(
      ctx,
      resource,
      raw,
      strOrNull(record.destinationCollection),
      strOrNull(record.destinationId),
    )
    if (!expectation) continue
    expectations.push(expectation)
    await planMigrationRedirect(ctx, expectation)
  }

  return expectations
}

export const assessMigrationRedirects = async (
  ctx: Ctx,
): Promise<{ problems: ReturnType<typeof analyzeRedirectRules>; rows: Loose[] }> => {
  const rows = await allDocs(ctx.req, 'migration-redirects', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      { status: { in: ['applied', 'conflict', 'proposed'] } },
    ],
  })
  const problems = analyzeRedirectRules(
    rows.map((row) => ({ from: str(row.fromUrl), to: str(row.toUrl) })),
  )
  const problemPaths = new Set(problems.map((problem) => problem.from))

  for (const row of rows) {
    if (!problemPaths.has(normalizeRedirectPath(str(row.fromUrl))) || row.status === 'conflict') {
      continue
    }
    await ctx.req.payload.update({
      id: String(row.id),
      collection: 'migration-redirects',
      data: {
        message: 'این مسیر در فهرست تغییرمسیرها تکراری، خودارجاع یا چرخه‌دار است.',
        status: 'conflict',
      } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
    row.status = 'conflict'
  }

  return { problems, rows }
}

export const applyMigrationRedirects = async (
  ctx: Ctx,
  { force = false }: { force?: boolean } = {},
): Promise<{ applied: number; conflicts: number; proposed: number; unchanged: number }> => {
  await planMigrationRedirectsFromLedger(ctx)
  const assessed = await assessMigrationRedirects(ctx)
  let conflicts = assessed.problems.length

  if (!force && !ctx.settings.applyRedirects) {
    return {
      applied: 0,
      conflicts,
      proposed: assessed.rows.filter((row) => row.status === 'proposed').length,
      unchanged: 0,
    }
  }

  let applied = 0
  let unchanged = 0
  const rows = assessed.rows.filter((row) => row.status === 'proposed' || row.status === 'applied')

  for (const row of rows) {
    const from = normalizeRedirectPath(str(row.fromUrl))
    const to = normalizeRedirectPath(str(row.toUrl))
    const existingRedirects = await allDocs(ctx.req, 'redirects', {
      and: [{ site: { equals: ctx.siteId } }, { from: { equals: from } }],
    })
    const existing = existingRedirects[0]
    const existingTo = asRecord(existing?.to)
    const existingTarget = strOrNull(existingTo.url)

    if (existing && existingTarget !== to) {
      conflicts += 1
      await ctx.req.payload.update({
        id: String(row.id),
        collection: 'migration-redirects',
        data: {
          message: 'سایت برای این مسیر از پیش قاعده دیگری دارد؛ قاعده سردبیر بازنویسی نمی‌شود.',
          status: 'conflict',
        } as never,
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })
      await recordMigrationError(ctx.req, {
        code: 'REDIRECT_CONFLICT',
        error: new Error(`مسیر ${from} در سایت از پیش به جای دیگری اشاره می‌کند.`),
        jobId: ctx.jobId,
        resource: str(row.resource),
        retryable: false,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId: str(row.sourceRecordId),
      })
      continue
    }

    const redirect =
      existing ??
      ((await ctx.req.payload.create({
        collection: 'redirects',
        data: {
          from,
          site: ctx.siteId,
          to: { type: 'custom', url: to },
        } as never,
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })) as unknown as Loose)

    if (existing) unchanged += 1
    else applied += 1

    await ctx.req.payload.update({
      id: String(row.id),
      collection: 'migration-redirects',
      data: {
        message: null,
        redirect: String(redirect.id),
        status: 'applied',
      } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
  }

  await recordMigrationAudit(ctx.req, {
    action: 'redirects.apply',
    details: { applied, conflicts, unchanged },
    jobId: ctx.jobId,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    summary: `تغییرمسیرهای مهاجرت اعمال شد: ${applied} تازه، ${unchanged} موجود، ${conflicts} ناسازگار.`,
  })

  return { applied, conflicts, proposed: 0, unchanged }
}

// --- Dry-run ----------------------------------------------------------------------

type DryStats = {
  archived: number
  blocked: number
  errors: { message: string; sourceId: string }[]
  resource: string
  seen: number
  unchanged: number
  wouldCreate: number
  wouldUpdate: number
}

const newDryStats = (resource: string): DryStats => ({
  archived: 0,
  blocked: 0,
  errors: [],
  resource,
  seen: 0,
  unchanged: 0,
  wouldCreate: 0,
  wouldUpdate: 0,
})

const bumpDry = (stats: DryStats, disposition: RecordDisposition): void => {
  stats.seen += 1
  if (disposition === 'imported' || disposition === 'planned') stats.wouldCreate += 1
  else if (disposition === 'updated') stats.wouldUpdate += 1
  else if (disposition === 'unchanged') stats.unchanged += 1
  else if (disposition === 'archived') stats.archived += 1
  else if (disposition === 'blocked') stats.blocked += 1
}

const mergeDryCounts = (stats: DryStats, counts: MigrationCounts): void => {
  stats.archived += counts.archived
  stats.blocked += counts.blocked
  stats.seen += counts.seen
  stats.unchanged += counts.unchanged
  stats.wouldCreate += counts.imported
  stats.wouldUpdate += counts.updated
}

const coverageDisposition = (ctx: Ctx, resource: string): string | undefined =>
  ctx.coverage.find((row) => row.resource === resource)?.disposition

const throwIfDryBlocked = (ctx: Ctx, resource: string): void => {
  if (coverageDisposition(ctx, resource) === 'unsupported-blocking') {
    throw new MigrationImportError(
      'COVERAGE_BLOCKED',
      'این بخش در ماتریس پوشش پشتیبانی‌نشده و مسدودکننده است.',
      'blocked',
    )
  }
}

export const runDryRun = async (ctx: Ctx): Promise<DryRunReport> => {
  if (!ctx.inventory) throw new Error('پیش از اجرای خشک، کشف مبدأ لازم است.')

  const inventory = ctx.inventory
  const statsByResource = new Map<string, DryStats>()
  const unknownByResource = new Map<string, Set<string>>()
  const moneyChecks: DryRunReport['moneyChecks'] = []
  const statsFor = (resource: string): DryStats => {
    const existing = statsByResource.get(resource) ?? newDryStats(resource)
    statsByResource.set(resource, existing)
    return existing
  }
  const noteUnknown = (resource: string, raw: RawRecord): void => {
    const set = unknownByResource.get(resource) ?? new Set<string>()
    for (const key of Object.keys(customValuesOf(raw))) set.add(key)
    unknownByResource.set(resource, set)
  }
  const wrap =
    (resource: string, handler: (raw: RawRecord) => Promise<RecordDisposition>) =>
    async (raw: RawRecord): Promise<RecordDisposition> => {
      try {
        return await handler(raw)
      } catch (error) {
        statsFor(resource).errors.push({
          message: safeErrorMessage(error),
          sourceId: sourceRecordIdOf(raw) ?? '?',
        })
        throw error
      }
    }
  const plan = async (resource: string, raw: RawRecord): Promise<void> => {
    const expectation = redirectExpectation(ctx, resource, raw)
    if (expectation) await planMigrationRedirect(ctx, expectation)
  }

  // Definitions are proposed, never created, in a dry run.
  for (const taxonomy of inventory.taxonomies) {
    if (taxonomy.slug === 'category' || INTERNAL_TAXONOMIES.has(taxonomy.slug)) continue
    const stats = statsFor('taxonomy-definition')
    const raw = taxonomy as unknown as RawRecord
    bumpDry(
      stats,
      await recordDryDisposition(ctx, {
        raw,
        resource: 'taxonomy-definition',
        sourceRecordId: taxonomy.slug,
      }),
    )
  }
  for (const type of inventory.postTypes) {
    if (type.capability !== 'custom') continue
    const stats = statsFor('content-type-definition')
    const raw = type as unknown as RawRecord

    try {
      throwIfDryBlocked(ctx, `post-type:${type.slug}`)
      if (classifyCptCapability(type).mode === 'requires-review') {
        throw new MigrationImportError(
          'CPT_REQUIRES_REVIEW',
          'این گونه محتوا نشانه فرایند عملیاتی دارد و تا تأیید تطبیق‌دهنده وارد نمی‌شود.',
          'blocked',
        )
      }
      const path = wpTypePath(type)
      let schema: Loose[] = []

      if (path) {
        for await (const { items } of ctx.clients.wp.pages<RawRecord>(path, {
          context: 'edit',
          status: 'any',
        })) {
          schema = inferFieldSchema(items)
          break
        }
      }
      bumpDry(
        stats,
        await recordDryDisposition(ctx, {
          metadata: { inferredFieldSchema: schema },
          raw,
          resource: 'content-type-definition',
          sourceRecordId: type.slug,
        }),
      )
      for (const field of schema) {
        await upsertMapping(ctx, {
          destination: `content-type-definitions(${type.slug}).fieldSchema.${str(field.key)}:${str(field.fieldType)}`,
          disposition: 'requires-mapping',
          reason: 'گونه فیلد از نمونه‌های مبدأ حدس زده شده و پیش از ورود باید دیده شود.',
          resource: `post-type:${type.slug}`,
          sourceField: str(field.key),
          transform: { inferredFromSamples: true },
        })
      }
    } catch (error) {
      stats.errors.push({ message: safeErrorMessage(error), sourceId: type.slug })
      bumpDry(stats, error instanceof MigrationImportError && error.disposition === 'blocked' ? 'blocked' : 'error')
      await recordDisposition(ctx, {
        disposition: error instanceof MigrationImportError && error.disposition === 'blocked' ? 'blocked' : 'error',
        raw,
        resource: 'content-type-definition',
        sourceRecordId: type.slug,
      }).catch(() => undefined)
    }
  }

  for (const taxonomy of inventory.taxonomies) {
    if (INTERNAL_TAXONOMIES.has(taxonomy.slug)) continue
    const path = wpTaxonomyPath(taxonomy)
    if (!path) continue
    const resource = `taxonomy:${taxonomy.slug}`

    mergeDryCounts(
      statsFor(resource),
      await processPages(ctx, {
        client: ctx.clients.wp,
        handler: wrap(resource, async (raw) => {
          preserveWordPressSlug(raw.slug)
          const outcome = await recordDryDisposition(ctx, {
            metadata: { sourceParentId: intOf(raw.parent, 0) },
            raw,
            resource,
            sourceRecordId: sourceRecordIdOf(raw)!,
          })
          await plan(resource, raw)
          return outcome
        }),
        params: { context: 'edit', hide_empty: 'false', order: 'asc', orderby: 'id' },
        path,
        resource,
      }),
    )
  }

  if (ctx.settings.includeMedia) {
    mergeDryCounts(
      statsFor('media'),
      await processPages(ctx, {
        client: ctx.clients.wp,
        handler: wrap('media', async (raw) => {
          const mime = str(raw.mime_type)
          if (!SUPPORTED_MEDIA.has(mime)) {
            throw new MigrationImportError(
              'UNSUPPORTED_MEDIA',
              `گونه پرونده «${mime || 'نامشخص'}» در کتابخانه رسانه مقصد جا نمی‌شود.`,
              'blocked',
            )
          }
          if (!str(raw.source_url)) {
            throw new MigrationImportError('MISSING_MEDIA_URL', 'پیوست نشانی پرونده ندارد.')
          }

          return recordDryDisposition(ctx, {
            metadata: { mimeType: mime, sourceUrl: str(raw.source_url) },
            raw,
            resource: 'media',
            sourceRecordId: sourceRecordIdOf(raw)!,
          })
        }),
        params: { context: 'edit', order: 'asc', orderby: 'id' },
        path: '/wp-json/wp/v2/media',
        resource: 'media',
      }),
    )
  }

  if (ctx.settings.includeContent) {
    for (const type of inventory.postTypes) {
      if (!['core-page', 'core-post', 'custom'].includes(type.capability)) continue
      const path = wpTypePath(type)
      if (!path) continue
      const resource = `post-type:${type.slug}`

      mergeDryCounts(
        statsFor(resource),
        await processPages(ctx, {
          client: ctx.clients.wp,
          handler: wrap(resource, async (raw) => {
            throwIfDryBlocked(ctx, resource)
            noteUnknown(resource, raw)
            preserveWordPressSlug(raw.slug)
            const status = mapWordPressStatus(str(raw.status) || 'draft')
            const sourceHtml = str(asRecord(raw.content).raw) || str(asRecord(raw.content).rendered)
            const conversion = wordpressContentToLexical(sourceHtml, {
              locale: ctx.settings.locale,
            })
            const outcome = await recordDryDisposition(ctx, {
              metadata: {
                conversionWarnings: conversion.warnings,
                sourceParentId: intOf(raw.parent, 0),
                unsupportedBlocks: conversion.unsupportedBlocks,
              },
              raw,
              resource,
              sourceRecordId: sourceRecordIdOf(raw)!,
            })

            if (status.disposition === 'archive-only') return 'archived'
            if (status.target === 'published' || status.target === 'scheduled') {
              await plan(resource, raw)
            }

            return outcome
          }),
          params: { context: 'edit', order: 'asc', orderby: 'id', status: 'any' },
          path,
          resource,
        }),
      )
    }
  }

  const includeCommerce =
    ctx.settings.includeProducts ||
    ctx.settings.includeCustomers ||
    ctx.settings.includeCoupons ||
    ctx.settings.includeOrders

  if (inventory.hasWooCommerce && includeCommerce && commerceAllowed(ctx) && ctx.clients.woo) {
    const woo = ctx.clients.woo

    if (ctx.settings.includeProducts) {
      mergeDryCounts(
        statsFor('product'),
        await processPages(ctx, {
          client: woo,
          handler: wrap('product', async (raw) => {
            throwIfDryBlocked(ctx, 'post-type:product')
            noteUnknown('product', raw)
            const type = str(raw.type) || 'simple'
            if (!['external', 'grouped', 'simple', 'variable'].includes(type)) {
              throw new MigrationImportError(
                'UNSUPPORTED_PRODUCT_TYPE',
                `گونه محصول «${type}» معادل بومی ندارد.`,
                'blocked',
              )
            }
            preserveWordPressSlug(raw.slug)
            money(ctx, raw.price || raw.regular_price)
            const variations = await variationRows(ctx, raw)
            if (type === 'variable' && variations.length === 0) {
              throw new MigrationImportError(
                'VARIATIONS_MISSING',
                'محصول متغیر هیچ تنوعی از API برنگرداند.',
                'blocked',
              )
            }
            for (const variation of variations) money(ctx, variation.price || variation.regular_price)
            const hashRaw = { ...raw, __eshobe_variations: variations }
            const outcome = await recordDryDisposition(ctx, {
              metadata: { productType: type, variationCount: variations.length },
              raw: hashRaw,
              resource: 'product',
              sourceRecordId: sourceRecordIdOf(raw)!,
            })
            if (str(raw.status) === 'publish') await plan('product', raw)

            return outcome
          }),
          params: { order: 'asc', orderby: 'id', status: 'any' },
          path: '/wp-json/wc/v3/products',
          resource: 'product',
        }),
      )
    }

    if (ctx.settings.includeCustomers) {
      mergeDryCounts(
        statsFor('customers'),
        await processPages(ctx, {
          client: woo,
          handler: wrap('customers', async (raw) => {
            if (!str(raw.email).trim() && !str(raw.username).trim()) {
              throw new MigrationImportError(
                'CUSTOMER_IDENTITY_MISSING',
                'مشتری نه رایانامه دارد نه نام کاربری؛ حساب قابل مطالبه‌ای ساخته نمی‌شود.',
                'blocked',
              )
            }

            return recordDryDisposition(ctx, {
              raw,
              resource: 'customers',
              sourceRecordId: sourceRecordIdOf(raw)!,
            })
          }),
          params: { order: 'asc', orderby: 'id' },
          path: '/wp-json/wc/v3/customers',
          resource: 'customers',
        }),
      )
    }

    if (ctx.settings.includeCoupons) {
      mergeDryCounts(
        statsFor('coupons'),
        await processPages(ctx, {
          client: woo,
          handler: wrap('coupons', async (raw) => {
            if (!str(raw.code).trim()) {
              throw new MigrationImportError('COUPON_CODE_MISSING', 'کوپن کد ندارد.', 'blocked')
            }
            if (str(raw.discount_type) !== 'percent') money(ctx, raw.amount)

            return recordDryDisposition(ctx, {
              raw,
              resource: 'coupons',
              sourceRecordId: sourceRecordIdOf(raw)!,
            })
          }),
          params: { order: 'asc', orderby: 'id' },
          path: '/wp-json/wc/v3/coupons',
          resource: 'coupons',
        }),
      )
    }

    if (ctx.settings.includeOrders) {
      mergeDryCounts(
        statsFor('orders'),
        await processPages(ctx, {
          client: woo,
          handler: wrap('orders', async (raw) => {
            throwIfDryBlocked(ctx, 'orders')
            const check = reconcileWooOrderMoney(raw, ctx.settings.sourceDecimals)
            moneyChecks.push(check)
            const converted = convertedOrder(ctx, raw)

            return recordDryDisposition(ctx, {
              metadata: {
                lineCount: converted.items.length,
                totals: {
                  discountTotal: converted.discountTotal,
                  shippingTotal: converted.shippingTotal,
                  subtotal: converted.subtotal,
                  taxTotal: converted.taxTotal,
                  total: converted.total,
                },
              },
              raw,
              resource: 'orders',
              sourceRecordId: sourceRecordIdOf(raw)!,
            })
          }),
          params: { order: 'asc', orderby: 'id', status: 'any' },
          path: '/wp-json/wc/v3/orders',
          resource: 'orders',
        }),
      )
    }
  }

  if (ctx.settings.includeMenus) {
    const stats = statsFor('menus')

    try {
      const aggregate = await collectWordPressMenus(ctx)

      for (const menu of aggregate.menus) {
        const sourceRecordId = sourceRecordIdOf(menu) ?? 'menu-missing-id'
        const items = aggregate.itemsByMenu.get(sourceRecordId) ?? []
        const raw = menuAggregateRaw(menu, items)

        try {
          if (!sourceRecordIdOf(menu)) {
            throw new MigrationImportError(
              'MENU_ID_MISSING',
              'منوی مبدأ شناسه ندارد و به‌صورت مسدود ثبت شد.',
              'blocked',
            )
          }
          preserveWordPressSlug(menu.slug ?? `menu-${sourceRecordId}`)
          if (items.length > 1_000) {
            throw new MigrationImportError(
              'MENU_TOO_LARGE',
              'منو بیش از سقف ۱۰۰۰ آیتم دارد و برای تقسیم دستی مسدود ماند.',
              'blocked',
            )
          }
          for (const item of items) {
            const status = mapWordPressStatus(str(item.status) || 'publish')
            if (!status.target) {
              throw new MigrationImportError(
                'MENU_ITEM_STATUS_UNSUPPORTED',
                `وضعیت آیتم منو «${status.original}» نگاشت بومی ندارد؛ منو مسدود ماند.`,
                'blocked',
              )
            }
          }
          bumpDry(
            stats,
            await recordDryDisposition(ctx, {
              metadata: { itemCount: items.length },
              raw,
              resource: 'menus',
              sourceRecordId,
            }),
          )
        } catch (error) {
          stats.errors.push({ message: safeErrorMessage(error), sourceId: sourceRecordId })
          const disposition =
            error instanceof MigrationImportError && error.disposition === 'blocked'
              ? 'blocked'
              : 'error'
          bumpDry(stats, disposition)
          await recordDisposition(ctx, {
            disposition,
            raw,
            resource: 'menus',
            sourceRecordId,
          }).catch(() => undefined)
        }
      }

      for (const orphan of menuOrphanRecords(aggregate.orphanItems)) {
        stats.errors.push({
          message: orphan.claimedMenuIds.length
            ? `آیتم منو به منویی اشاره می‌کند که endpoint منوها برنگرداند (${orphan.claimedMenuIds.join('، ')}).`
            : 'آیتم منو هیچ منوی مبدأ قابل کشف ندارد.',
          sourceId: orphan.sourceRecordId,
        })
        bumpDry(stats, 'blocked')
        await recordDisposition(ctx, {
          disposition: 'blocked',
          metadata: {
            claimedMenuIds: orphan.claimedMenuIds,
            menuItemIds: orphan.items.map((item) => sourceRecordIdOf(item)),
            orphanReason: orphan.claimedMenuIds.length ? 'unknown-menu' : 'missing-menu',
          },
          raw: orphan.raw,
          resource: 'menus',
          sourceRecordId: orphan.sourceRecordId,
        }).catch(() => undefined)
      }
    } catch (error) {
      if (
        !(
          error instanceof WordPressApiError &&
          (error.status === 404 || /no_route|not_found/i.test(error.code ?? ''))
        )
      ) {
        throw error
      }
      const raw: RawRecord = { endpoint: '/wp-json/wp/v2/menus', id: 'menus' }
      stats.errors.push({
        message: 'این مبدأ وردپرس مسیر REST منوها را ارائه نمی‌کند؛ منوها مسدود ماندند.',
        sourceId: 'menus',
      })
      bumpDry(stats, 'blocked')
      await recordDisposition(ctx, {
        disposition: 'blocked',
        raw,
        resource: 'menus',
        sourceRecordId: 'menus',
      }).catch(() => undefined)
    }
  }

  if (ctx.settings.includeComments) {
    for (const commentType of WORDPRESS_COMMENT_TYPES) {
      mergeDryCounts(
        statsFor('comments'),
        await processPages(ctx, {
          checkpointKey: `comments:${commentType}`,
          client: ctx.clients.wp,
          handler: wrap('comments', async (raw) => {
            commentStatusOf(raw)
            commentRatingOf(raw)
            const targetId = raw.post ?? raw.post_id ?? raw.product_id

            if (!plainText(str(asRecord(raw.content).raw) || str(asRecord(raw.content).rendered) || raw.content)) {
              throw new MigrationImportError(
                'COMMENT_BODY_EMPTY',
                'متن دیدگاه خالی است؛ دیدگاه به‌صورت مسدود ثبت شد.',
                'blocked',
              )
            }
            if (
              targetId === undefined ||
              targetId === null ||
              String(targetId).trim() === '' ||
              Number(targetId) === 0
            ) {
              throw new MigrationImportError(
                'COMMENT_TARGET_MISSING',
                'دیدگاه سند مقصد در مبدأ ندارد و بدون مقصد مسدود ماند.',
                'blocked',
              )
            }

            return recordDryDisposition(ctx, {
              metadata: {
                sourceParentId: intOf(raw.parent, 0),
                sourceStatus: str(raw.status),
                sourceTargetId: String(targetId),
              },
              raw,
              resource: 'comments',
              sourceRecordId: sourceRecordIdOf(raw)!,
            })
          }),
          params: {
            context: 'edit',
            order: 'asc',
            orderby: 'id',
            status: WORDPRESS_COMMENTS_STATUS,
            type: commentType,
          },
          path: WORDPRESS_COMMENTS_PATH,
          resource: 'comments',
        }),
      )
    }
  }

  const redirectAssessment = await assessMigrationRedirects(ctx)
  const reportResources = [...statsByResource.values()].map((stats) => ({
    archived: stats.archived,
    blocked: stats.blocked,
    errors: stats.errors,
    resource: stats.resource,
    seen: stats.seen,
    unchanged: stats.unchanged,
    wouldCreate: stats.wouldCreate,
    wouldUpdate: stats.wouldUpdate,
  }))
  const blockers = [
    ...inventory.warnings.filter((warning) => warning.severity === 'blocking').map((warning) => warning.message),
    ...coverageBlockers(ctx.coverage).map((row) => `${row.label}: ${row.reason}`),
    ...moneyChecks.filter((check) => !check.ok).map((check) => `سفارش مبدأ ${check.orderSourceId}: ${check.message}`),
    ...redirectAssessment.problems.map((problem) => `تغییرمسیر ${problem.from}: ${problem.kind}`),
  ]
  if (inventory.hasWooCommerce && includeCommerce && !commerceAllowed(ctx)) {
    blockers.push('داده‌های فروشگاه روی سایت غیرفروشگاهی وارد نمی‌شوند؛ سایت مقصد باید فروشگاهی باشد.')
  }
  const blockedOrErrors = reportResources.reduce(
    (sum, row) => sum + row.blocked + row.errors.length,
    0,
  )
  const report: DryRunReport = {
    blockers,
    installation: ctx.installation,
    moneyChecks,
    readyToImport: blockers.length === 0 && blockedOrErrors === 0,
    resources: reportResources,
    siteId: ctx.siteId,
    unknownMetaKeysByResource: Object.fromEntries(
      [...unknownByResource.entries()].map(([resource, keys]) => [resource, [...keys].sort()]),
    ),
  }

  // Keep the pure foundation report builder in the type contract even though
  // this streaming engine produces the same shape without holding a whole
  // store in memory as samples.
  void buildDryRunReport

  await updateJob(ctx, {
    blockers,
    dryRunReport: report,
    phase: 'dry-run',
    summary: { dryRunAt: nowIso(), readyToImport: report.readyToImport },
  })
  await recordMigrationAudit(ctx.req, {
    action: 'job.dry-run',
    details: { blockers: blockers.length, resources: reportResources.length },
    jobId: ctx.jobId,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    summary: report.readyToImport
      ? 'اجرای خشک کامل شد و مانع شناخته‌شده‌ای برای ورود نیست.'
      : 'اجرای خشک کامل شد؛ مانع‌ها و رکوردهای مسدود در گزارش آمده‌اند.',
  })

  return report
}

// --- Import / sync ---------------------------------------------------------------

const expectedImportResources = (ctx: Ctx): Set<string> => {
  const resources = new Set<string>(['content-type-definition', 'taxonomy-definition'])
  const inventory = ctx.inventory

  if (inventory) {
    for (const taxonomy of inventory.taxonomies) {
      if (!INTERNAL_TAXONOMIES.has(taxonomy.slug)) resources.add(`taxonomy:${taxonomy.slug}`)
    }
    if (ctx.settings.includeContent) {
      for (const type of inventory.postTypes) {
        if (['core-page', 'core-post', 'custom'].includes(type.capability)) {
          resources.add(`post-type:${type.slug}`)
        }
      }
      resources.add('entry-term')
      resources.add('content-relation')
    }
  }
  if (ctx.settings.includeMedia) resources.add('media')
  if (ctx.settings.includeMenus) resources.add('menus')
  if (ctx.settings.includeComments) resources.add('comments')
  if (commerceAllowed(ctx)) {
    if (ctx.settings.includeProducts) resources.add('product')
    if (ctx.settings.includeCustomers) resources.add('customers')
    if (ctx.settings.includeCoupons) resources.add('coupons')
    if (ctx.settings.includeOrders) resources.add('orders')
  }

  return resources
}

const markMissingAtSource = async (ctx: Ctx): Promise<number> => {
  if (ctx.modifiedAfter || ctx.resume) return 0

  const resources = expectedImportResources(ctx)
  const records = await allDocs(ctx.req, 'migration-records', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      { updatedAt: { less_than: ctx.startedAt } },
      { disposition: { in: ['archived', 'imported', 'planned', 'unchanged', 'updated'] } },
    ],
  })
  let marked = 0

  for (const record of records) {
    if (!resources.has(str(record.resource))) continue
    await ctx.req.payload.update({
      id: String(record.id),
      collection: 'migration-records',
      data: { disposition: 'deleted' } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
    marked += 1
    await recordMigrationEvent(ctx.req, {
      eventType: 'sync.deleted-at-source',
      jobId: ctx.jobId,
      level: 'warning',
      message: 'رکورد در اسکن کامل تازه مبدأ دیگر دیده نشد؛ سند مقصد حذف نشده و برای تصمیم مالک نگه داشته شده است.',
      resource: str(record.resource),
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
      sourceRecordId: str(record.sourceRecordId),
    })
  }

  return marked
}

export const runImportLike = async (
  ctx: Ctx,
  { forceRedirects = false }: { forceRedirects?: boolean } = {},
): Promise<{ deletedAtSource: number; redirects: Awaited<ReturnType<typeof applyMigrationRedirects>> }> => {
  await loadDefinitionCaches(ctx)
  await updateJob(ctx, { phase: 'definitions' })
  await importDefinitions(ctx)
  await loadDefinitionCaches(ctx)
  await updateJob(ctx, { phase: 'terms' })
  await importTerms(ctx)
  await updateJob(ctx, { phase: 'media' })
  await importMedia(ctx)
  await updateJob(ctx, { phase: 'content' })
  await importContent(ctx)

  if (ctx.inventory?.hasWooCommerce) {
    await updateJob(ctx, { phase: 'products' })
    await importProducts(ctx)
    await updateJob(ctx, { phase: 'customers' })
    await importCustomers(ctx)
    await updateJob(ctx, { phase: 'coupons' })
    await importCoupons(ctx)
    await updateJob(ctx, { phase: 'orders' })
    await importOrders(ctx)
    if (commerceAllowed(ctx) && ctx.settings.includeProducts) {
      await updateJob(ctx, { phase: 'stock' })
      await applyCurrentStock(ctx)
    }
  }

  await updateJob(ctx, { phase: 'relationships' })
  await syncAcfRelationships(ctx)
  await updateJob(ctx, { phase: 'menus' })
  await importMenus(ctx)
  await updateJob(ctx, { phase: 'comments' })
  await importComments(ctx)

  const deletedAtSource = await markMissingAtSource(ctx)
  await updateJob(ctx, { phase: 'redirects' })
  const redirects = await applyMigrationRedirects(ctx, { force: forceRedirects })
  if (redirects.conflicts > 0) ctx.counts.blocked += redirects.conflicts

  await recordMigrationAudit(ctx.req, {
    action: `job.${ctx.operation === 'cutover' ? 'sync' : ctx.operation}`,
    details: { counts: ctx.counts, deletedAtSource, redirects },
    jobId: ctx.jobId,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    summary: 'مرحله ورود/هم‌گام‌سازی پایان یافت؛ شمارش و تغییرمسیرها در دفتر مهاجرت ثبت شده‌اند.',
  })

  return { deletedAtSource, redirects }
}

// --- Reconciliation ---------------------------------------------------------------

export type ReconciliationIssue = {
  blocking: boolean
  code: string
  message: string
  resource?: string
  sourceRecordId?: string
}

export type ReconciliationReport = {
  checkedAt: string
  counts: {
    expected: number
    fieldMismatches: number
    missingDestinations: number
    missingLedger: number
    notImported: number
    openErrors: number
    orphans: number
    redirectProblems: number
    stale: number
    verified: number
  }
  issueCounts: Record<string, number>
  issues: ReconciliationIssue[]
  ok: boolean
  totals: {
    destinationOrders: number
    destinationOrderTotal: number
    destinationRefunds: number
    sourceOrders: number
    sourceOrderTotal: number
    sourceRefunds: number
  }
}

type ExpectedRecord = {
  collection: null | string
  hash: string
  raw: RawRecord
  resource: string
  sourceRecordId: string
}

const collectionForResource = (
  ctx: Ctx,
  resource: string,
): null | string => {
  if (resource === 'taxonomy-definition') return 'taxonomy-definitions'
  if (resource === 'content-type-definition') return 'content-type-definitions'
  if (resource === 'taxonomy:category') return 'categories'
  if (resource.startsWith('taxonomy:')) return 'taxonomy-terms'
  if (resource === 'media') return 'media'
  if (resource === 'post-type:post') return 'posts'
  if (resource === 'post-type:page') return 'pages'
  if (resource.startsWith('post-type:')) return 'content-entries'
  if (resource === 'product') return 'products'
  if (resource === 'customers') return 'customers'
  if (resource === 'coupons') return 'coupons'
  if (resource === 'orders') return 'orders'
  if (resource === 'menus') return 'menus'
  if (resource === 'comments') return 'comments'
  if (resource === 'entry-term') return 'entry-term-relations'
  if (resource === 'content-relation') return 'content-relations'
  void ctx
  return null
}

export const runReconciliation = async (ctx: Ctx): Promise<ReconciliationReport> => {
  if (!ctx.inventory) throw new Error('پیش از تطبیق، کشف مبدأ لازم است.')

  await loadDefinitionCaches(ctx)
  await updateJob(ctx, { phase: 'reconcile' })

  const inventory = ctx.inventory
  const expected = new Map<string, ExpectedRecord>()
  const expectedRedirects: RedirectExpectation[] = []
  const issues: ReconciliationIssue[] = []
  const issueCounts: Record<string, number> = {}
  const orderTotals = new Map<string, ReturnType<typeof convertedOrder>>()
  const totals: ReconciliationReport['totals'] = {
    destinationOrders: 0,
    destinationOrderTotal: 0,
    destinationRefunds: 0,
    sourceOrders: 0,
    sourceOrderTotal: 0,
    sourceRefunds: 0,
  }
  const addIssue = (issue: ReconciliationIssue): void => {
    issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1
    if (issues.length < 200) issues.push(issue)
  }
  const addExpected = (
    resource: string,
    raw: RawRecord,
    hashRaw: RawRecord = raw,
    sourceRecordId = sourceRecordIdOf(raw),
  ): void => {
    if (!sourceRecordId) {
      addIssue({
        blocking: true,
        code: 'SOURCE_ID_MISSING',
        message: 'رکورد مبدأ شناسه ندارد و قابل تطبیق نیست.',
        resource,
      })
      return
    }

    expected.set(`${resource}:${sourceRecordId}`, {
      collection: collectionForResource(ctx, resource),
      hash: contentHashOf(redactRawPayload(hashRaw)),
      raw,
      resource,
      sourceRecordId,
    })
    const redirect = redirectExpectation(ctx, resource, raw)
    if (redirect) expectedRedirects.push(redirect)
  }
  const scan = async ({
    client,
    params,
    path,
    prepare,
    resource,
  }: {
    client: Ctx['clients']['wp']
    params?: Record<string, string>
    path: string
    prepare?: (raw: RawRecord) => Promise<RawRecord>
    resource: string
  }): Promise<void> => {
    for await (const { items } of client.pages<RawRecord>(path, params)) {
      await checkControl(ctx)
      for (const raw of items) {
        await checkControl(ctx)
        try {
          const hashRaw = prepare ? await prepare(raw) : raw
          addExpected(resource, raw, hashRaw)
        } catch (error) {
          const sourceRecordId = sourceRecordIdOf(raw) ?? undefined
          addExpected(resource, raw)
          addIssue({
            blocking: true,
            code:
              error instanceof MigrationImportError
                ? error.code
                : 'SOURCE_VALIDATION_FAILED',
            message: safeErrorMessage(error),
            resource,
            sourceRecordId,
          })
        }
      }
    }
  }

  for (const taxonomy of inventory.taxonomies) {
    if (taxonomy.slug !== 'category' && !INTERNAL_TAXONOMIES.has(taxonomy.slug)) {
      addExpected('taxonomy-definition', taxonomy as unknown as RawRecord, taxonomy as unknown as RawRecord, taxonomy.slug)
    }
  }
  for (const type of inventory.postTypes) {
    if (type.capability === 'custom') {
      addExpected('content-type-definition', type as unknown as RawRecord, type as unknown as RawRecord, type.slug)
    }
  }

  for (const taxonomy of inventory.taxonomies) {
    if (INTERNAL_TAXONOMIES.has(taxonomy.slug)) continue
    const path = wpTaxonomyPath(taxonomy)
    if (!path) continue
    await scan({
      client: ctx.clients.wp,
      params: { context: 'edit', hide_empty: 'false', order: 'asc', orderby: 'id' },
      path,
      resource: `taxonomy:${taxonomy.slug}`,
    })
  }

  if (ctx.settings.includeMedia) {
    await scan({
      client: ctx.clients.wp,
      params: { context: 'edit', order: 'asc', orderby: 'id' },
      path: '/wp-json/wp/v2/media',
      prepare: async (raw) => {
        if (!SUPPORTED_MEDIA.has(str(raw.mime_type))) {
          throw new MigrationImportError('UNSUPPORTED_MEDIA', 'گونه رسانه در مقصد پشتیبانی نمی‌شود.', 'blocked')
        }
        return raw
      },
      resource: 'media',
    })
  }

  if (ctx.settings.includeContent) {
    for (const type of inventory.postTypes) {
      if (!['core-page', 'core-post', 'custom'].includes(type.capability)) continue
      const path = wpTypePath(type)
      if (!path) continue
      const attachedTaxonomies = inventory.taxonomies.filter(
        (taxonomy) => type.taxonomies.includes(taxonomy.slug) && !INTERNAL_TAXONOMIES.has(taxonomy.slug),
      )
      await scan({
        client: ctx.clients.wp,
        params: { context: 'edit', order: 'asc', orderby: 'id', status: 'any' },
        path,
        prepare: async (raw) => {
          if (type.capability !== 'custom') return raw

          const sourceRecordId = sourceRecordIdOf(raw)
          const status = mapWordPressStatus(str(raw.status) || 'draft')
          if (!sourceRecordId || status.disposition === 'archive-only') return raw

          // Entry-term and explicit ACF edges have no source endpoint of
          // their own; they are deterministic projections of this entry.
          // Rebuild their exact synthetic ledger rows here, otherwise a
          // deleted edge destination could hide behind a verified parent.
          for (const taxonomy of attachedTaxonomies) {
            if (taxonomy.slug === 'category') continue
            const sourceTermIds = asArray(
              raw[taxonomy.slug] ?? (taxonomy.restBase ? raw[taxonomy.restBase] : undefined),
            )

            for (const termSourceId of sourceTermIds) {
              const relationRaw = entryTermRelationRaw(sourceRecordId, taxonomy.slug, termSourceId)
              addExpected('entry-term', relationRaw, relationRaw, String(relationRaw.id))
            }
          }

          const definition = ctx.typeDefinitions.get(type.slug)
          if (definition) {
            const values = customValuesOf(raw)

            for (const field of asArray(definition.fieldSchema) as Loose[]) {
              if (str(field.fieldType) !== 'relationship' || !relationshipFieldSupported(field)) {
                continue
              }

              const fieldKey = str(field.key)
              const relationTo = str(field.relationTo)
              if (!fieldKey || !CONTENT_RELATION_TARGET_FIELDS[relationTo]) continue
              if (relationTo === 'media' && !ctx.settings.includeMedia) continue

              const targetSourceIds = [
                ...new Set(sourceIdsFromRelationValue(values[fieldKey] ?? null)),
              ]

              for (const targetSourceId of targetSourceIds) {
                const relationRaw = acfContentRelationRaw(
                  sourceRecordId,
                  fieldKey,
                  relationTo,
                  targetSourceId,
                )
                addExpected('content-relation', relationRaw, relationRaw, String(relationRaw.id))
              }
            }
          }

          return raw
        },
        resource: `post-type:${type.slug}`,
      })
    }
  }

  const includeCommerce =
    ctx.settings.includeProducts ||
    ctx.settings.includeCustomers ||
    ctx.settings.includeCoupons ||
    ctx.settings.includeOrders

  if (inventory.hasWooCommerce && includeCommerce) {
    if (!commerceAllowed(ctx)) {
      addIssue({
        blocking: true,
        code: 'COMMERCE_SITE_REQUIRED',
        message: 'داده‌های فروشگاه روی سایت غیرفروشگاهی قابل تطبیق نیستند.',
      })
    } else if (!ctx.clients.woo) {
      addIssue({
        blocking: true,
        code: 'WOO_CREDENTIALS_MISSING',
        message: 'اعتبارنامه ووکامرس برای تطبیق فروشگاه لازم است.',
      })
    } else {
      const woo = ctx.clients.woo

      if (ctx.settings.includeProducts) {
        await scan({
          client: woo,
          params: { order: 'asc', orderby: 'id', status: 'any' },
          path: '/wp-json/wc/v3/products',
          prepare: async (raw) => {
            const type = str(raw.type) || 'simple'
            if (!['external', 'grouped', 'simple', 'variable'].includes(type)) {
              throw new MigrationImportError('UNSUPPORTED_PRODUCT_TYPE', `گونه محصول «${type}» معادل بومی ندارد.`, 'blocked')
            }
            const variations = await variationRows(ctx, raw)
            return { ...raw, __eshobe_variations: variations }
          },
          resource: 'product',
        })
      }
      if (ctx.settings.includeCustomers) {
        await scan({
          client: woo,
          params: { order: 'asc', orderby: 'id' },
          path: '/wp-json/wc/v3/customers',
          resource: 'customers',
        })
      }
      if (ctx.settings.includeCoupons) {
        await scan({
          client: woo,
          params: { order: 'asc', orderby: 'id' },
          path: '/wp-json/wc/v3/coupons',
          resource: 'coupons',
        })
      }
      if (ctx.settings.includeOrders) {
        await scan({
          client: woo,
          params: { order: 'asc', orderby: 'id', status: 'any' },
          path: '/wp-json/wc/v3/orders',
          prepare: async (raw) => {
            const converted = convertedOrder(ctx, raw)
            const sourceRecordId = sourceRecordIdOf(raw)!
            let refundRows = asArray(raw.refunds) as RawRecord[]

            if (refundRows.length > 0) {
              refundRows = (await woo
                .collect(`/wp-json/wc/v3/orders/${sourceRecordId}/refunds`)
                .catch(() => refundRows)) as RawRecord[]
            }
            orderTotals.set(sourceRecordId, converted)
            totals.sourceOrders += 1
            totals.sourceOrderTotal += converted.total
            totals.sourceRefunds += refundRows.reduce(
              (sum, refund) => sum + Math.abs(money(ctx, refund.amount ?? refund.total)),
              0,
            )

            return { ...raw, __eshobe_refunds: refundRows }
          },
          resource: 'orders',
        })
      }
    }
  }

  if (ctx.settings.includeMenus) {
    try {
      const aggregate = await collectWordPressMenus(ctx)

      for (const menu of aggregate.menus) {
        const sourceRecordId = sourceRecordIdOf(menu) ?? undefined
        const items = sourceRecordId ? (aggregate.itemsByMenu.get(sourceRecordId) ?? []) : []
        const raw = menuAggregateRaw(menu, items)

        addExpected('menus', menu, raw, sourceRecordId)
        if (items.length > 1_000) {
          addIssue({
            blocking: true,
            code: 'MENU_TOO_LARGE',
            message: 'منو بیش از سقف ۱۰۰۰ آیتم دارد و برای تقسیم دستی مسدود ماند.',
            resource: 'menus',
            sourceRecordId,
          })
        }
      }

      for (const orphan of menuOrphanRecords(aggregate.orphanItems)) {
        addExpected('menus', orphan.raw, orphan.raw, orphan.sourceRecordId)
        addIssue({
          blocking: true,
          code: 'MENU_ITEM_MENU_MISSING',
          message: orphan.claimedMenuIds.length
            ? `آیتم منو به منویی اشاره می‌کند که endpoint منوها برنگرداند (${orphan.claimedMenuIds.join('، ')}).`
            : 'آیتم منو هیچ منوی مبدأ قابل کشف ندارد.',
          resource: 'menus',
          sourceRecordId: orphan.sourceRecordId,
        })
      }
    } catch (error) {
      addExpected(
        'menus',
        { endpoint: '/wp-json/wp/v2/menus', id: 'menus' },
        { endpoint: '/wp-json/wp/v2/menus', id: 'menus' },
        'menus',
      )
      addIssue({
        blocking: true,
        code:
          error instanceof WordPressApiError &&
          (error.status === 404 || /no_route|not_found/i.test(error.code ?? ''))
            ? 'MENUS_ENDPOINT_UNAVAILABLE'
            : 'MENUS_SCAN_FAILED',
        message: safeErrorMessage(error),
        resource: 'menus',
        sourceRecordId: 'menus',
      })
    }
  }

  if (ctx.settings.includeComments) {
    for (const commentType of WORDPRESS_COMMENT_TYPES) {
      await scan({
        client: ctx.clients.wp,
        params: {
          context: 'edit',
          order: 'asc',
          orderby: 'id',
          status: WORDPRESS_COMMENTS_STATUS,
          type: commentType,
        },
        path: WORDPRESS_COMMENTS_PATH,
        prepare: async (raw) => {
          commentStatusOf(raw)
          commentRatingOf(raw)
          return raw
        },
        resource: 'comments',
      })
    }
  }

  // A WP comment hash cannot prove a Woo review rating: core's comments
  // endpoint commonly returns empty meta for the unregistered Woo rating.
  // Read Woo's own reviews endpoint again here and compare the destination
  // numbers below, rather than trusting the import post-pass that wrote them.
  const expectedReviewRatings = new Map<string, number>()
  if (ctx.settings.includeComments) {
    const reviewIds = new Set<string>()

    for (const item of expected.values()) {
      if (item.resource !== 'comments' || str(item.raw.type) !== 'review') continue
      reviewIds.add(item.sourceRecordId)
      try {
        const wpRating = commentRatingOf(item.raw)
        if (wpRating !== null) expectedReviewRatings.set(item.sourceRecordId, wpRating)
      } catch {
        // The scan's prepare step already recorded this invalid source row.
      }
    }

    if (inventory.hasWooCommerce && reviewIds.size) {
      if (!ctx.clients.woo) {
        addIssue({
          blocking: true,
          code: 'WOO_REVIEW_RATINGS_UNAVAILABLE',
          message: 'کلیدهای ووکامرس برای راستی‌آزمایی مستقل امتیاز بازخوردها در دسترس نیستند.',
          resource: 'comments',
        })
      } else {
        try {
          const wooRatings = await collectWooReviewRatings(ctx.clients.woo)

          for (const [sourceRecordId, rating] of wooRatings) {
            if (!reviewIds.has(sourceRecordId)) {
              addIssue({
                blocking: true,
                code: 'WOO_REVIEW_NOT_IN_WP_SCAN',
                message: 'ووکامرس بازخوردی دارد که در اسکن دیدگاه‌های وردپرس دیده نشد.',
                resource: 'comments',
                sourceRecordId,
              })
              continue
            }
            expectedReviewRatings.set(sourceRecordId, rating)
          }
          for (const sourceRecordId of reviewIds) {
            if (!wooRatings.has(sourceRecordId) && !expectedReviewRatings.has(sourceRecordId)) {
              addIssue({
                blocking: true,
                code: 'WOO_REVIEW_RATING_MISSING',
                message: 'امتیاز این بازخورد نه از ووکامرس و نه از فراداده وردپرس قابل راستی‌آزمایی نیست.',
                resource: 'comments',
                sourceRecordId,
              })
            }
          }
        } catch (error) {
          addIssue({
            blocking: true,
            code:
              error instanceof MigrationImportError
                ? error.code
                : 'WOO_REVIEW_RATINGS_UNAVAILABLE',
            message: safeErrorMessage(error),
            resource: 'comments',
          })
        }
      }
    }
  }

  const ledger = await allDocs(ctx.req, 'migration-records', {
    and: [{ site: { equals: ctx.siteId } }, { source: { equals: ctx.sourceId } }],
  })
  const ledgerByKey = new Map(
    ledger.map((record) => [`${str(record.resource)}:${str(record.sourceRecordId)}`, record]),
  )
  const counts: ReconciliationReport['counts'] = {
    expected: expected.size,
    fieldMismatches: 0,
    missingDestinations: 0,
    missingLedger: 0,
    notImported: 0,
    openErrors: 0,
    orphans: 0,
    redirectProblems: 0,
    stale: 0,
    verified: 0,
  }

  for (const item of expected.values()) {
    const record = ledgerByKey.get(`${item.resource}:${item.sourceRecordId}`)

    if (!record) {
      counts.missingLedger += 1
      addIssue({
        blocking: true,
        code: 'SOURCE_NOT_IN_LEDGER',
        message: 'رکورد در مبدأ هست اما در دفتر مهاجرت هیچ ردی ندارد.',
        resource: item.resource,
        sourceRecordId: item.sourceRecordId,
      })
      continue
    }

    const disposition = str(record.disposition)
    const sourceStatus =
      item.resource.startsWith('post-type:')
        ? mapWordPressStatus(str(item.raw.status) || 'draft')
        : null
    const archiveExpected = sourceStatus?.disposition === 'archive-only'

    if (
      disposition === 'planned' ||
      disposition === 'blocked' ||
      disposition === 'error' ||
      disposition === 'deleted' ||
      disposition === 'rolled-back'
    ) {
      counts.notImported += 1
      addIssue({
        blocking: true,
        code: 'RECORD_NOT_IMPORTED',
        message: `رکورد در دفتر با وضعیت «${disposition}» مانده و هنوز مقصد قابل اتکایی ندارد.`,
        resource: item.resource,
        sourceRecordId: item.sourceRecordId,
      })
      continue
    }
    if (disposition === 'archived') {
      if (archiveExpected) counts.verified += 1
      else {
        counts.notImported += 1
        addIssue({
          blocking: true,
          code: 'RECORD_ARCHIVED_UNEXPECTEDLY',
          message: 'رکورد فقط بایگانی شده، در حالی که وضعیت مبدأ ورود بومی انتظار داشت.',
          resource: item.resource,
          sourceRecordId: item.sourceRecordId,
        })
      }
      continue
    }
    if (str(record.contentHash) !== item.hash) {
      counts.stale += 1
      addIssue({
        blocking: true,
        code: 'STALE_IMPORT',
        message: 'هش محتوای مبدأ با آخرین ورود یکی نیست؛ مقصد از مبدأ عقب مانده است.',
        resource: item.resource,
        sourceRecordId: item.sourceRecordId,
      })
      continue
    }

    const collection = strOrNull(record.destinationCollection) ?? item.collection
    const destinationId = strOrNull(record.destinationId)

    if (!collection || !destinationId) {
      counts.missingDestinations += 1
      addIssue({
        blocking: true,
        code: 'DESTINATION_MISSING',
        message: 'دفتر ورود را ثبت کرده اما سند مقصد ندارد.',
        resource: item.resource,
        sourceRecordId: item.sourceRecordId,
      })
      continue
    }

    const doc = await findDestinationDoc(ctx, collection, destinationId)

    if (!doc) {
      counts.missingDestinations += 1
      addIssue({
        blocking: true,
        code: 'DESTINATION_MISSING',
        message: 'سند مقصد ثبت‌شده در دفتر پیدا نشد یا متعلق به سایت دیگری است.',
        resource: item.resource,
        sourceRecordId: item.sourceRecordId,
      })
      continue
    }

    if (item.resource === 'orders') {
      const converted = orderTotals.get(item.sourceRecordId)
      const refundTotal = (asArray(doc.refunds) as Loose[]).reduce(
        (sum, refund) => sum + Number(refund.amount ?? 0),
        0,
      )
      totals.destinationOrders += 1
      totals.destinationOrderTotal += Number(doc.total ?? 0)
      totals.destinationRefunds += refundTotal

      if (
        !converted ||
        Number(doc.total) !== converted.total ||
        Number(doc.subtotal) !== converted.subtotal ||
        Number(doc.discountTotal) !== converted.discountTotal ||
        Number(doc.shippingTotal) !== converted.shippingTotal ||
        Number(doc.taxTotal) !== converted.taxTotal ||
        asArray(doc.items).length !== converted.items.length
      ) {
        addIssue({
          blocking: true,
          code: 'ORDER_MONEY_MISMATCH',
          message: 'جمع‌ها یا شمار سطرهای سفارش مقصد با سفارش مبدأ برابر نیست.',
          resource: item.resource,
          sourceRecordId: item.sourceRecordId,
        })
        continue
      }
    }

    if (
      item.resource === 'comments' &&
      str(item.raw.type) === 'review' &&
      expectedReviewRatings.has(item.sourceRecordId)
    ) {
      const expectedRating = expectedReviewRatings.get(item.sourceRecordId)!
      if (
        doc.commentType !== 'review' ||
        Boolean(doc.parent) ||
        typeof doc.rating !== 'number' ||
        doc.rating !== expectedRating
      ) {
        counts.fieldMismatches += 1
        addIssue({
          blocking: true,
          code: 'WOO_REVIEW_RATING_MISMATCH',
          message: 'امتیاز بازخورد مقصد با امتیاز خوانده‌شده از ووکامرس برابر نیست.',
          resource: item.resource,
          sourceRecordId: item.sourceRecordId,
        })
        continue
      }
    }

    counts.verified += 1
  }

  // The orphan check must use the job's in-scope resource universe, not only
  // resources that happened to produce at least one expected row in this
  // scan. If every edge (or every record of a type) disappeared at the
  // source, the resource name would otherwise vanish too and all its stale
  // destinations would be ignored.
  const expectedResourceNames = new Set<string>([
    ...expectedImportResources(ctx),
    ...[...expected.values()].map((item) => item.resource),
  ])

  for (const record of ledger) {
    const key = `${str(record.resource)}:${str(record.sourceRecordId)}`
    if (expected.has(key) || !expectedResourceNames.has(str(record.resource))) continue
    if (!['archived', 'imported', 'planned', 'unchanged', 'updated'].includes(str(record.disposition))) {
      continue
    }
    counts.orphans += 1
    addIssue({
      blocking: true,
      code: 'LEDGER_ORPHAN',
      message: 'دفتر برای رکوردی مقصد دارد که در اسکن تازه مبدأ دیگر نیست.',
      resource: str(record.resource),
      sourceRecordId: str(record.sourceRecordId),
    })
  }

  const openErrors = await allDocs(ctx.req, 'migration-errors', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      { status: { equals: 'open' } },
    ],
  })
  counts.openErrors = openErrors.length
  if (openErrors.length) {
    addIssue({
      blocking: true,
      code: 'OPEN_MIGRATION_ERRORS',
      message: `${openErrors.length} خطای باز مهاجرت هنوز تعیین تکلیف نشده است.`,
    })
  }

  for (const row of coverageBlockers(ctx.coverage)) {
    addIssue({
      blocking: true,
      code: 'COVERAGE_BLOCKER',
      message: `${row.label}: ${row.reason}`,
      resource: row.resource,
    })
  }

  await planMigrationRedirectsFromLedger(ctx)
  const redirectRows = await allDocs(ctx.req, 'migration-redirects', {
    and: [{ site: { equals: ctx.siteId } }, { source: { equals: ctx.sourceId } }],
  })
  const redirectByFrom = new Map(redirectRows.map((row) => [str(row.fromUrl), row]))
  const redirectAssessment = await assessMigrationRedirects(ctx)
  counts.redirectProblems += redirectAssessment.problems.length

  for (const problem of redirectAssessment.problems) {
    addIssue({
      blocking: true,
      code: 'REDIRECT_GRAPH_PROBLEM',
      message: `تغییرمسیر ${problem.from} ناسازگار است (${problem.kind}).`,
    })
  }
  for (const expectation of expectedRedirects) {
    if (expectation.fromUrl === expectation.toUrl) continue
    const row = redirectByFrom.get(expectation.fromUrl)

    if (!row) {
      counts.redirectProblems += 1
      addIssue({
        blocking: true,
        code: 'REDIRECT_MISSING',
        message: 'نشانی عمومی مبدأ جابه‌جا شده اما در فهرست تغییرمسیرها نیست.',
        resource: expectation.resource,
        sourceRecordId: expectation.sourceRecordId,
      })
      continue
    }
    if (str(row.toUrl) !== expectation.toUrl || row.status === 'conflict') {
      counts.redirectProblems += 1
      addIssue({
        blocking: true,
        code: 'REDIRECT_CONFLICT',
        message: 'قاعده تغییرمسیر مقصد با نشانی تازه سند هم‌خوان نیست یا ناسازگار مانده است.',
        resource: expectation.resource,
        sourceRecordId: expectation.sourceRecordId,
      })
      continue
    }
    if (row.status !== 'applied') {
      counts.redirectProblems += 1
      addIssue({
        blocking: true,
        code: 'REDIRECT_NOT_APPLIED',
        message: 'قاعده تغییرمسیر هنوز به تغییرمسیرهای زنده سایت اعمال نشده است.',
        resource: expectation.resource,
        sourceRecordId: expectation.sourceRecordId,
      })
      continue
    }

    const redirectId = idOf(row.redirect)
    const redirectDoc = redirectId
      ? await findDestinationDoc(ctx, 'redirects', redirectId)
      : null
    if (!redirectDoc || str(asRecord(redirectDoc.to).url) !== expectation.toUrl) {
      counts.redirectProblems += 1
      addIssue({
        blocking: true,
        code: 'REDIRECT_TARGET_MISMATCH',
        message: 'قاعده زنده سایت با مقصد ثبت‌شده در فهرست مهاجرت برابر نیست.',
        resource: expectation.resource,
        sourceRecordId: expectation.sourceRecordId,
      })
    }
  }

  if (
    totals.sourceOrders !== totals.destinationOrders ||
    totals.sourceOrderTotal !== totals.destinationOrderTotal ||
    totals.sourceRefunds !== totals.destinationRefunds
  ) {
    addIssue({
      blocking: true,
      code: 'ORDER_AGGREGATE_MISMATCH',
      message: 'سرجمع شمار سفارش‌ها، مبلغ سفارش‌ها یا بازپرداخت‌ها میان مبدأ و مقصد برابر نیست.',
      resource: 'orders',
    })
  }

  const report: ReconciliationReport = {
    checkedAt: nowIso(),
    counts,
    issueCounts,
    issues,
    ok: !issues.some((issue) => issue.blocking) && Object.values(issueCounts).length === 0,
    totals,
  }
  report.ok =
    counts.fieldMismatches === 0 &&
    counts.missingLedger === 0 &&
    counts.missingDestinations === 0 &&
    counts.notImported === 0 &&
    counts.openErrors === 0 &&
    counts.orphans === 0 &&
    counts.redirectProblems === 0 &&
    counts.stale === 0 &&
    Object.keys(issueCounts).length === 0

  await updateJob(ctx, {
    blockers: issues.filter((issue) => issue.blocking).map((issue) => issue.message),
    phase: 'reconcile',
    reconciliationReport: report,
    summary: { reconciliationAt: report.checkedAt, reconciliationOk: report.ok },
  })
  await recordMigrationAudit(ctx.req, {
    action: 'job.reconcile',
    details: { counts, issueCounts, totals },
    jobId: ctx.jobId,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    summary: report.ok
      ? 'تطبیق کامل شد: مبدأ، دفتر مهاجرت، مقصد، پول و تغییرمسیرها هم‌خوان‌اند.'
      : 'تطبیق کامل شد و ناهماهنگی‌های مسدودکننده در گزارش ثبت شده‌اند.',
  })

  if (!report.ok) {
    await recordMigrationError(ctx.req, {
      code: 'RECONCILIATION_FAILED',
      details: { counts, issueCounts },
      error: new Error('تطبیق مهاجرت ناهماهنگی مسدودکننده دارد.'),
      jobId: ctx.jobId,
      retryable: false,
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
    })
    // The reconciliation run itself created this summary error. Close that
    // one row immediately: per-record open errors are the operator's queue,
    // while this report is the durable summary of the same finding.
    const summaries = await allDocs(ctx.req, 'migration-errors', {
      and: [
        { site: { equals: ctx.siteId } },
        { job: { equals: ctx.jobId } },
        { code: { equals: 'RECONCILIATION_FAILED' } },
        { status: { equals: 'open' } },
      ],
    })
    for (const row of summaries) {
      await ctx.req.payload.update({
        id: String(row.id),
        collection: 'migration-errors',
        data: { status: 'resolved' } as never,
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })
    }
  }

  return report
}

// --- Rollback ---------------------------------------------------------------------

const ROLLBACK_ORDER = [
  'comments',
  'menus',
  'orders',
  'entry-term-relations',
  'content-relations',
  'coupons',
  'customers',
  'products',
  'content-entries',
  'posts',
  'pages',
  'taxonomy-terms',
  'categories',
  'media',
  'content-type-definitions',
  'taxonomy-definitions',
]

export const runRollback = async (
  ctx: Ctx,
): Promise<{ conflicts: number; deleted: number; missing: number; redirectsRemoved: number }> => {
  if (ctx.job.cutoverAt) {
    throw new MigrationImportError(
      'ROLLBACK_AFTER_CUTOVER',
      'پس از برش نهایی، بازگشت خودکار ممکن نیست؛ ترافیک و سفارش تازه ممکن است روی مقصد نشسته باشد.',
      'blocked',
    )
  }

  const settings = asRecord(ctx.job.settings)
  const targetJobId =
    strOrNull(settings.targetJobId) ?? strOrNull(settings.rollbackJobId) ?? ctx.jobId
  const records = await allDocs(ctx.req, 'migration-records', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      { job: { equals: targetJobId } },
      { createdByMigration: { equals: true } },
      { destinationId: { exists: true } },
    ],
  })
  const rank = (record: Loose): number => {
    const index = ROLLBACK_ORDER.indexOf(str(record.destinationCollection))
    return index === -1 ? ROLLBACK_ORDER.length : index
  }
  records.sort(
    (a, b) => rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt)),
  )

  let conflicts = 0
  let deleted = 0
  let missing = 0

  for (const record of records) {
    await checkControl(ctx)
    ctx.counts.seen += 1
    const collection = str(record.destinationCollection)
    const destinationId = str(record.destinationId)
    if (!collection || !destinationId || record.disposition === 'rolled-back') continue

    const doc = await findDestinationDoc(ctx, collection, destinationId)

    if (!doc) {
      missing += 1
    } else if (isoOf(doc.updatedAt) !== isoOf(record.destinationUpdatedAt)) {
      conflicts += 1
      ctx.counts.blocked += 1
      await recordMigrationError(ctx.req, {
        code: 'ROLLBACK_CONFLICT',
        error: new Error('سند مقصد پس از ورود دست خورده است و بازگشت آن را حذف نمی‌کند.'),
        jobId: ctx.jobId,
        recordId: String(record.id),
        resource: str(record.resource),
        retryable: false,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId: str(record.sourceRecordId),
      })
      continue
    } else {
      await ctx.req.payload.delete({
        id: destinationId,
        collection: collection as CollectionSlug,
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })
      deleted += 1
      ctx.counts.updated += 1
    }

    await ctx.req.payload.update({
      id: String(record.id),
      collection: 'migration-records',
      data: {
        destinationCollection: null,
        destinationId: null,
        destinationUpdatedAt: null,
        disposition: 'rolled-back',
      } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
  }

  let redirectsRemoved = 0
  const redirectRows = await allDocs(ctx.req, 'migration-redirects', {
    and: [
      { site: { equals: ctx.siteId } },
      { source: { equals: ctx.sourceId } },
      { status: { equals: 'applied' } },
    ],
  })

  for (const row of redirectRows) {
    const redirectId = idOf(row.redirect)
    const redirectDoc = redirectId
      ? await findDestinationDoc(ctx, 'redirects', redirectId)
      : null

    if (redirectDoc && str(asRecord(redirectDoc.to).url) !== str(row.toUrl)) {
      conflicts += 1
      ctx.counts.blocked += 1
      continue
    }
    if (redirectId && redirectDoc) {
      await ctx.req.payload.delete({
        id: redirectId,
        collection: 'redirects',
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })
      redirectsRemoved += 1
    }
    await ctx.req.payload.update({
      id: String(row.id),
      collection: 'migration-redirects',
      data: { redirect: null, status: 'rolled-back' } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
  }

  await recordMigrationAudit(ctx.req, {
    action: 'job.rollback',
    details: { conflicts, deleted, missing, redirectsRemoved, targetJobId },
    jobId: ctx.jobId,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    summary:
      conflicts > 0
        ? 'بازگشت ناتمام ماند؛ سندهای دست‌خورده برای تصمیم دستی نگه داشته شدند.'
        : 'بازگشت کامل شد؛ فقط سندهای ساخته مهاجرت و دست‌نخورده حذف شدند.',
  })

  return { conflicts, deleted, missing, redirectsRemoved }
}

// --- Top-level runner ---------------------------------------------------------------

type RunOutcome = {
  blockers: string[]
  phase: string
  status: MigrationJob['status']
  summary: Loose
}

export const runMigrationJob = async (
  req: PayloadRequest,
  {
    jobId,
    options = {},
    siteId: requestedSiteId,
  }: { jobId: string; options?: MigrationEngineOptions; siteId?: string },
): Promise<MigrationJob | null> => {
  let job = await loadJob(req, jobId, requestedSiteId)
  if (!job) return null

  const siteId = idOf(job.site)
  const sourceId = idOf(job.source)
  if (!siteId || !sourceId) return job
  if (TERMINAL_JOB_STATUSES.has(String(job.status))) return job
  if (job.control === 'pause' || job.control === 'cancel') return job

  if (job.status === 'running' && job.lockedAt) {
    const lockedAge = Date.now() - Date.parse(String(job.lockedAt))
    if (Number.isFinite(lockedAge) && lockedAge < 15 * 60_000) return job
  }

  const operation = String(job.operation) as MigrationOperation
  const priorStatus = String(job.status)
  const checkpoint = asRecord(job.checkpoint)
  // A paused/crashed run is the only run whose checkpoint may skip pages: it
  // alone has no `finishedAt`. Queueing the same operation after a completed
  // run is a fresh scan (for example after an operator declares an ACF
  // relationship destination), not a resume of the finished one.
  const resume =
    checkpoint.operation === operation &&
    !job.finishedAt &&
    ['paused', 'queued', 'running'].includes(priorStatus)
  const runId = randomUUID()
  const startedAt = resume && job.startedAt ? String(job.startedAt) : nowIso()

  job = await patchJob(req, String(job.id), {
    checkpoint: resume
      ? job.checkpoint
      : { operation, resources: {}, runId, updatedAt: nowIso() },
    control: 'run',
    currentRunId: runId,
    finishedAt: null,
    lastError: null,
    lockedAt: nowIso(),
    lockToken: runId,
    phase: 'starting',
    runRequestedAt: null,
    startedAt,
    status: 'running',
  })

  let ctx: Ctx | null = null

  try {
    const [site, source] = await Promise.all([
      req.payload.findByID({
        collection: 'sites',
        depth: 0,
        disableErrors: true,
        id: siteId,
        overrideAccess: true,
        req,
      }) as Promise<Site | null>,
      req.payload.findByID({
        collection: 'migration-sources',
        depth: 0,
        disableErrors: true,
        id: sourceId,
        overrideAccess: true,
        req,
      }) as Promise<MigrationSource | null>,
    ])

    if (!site || !source || idOf(source.site) !== siteId) {
      throw new MigrationImportError(
        'MIGRATION_TENANT_MISMATCH',
        'سایت یا مبدأ این کار پیدا نشد یا به همین سایت تعلق ندارد.',
        'blocked',
      )
    }

    ctx = await buildContext(req, {
      job,
      operation,
      options,
      resume,
      runId,
      site,
      source,
    })
    ctx.startedAt = startedAt

    let outcome: RunOutcome

    if (operation === 'rollback') {
      const rollback = await runRollback(ctx)
      outcome = {
        blockers:
          rollback.conflicts > 0
            ? [`${rollback.conflicts} سند پس از ورود دست خورده و در بازگشت حذف نشده است.`]
            : [],
        phase: 'rollback',
        status: rollback.conflicts > 0 ? 'blocked' : 'rolled-back',
        summary: { rollback },
      }
    } else {
      const discovered = await ensureDiscovery(ctx)
      const discoveryBlockers = [
        ...discovered.inventory.warnings
          .filter((warning) => warning.severity === 'blocking')
          .map((warning) => warning.message),
        ...coverageBlockers(discovered.coverage).map((row) => `${row.label}: ${row.reason}`),
      ]

      switch (operation) {
        case 'discover': {
          outcome = {
            blockers: discoveryBlockers,
            phase: 'discovery',
            status: discoveryBlockers.length ? 'blocked' : 'ready',
            summary: { discoveredAt: nowIso(), woo: discovered.woo },
          }
          break
        }
        case 'dry-run': {
          const report = await runDryRun(ctx)
          outcome = {
            blockers: report.blockers,
            phase: 'dry-run',
            status: report.readyToImport ? 'ready' : 'blocked',
            summary: { dryRunAt: nowIso(), readyToImport: report.readyToImport },
          }
          break
        }
        case 'import':
        case 'sync': {
          const imported = await runImportLike(ctx)
          const clean = ctx.counts.blocked === 0 && ctx.counts.errors === 0
          outcome = {
            blockers: clean
              ? []
              : ['ورود با رکورد مسدود یا خطادار پایان یافت؛ جزئیات در دفتر و خطاهای مهاجرت است.'],
            phase: operation,
            status: clean ? 'ready' : 'blocked',
            summary: { ...imported },
          }
          break
        }
        case 'reconcile': {
          const report = await runReconciliation(ctx)
          outcome = {
            blockers: report.issues.filter((issue) => issue.blocking).map((issue) => issue.message),
            phase: 'reconcile',
            status: report.ok ? 'ready-for-cutover' : 'blocked',
            summary: { reconciliation: report.counts },
          }
          break
        }
        case 'cutover': {
          if (!ctx.job.sourceWriteFenceConfirmedAt) {
            throw new MigrationImportError(
              'WRITE_FENCE_NOT_CONFIRMED',
              'برش نهایی پیش از تأیید توقف نوشتن روی وردپرس انجام نمی‌شود.',
              'blocked',
            )
          }
          const imported = await runImportLike(ctx, { forceRedirects: true })
          if (ctx.counts.blocked > 0 || ctx.counts.errors > 0) {
            outcome = {
              blockers: ['هم‌گام‌سازی نهایی رکورد مسدود یا خطادار دارد؛ برش انجام نشد.'],
              phase: 'cutover-sync',
              status: 'blocked',
              summary: { ...imported },
            }
            break
          }
          const report = await runReconciliation(ctx)
          outcome = report.ok
            ? {
                blockers: [],
                phase: 'cutover',
                status: 'completed',
                summary: { ...imported, cutoverAt: nowIso(), reconciliation: report.counts },
              }
            : {
                blockers: report.issues
                  .filter((issue) => issue.blocking)
                  .map((issue) => issue.message),
                phase: 'cutover-reconcile',
                status: 'blocked',
                summary: { ...imported, reconciliation: report.counts },
              }
          if (report.ok) {
            await recordMigrationAudit(ctx.req, {
              action: 'job.cutover',
              details: { counts: ctx.counts, reconciliation: report.counts },
              jobId: ctx.jobId,
              siteId: ctx.siteId,
              sourceId: ctx.sourceId,
              summary: 'برش نهایی پس از هم‌گام‌سازی در حصار نوشتن و تطبیق کامل انجام شد.',
            })
          }
          break
        }
        default:
          throw new MigrationImportError('UNKNOWN_OPERATION', `عملیات ناشناخته: ${operation}`, 'blocked')
      }
    }

    await checkControl(ctx)
    const finishedAt = nowIso()
    const cleanRun = ctx.counts.blocked === 0 && ctx.counts.errors === 0

    job = await updateJob(ctx, {
      blockers: outcome.blockers,
      counts: ctx.counts,
      currentRunId: null,
      ...(outcome.status === 'completed' && operation === 'cutover'
        ? { cutoverAt: finishedAt }
        : {}),
      finishedAt,
      lastError: null,
      ...(cleanRun && ['cutover', 'import', 'sync'].includes(operation)
        ? { lastSyncAt: startedAt }
        : {}),
      lockedAt: null,
      lockToken: null,
      phase: outcome.phase,
      ...(outcome.status === 'rolled-back' ? { rolledBackAt: finishedAt } : {}),
      status: outcome.status,
      summary: {
        ...(asRecord(ctx.job.summary) as Loose),
        ...outcome.summary,
        counts: ctx.counts,
        finishedAt,
        operation,
        runId,
      },
    })

    if (operation !== 'discover') {
      await updateSource(ctx, {
        lastCheckedAt: finishedAt,
        lastError: outcome.blockers[0] ?? null,
        status: outcome.status === 'blocked' ? 'blocked' : 'ready',
      }).catch(() => undefined)
    }

    return job
  } catch (error) {
    const stopped = error instanceof MigrationStoppedError
    const blocked = error instanceof MigrationImportError && error.disposition === 'blocked'
    const status = stopped
      ? error.control === 'pause'
        ? 'paused'
        : 'cancelled'
      : blocked
        ? 'blocked'
        : 'failed'
    const message = safeErrorMessage(error)

    if (ctx && !stopped) {
      await recordMigrationError(ctx.req, {
        code: error instanceof MigrationImportError ? error.code : 'MIGRATION_ENGINE_ERROR',
        error,
        jobId: ctx.jobId,
        retryable: !blocked,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
      }).catch(() => undefined)
      await recordMigrationAudit(ctx.req, {
        action: `job.${operation}.${status}`,
        jobId: ctx.jobId,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        summary: message,
      }).catch(() => undefined)
    }

    job = await patchJob(req, String(job.id), {
      blockers: blocked ? [message] : (job.blockers ?? []),
      counts: ctx?.counts ?? job.counts,
      currentRunId: null,
      finishedAt: stopped && error.control === 'pause' ? null : nowIso(),
      lastError: stopped ? null : message,
      lockedAt: null,
      lockToken: null,
      phase: operation,
      status,
    }).catch(() => job)

    if (ctx && !stopped) {
      await updateSource(ctx, {
        lastCheckedAt: nowIso(),
        lastError: message,
        status: blocked ? 'blocked' : 'error',
      }).catch(() => undefined)
    }

    return job
  }
}

/** Drain queued jobs oldest-first; the Payload task calls this on its schedule. */
export const runQueuedMigrationJobs = async (
  req: PayloadRequest,
  { limit = 5, options = {} }: { limit?: number; options?: MigrationEngineOptions } = {},
): Promise<MigrationJob[]> => {
  const { docs } = await req.payload.find({
    collection: 'migration-jobs',
    depth: 0,
    limit,
    overrideAccess: true,
    req,
    sort: 'runRequestedAt',
    where: {
      and: [
        { status: { equals: 'queued' } },
        { runRequestedAt: { exists: true } },
        { control: { equals: 'run' } },
      ],
    },
  })
  const results: MigrationJob[] = []

  for (const job of docs as MigrationJob[]) {
    const result = await runMigrationJob(req, {
      jobId: String(job.id),
      options,
      siteId: idOf(job.site) ?? undefined,
    })
    if (result) results.push(result)
  }

  return results
}

export { plainText }
