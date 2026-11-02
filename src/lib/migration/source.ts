import type { PayloadRequest } from 'payload'

import type { MigrationJob, MigrationSource } from '@/payload-types'
import { readMigrationSourceSecrets } from '@/collections/hooks/migrationSecrets'
import { migrationInstallationFingerprint } from '@/collections/hooks/validateMigrationSource'
import { idOf, isUuid } from '@/lib/ids'
import { fingerprintPlatformSecret } from '@/lib/saas/crypto'
import {
  createWooCommerceClient,
  createWordPressClient,
} from '@/lib/wordpress/client'
import {
  validateSourceBaseUrl,
  type HostLookup,
} from '@/lib/wordpress/source-url'

import { recordMigrationAudit, resolveMigrationErrors } from './records'
import type { MigrationOperation, SourceClients } from './types'

/**
 * Source/job lifecycle the wizard endpoints call (issue #166 step 1–2).
 *
 * The site always arrives resolved from the caller's membership — these
 * functions never accept a tenant from a request body — and every document
 * is re-read with an explicit `site` predicate before it is trusted, the
 * same belt-and-braces the CDN/storage services use around `overrideAccess`.
 */

export type MigrationSourceInput = {
  baseUrl: string
  name?: string
  wooConsumerKey?: string
  wooConsumerSecret?: string
  wpApplicationPassword?: string
  wpUsername?: string
}

const findOwn = async <T extends { id: string }>(
  req: PayloadRequest,
  collection: 'migration-jobs' | 'migration-sources',
  id: null | string | undefined,
  siteId: string,
): Promise<null | T> => {
  if (!isUuid(id)) return null

  const { docs } = await req.payload.find({
    collection,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { and: [{ id: { equals: id } }, { site: { equals: siteId } }] },
  })

  return (docs[0] as unknown as T | undefined) ?? null
}

export const findOwnMigrationSource = (
  req: PayloadRequest,
  id: null | string | undefined,
  siteId: string,
): Promise<MigrationSource | null> => findOwn<MigrationSource>(req, 'migration-sources', id, siteId)

export const findOwnMigrationJob = (
  req: PayloadRequest,
  id: null | string | undefined,
  siteId: string,
): Promise<MigrationJob | null> => findOwn<MigrationJob>(req, 'migration-jobs', id, siteId)

const credentialsSummary = ({
  wooConsumerKey,
  wooConsumerSecret,
  wpApplicationPassword,
  wpUsername,
}: {
  wooConsumerKey?: null | string
  wooConsumerSecret?: null | string
  wpApplicationPassword?: null | string
  wpUsername?: null | string
}): string => {
  const parts = [
    wpUsername && wpApplicationPassword
      ? `وردپرس: ${wpUsername} · ${fingerprintPlatformSecret(wpApplicationPassword)}`
      : 'وردپرس: بدون اعتبارنامه',
    wooConsumerKey && wooConsumerSecret
      ? `ووکامرس: ${fingerprintPlatformSecret(wooConsumerKey)}`
      : 'ووکامرس: بدون اعتبارنامه',
  ]

  return parts.join('؛ ')
}

/**
 * Create (or reconnect) one WordPress installation for one site. Reconnecting
 * the same installation updates the credentials on the same row — a second
 * row would split the idempotency ledger across two "sources" that are the
 * same WordPress.
 */
export const createMigrationSource = async (
  req: PayloadRequest,
  siteId: string,
  input: MigrationSourceInput,
  { lookup }: { lookup?: HostLookup } = {},
): Promise<{ message?: string; source?: MigrationSource }> => {
  const checked = await validateSourceBaseUrl(input.baseUrl, lookup ? { lookup } : {})

  if (!checked.ok) return { message: checked.message }

  const baseUrl = checked.baseUrl
  const installation = migrationInstallationFingerprint([baseUrl])
  const data: Record<string, unknown> = {
    baseUrl,
    credentialsSummary: credentialsSummary(input),
    installation,
    name: input.name?.trim() || new URL(baseUrl).hostname,
    site: siteId,
    status: 'untested',
    ...(input.wpUsername?.trim() ? { wpUsername: input.wpUsername.trim() } : {}),
    ...(input.wpApplicationPassword?.trim()
      ? { wpApplicationPassword: input.wpApplicationPassword.trim() }
      : {}),
    ...(input.wooConsumerKey?.trim() ? { wooConsumerKey: input.wooConsumerKey.trim() } : {}),
    ...(input.wooConsumerSecret?.trim()
      ? { wooConsumerSecret: input.wooConsumerSecret.trim() }
      : {}),
  }

  const { docs } = await req.payload.find({
    collection: 'migration-sources',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ site: { equals: siteId } }, { installation: { equals: installation } }],
    },
  })
  const existing = docs[0] as MigrationSource | undefined
  const source = existing
    ? ((await req.payload.update({
        id: existing.id,
        collection: 'migration-sources',
        data: data as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as MigrationSource)
    : ((await req.payload.create({
        collection: 'migration-sources',
        data: data as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as MigrationSource)

  await recordMigrationAudit(req, {
    action: existing ? 'source.reconnect' : 'source.create',
    actorId: idOf(req.user),
    siteId,
    sourceId: String(source.id),
    summary: existing
      ? 'اعتبارنامه‌های اتصال وردپرس به‌روز شد.'
      : 'اتصال وردپرس/ووکامرس تازه ثبت شد.',
  })

  return { source }
}

/** Build the read-only REST clients one source row authorizes. Woo is null until both keys exist. */
export const buildSourceClients = async (
  req: PayloadRequest,
  source: MigrationSource,
  { perPage }: { perPage?: number } = {},
): Promise<SourceClients> => {
  const secrets = await readMigrationSourceSecrets(req, String(source.id))
  const baseUrl = String(source.baseUrl)

  return {
    woo:
      secrets.wooConsumerKey && secrets.wooConsumerSecret
        ? createWooCommerceClient({
            baseUrl,
            consumerKey: secrets.wooConsumerKey,
            consumerSecret: secrets.wooConsumerSecret,
            ...(perPage ? { perPage } : {}),
          })
        : null,
    wp: createWordPressClient({
      baseUrl,
      ...(perPage ? { perPage } : {}),
      ...(source.wpUsername ? { username: String(source.wpUsername) } : {}),
      ...(secrets.wpApplicationPassword
        ? { applicationPassword: secrets.wpApplicationPassword }
        : {}),
    }),
  }
}

/**
 * One active migration program per source: discovery → dry-run → import →
 * sync → cutover are operations on the same job so checkpoints, mappings
 * and the ledger stay attached to one narrative. A completed/rolled-back
 * job is history; the next program gets a fresh row.
 */
export const createOrReuseMigrationJob = async (
  req: PayloadRequest,
  siteId: string,
  sourceId: string,
  { settings, title }: { settings?: Record<string, unknown>; title?: string },
): Promise<MigrationJob | null> => {
  const source = await findOwnMigrationSource(req, sourceId, siteId)
  if (!source) return null

  const { docs } = await req.payload.find({
    collection: 'migration-jobs',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    sort: '-createdAt',
    where: {
      and: [
        { site: { equals: siteId } },
        { source: { equals: sourceId } },
        { status: { not_in: ['completed', 'rolled-back', 'cancelled'] } },
      ],
    },
  })
  const existing = docs[0] as MigrationJob | undefined

  if (existing) {
    return (await req.payload.update({
      id: existing.id,
      collection: 'migration-jobs',
      data: {
        ...(settings ? { settings: { ...((existing.settings as object) ?? {}), ...settings } } : {}),
        ...(title?.trim() ? { title: title.trim() } : {}),
      } as never,
      depth: 0,
      overrideAccess: true,
      req,
    })) as MigrationJob
  }

  const job = (await req.payload.create({
    collection: 'migration-jobs',
    data: {
      operation: 'discover',
      settings: settings ?? {},
      site: siteId,
      source: sourceId,
      status: 'draft',
      title: title?.trim() || `مهاجرت از ${source.name}`,
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as MigrationJob

  await recordMigrationAudit(req, {
    action: 'job.create',
    actorId: idOf(req.user),
    jobId: String(job.id),
    siteId,
    sourceId,
    summary: 'کار مهاجرت ساخته شد.',
  })

  return job
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])

/** Queue one operation for the `migrationJobs` task; returns a refusal message instead when unsafe. */
export const queueMigrationOperation = async (
  req: PayloadRequest,
  siteId: string,
  jobId: string,
  operation: MigrationOperation,
): Promise<{ job?: MigrationJob; message?: string }> => {
  const job = await findOwnMigrationJob(req, jobId, siteId)
  if (!job) return { message: 'کار مهاجرت یافت نشد.' }
  if (job.status === 'running') return { message: 'این کار همین حالا در حال اجراست.' }
  if (job.status === 'rolled-back' && operation !== 'discover') {
    return { message: 'این کار برگردانده شده است؛ برای شروع دوباره کار تازه بسازید.' }
  }
  if (operation === 'cutover' && !job.sourceWriteFenceConfirmedAt) {
    return {
      message:
        'برش نهایی پیش از تأیید توقف نوشتن روی وردپرس ممکن نیست: ابتدا وردپرس را در حالت نگهداری/فقط‌خواندنی بگذارید و آن را تأیید کنید.',
    }
  }

  const queued = (await req.payload.update({
    id: job.id,
    collection: 'migration-jobs',
    data: {
      control: 'run',
      operation,
      runRequestedAt: new Date().toISOString(),
      status: 'queued',
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as MigrationJob

  await recordMigrationAudit(req, {
    action: `job.queue.${operation}`,
    actorId: idOf(req.user),
    jobId: String(job.id),
    siteId,
    sourceId: idOf(job.source) ?? undefined,
    summary: `عملیات «${operation}» در صف اجرا قرار گرفت.`,
  })

  return { job: queued }
}

/** Pause/cancel/resume from the wizard. The engine honors `control` between pages. */
export const setMigrationControl = async (
  req: PayloadRequest,
  siteId: string,
  jobId: string,
  control: 'cancel' | 'pause' | 'run',
): Promise<MigrationJob | null> => {
  const job = await findOwnMigrationJob(req, jobId, siteId)
  if (!job) return null

  const updated = (await req.payload.update({
    id: job.id,
    collection: 'migration-jobs',
    data: {
      control,
      ...(control === 'run'
        ? { runRequestedAt: new Date().toISOString(), status: 'queued' }
        : control === 'cancel' && !ACTIVE_STATUSES.has(String(job.status))
          ? { status: 'cancelled' }
          : {}),
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as MigrationJob

  await recordMigrationAudit(req, {
    action: `job.control.${control}`,
    actorId: idOf(req.user),
    jobId: String(job.id),
    siteId,
    sourceId: idOf(job.source) ?? undefined,
    summary:
      control === 'pause'
        ? 'توقف موقت کار درخواست شد.'
        : control === 'cancel'
          ? 'لغو کار درخواست شد.'
          : 'ادامه کار درخواست شد.',
  })

  return updated
}

/**
 * The human half of the write fence. Eshobe cannot reach into a customer's
 * WordPress and freeze it — the owner puts WooCommerce in maintenance /
 * stops taking orders, then confirms here. Cutover refuses to queue
 * without this timestamp, and the audit row is who said it and when.
 */
export const confirmWriteFence = async (
  req: PayloadRequest,
  siteId: string,
  jobId: string,
): Promise<MigrationJob | null> => {
  const job = await findOwnMigrationJob(req, jobId, siteId)
  if (!job) return null

  const updated = (await req.payload.update({
    id: job.id,
    collection: 'migration-jobs',
    data: { sourceWriteFenceConfirmedAt: new Date().toISOString() } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as MigrationJob

  await resolveMigrationErrors(req, {
    code: 'WRITE_FENCE_NOT_CONFIRMED',
    jobId: String(job.id),
    siteId,
    sourceId: idOf(job.source) ?? undefined,
  })
  await recordMigrationAudit(req, {
    action: 'cutover.write-fence-confirmed',
    actorId: idOf(req.user),
    jobId: String(job.id),
    siteId,
    sourceId: idOf(job.source) ?? undefined,
    summary: 'مالک تأیید کرد نوشتن روی وردپرس متوقف شده است (سفارش و محتوای تازه‌ای وارد نمی‌شود).',
  })

  return updated
}
