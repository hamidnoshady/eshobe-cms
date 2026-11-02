import { lookup } from 'node:dns/promises'
import type { Endpoint, PayloadRequest } from 'payload'

import { siteStaffRole, type SiteStaffRole } from '@/deploy/tenantSettings'
import { isUuid } from '@/lib/ids'
import {
  canManageMigration,
  migrationCenterView,
  migrationJobView,
  migrationSourceView,
  sanitizeMigrationSettings,
} from '@/lib/migration/center'
import { recordMigrationAudit } from '@/lib/migration/records'
import {
  confirmWriteFence,
  createMigrationSource,
  createOrReuseMigrationJob,
  findOwnMigrationJob,
  queueMigrationOperation,
  setMigrationControl,
} from '@/lib/migration/source'
import type { MigrationOperation } from '@/lib/migration/types'

import { json, param, readJsonBody, search } from './platformShared'

/**
 * The Migration Center's owner API (`/api/site/migration…`, issue #166).
 *
 * An authenticated admin session only: a site API key is an integration
 * credential, not a person who may hand the platform WordPress credentials,
 * freeze a store for cutover, or roll a catalogue back. The `site` value
 * only chooses among sites the caller already staffs (`siteStaffRole` —
 * the same boundary as theme settings); every service call then re-reads
 * its source/job behind an explicit `site` predicate, so naming another
 * customer's job id under your own site is a 404, never a write.
 *
 * Top-level paths are safe here: their first segment is `site`, not a
 * collection slug, so Payload does dispatch them to `config.endpoints`.
 */

const OPERATIONS = new Set<MigrationOperation>([
  'cutover',
  'discover',
  'dry-run',
  'import',
  'reconcile',
  'rollback',
  'sync',
])

const resolveSite = (
  req: PayloadRequest,
  siteId: string,
  { write }: { write: boolean },
): { error: Response; role?: never } | { error?: never; role: SiteStaffRole } => {
  if (!isUuid(siteId)) {
    return { error: json({ message: 'شناسهٔ سایت نامعتبر است.', ok: false }, 400) }
  }
  const role = siteStaffRole(req.user, siteId)
  if (!role) {
    return { error: json({ message: 'به مرکز مهاجرت این سایت دسترسی ندارید.', ok: false }, 403) }
  }
  if (write && !canManageMigration(role)) {
    return {
      error: json({ message: 'فقط مالک سایت می‌تواند مهاجرت را تغییر دهد.', ok: false }, 403),
    }
  }
  return { role }
}

const text = (value: unknown, max = 2_000): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

const state = async (req: PayloadRequest, siteId: string, role: SiteStaffRole) =>
  json({ ok: true, ...(await migrationCenterView(req, siteId, role)) })

export const migrationCenterEndpoints: Endpoint[] = [
  {
    handler: async (req) => {
      const siteId = search(req).get('site') ?? ''
      const { error, role } = resolveSite(req, siteId, { write: false })
      if (error) return error

      return state(req, siteId, role)
    },
    method: 'get',
    path: '/site/migration',
  },
  {
    handler: async (req) => {
      const { body, error: bodyError } = await readJsonBody(req)
      if (bodyError || !body) return bodyError ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)
      const siteId = text(body.site, 100)
      const { error, role } = resolveSite(req, siteId, { write: true })
      if (error) return error

      const baseUrl = text(body.baseUrl, 500)
      if (!baseUrl) return json({ message: 'نشانی سایت وردپرسی الزامی است.', ok: false }, 400)

      const result = await createMigrationSource(
        req,
        siteId,
        {
          baseUrl,
          name: text(body.name, 200) || undefined,
          wooConsumerKey: text(body.wooConsumerKey, 500) || undefined,
          wooConsumerSecret: text(body.wooConsumerSecret, 500) || undefined,
          wpApplicationPassword: text(body.wpApplicationPassword, 500) || undefined,
          wpUsername: text(body.wpUsername, 200) || undefined,
        },
        { lookup: async (hostname) => lookup(hostname, { all: true }) },
      )

      if (!result.source) {
        return json({ message: result.message ?? 'اتصال مبدأ ثبت نشد.', ok: false }, 400)
      }

      return json(
        {
          ok: true,
          source: migrationSourceView(result.source),
          ...(await migrationCenterView(req, siteId, role)),
        },
        201,
      )
    },
    method: 'post',
    path: '/site/migration/source',
  },
  {
    handler: async (req) => {
      const { body, error: bodyError } = await readJsonBody(req)
      if (bodyError || !body) return bodyError ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)
      const siteId = text(body.site, 100)
      const { error, role } = resolveSite(req, siteId, { write: true })
      if (error) return error

      const sourceId = text(body.sourceId, 100)
      if (!isUuid(sourceId)) return json({ message: 'شناسهٔ مبدأ نامعتبر است.', ok: false }, 400)
      const checked = sanitizeMigrationSettings(body.settings)
      if (checked.errors.length) {
        return json({ errors: checked.errors, message: checked.errors.join(' '), ok: false }, 400)
      }

      const job = await createOrReuseMigrationJob(req, siteId, sourceId, {
        settings: checked.settings,
        title: text(body.title, 200) || undefined,
      })
      if (!job) return json({ message: 'مبدأ مهاجرت پیدا نشد.', ok: false }, 404)

      return json(
        { job: migrationJobView(job), ok: true, ...(await migrationCenterView(req, siteId, role)) },
        201,
      )
    },
    method: 'post',
    path: '/site/migration/job',
  },
  {
    handler: async (req) => {
      const { body, error: bodyError } = await readJsonBody(req)
      if (bodyError || !body) return bodyError ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)
      const siteId = text(body.site, 100)
      const { error, role } = resolveSite(req, siteId, { write: true })
      if (error) return error

      const jobId = param(req, 'id')
      const job = await findOwnMigrationJob(req, jobId, siteId)
      if (!job) return json({ message: 'کار مهاجرت پیدا نشد.', ok: false }, 404)
      if (job.status === 'queued' || job.status === 'running') {
        return json({ message: 'تنظیمات کار در حال اجرا تغییر نمی‌کند.', ok: false }, 409)
      }
      const checked = sanitizeMigrationSettings(body.settings)
      if (checked.errors.length) {
        return json({ errors: checked.errors, message: checked.errors.join(' '), ok: false }, 400)
      }

      const updated = await req.payload.update({
        id: job.id,
        collection: 'migration-jobs',
        data: {
          settings: {
            ...((job.settings as Record<string, unknown> | null) ?? {}),
            ...checked.settings,
          },
          ...(text(body.title, 200) ? { title: text(body.title, 200) } : {}),
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
      await recordMigrationAudit(req, {
        action: 'job.settings',
        actorId: req.user ? String(req.user.id) : undefined,
        details: { settings: checked.settings },
        jobId: String(job.id),
        siteId,
        sourceId: typeof job.source === 'string' ? job.source : String(job.source.id),
        summary: 'تنظیمات کار مهاجرت به‌روز شد.',
      })

      return json({
        job: migrationJobView(updated as never),
        ok: true,
        ...(await migrationCenterView(req, siteId, role)),
      })
    },
    method: 'post',
    path: '/site/migration/job/:id/settings',
  },
  {
    handler: async (req) => {
      const { body, error: bodyError } = await readJsonBody(req)
      if (bodyError || !body) return bodyError ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)
      const siteId = text(body.site, 100)
      const { error, role } = resolveSite(req, siteId, { write: true })
      if (error) return error

      const operation = text(body.operation, 50) as MigrationOperation
      if (!OPERATIONS.has(operation)) {
        return json({ message: 'عملیات مهاجرت معتبر نیست.', ok: false }, 400)
      }

      const result = await queueMigrationOperation(req, siteId, param(req, 'id'), operation)
      if (!result.job) return json({ message: result.message ?? 'کار پیدا نشد.', ok: false }, 409)

      return json({
        job: migrationJobView(result.job),
        ok: true,
        ...(await migrationCenterView(req, siteId, role)),
      })
    },
    method: 'post',
    path: '/site/migration/job/:id/queue',
  },
  {
    handler: async (req) => {
      const { body, error: bodyError } = await readJsonBody(req)
      if (bodyError || !body) return bodyError ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)
      const siteId = text(body.site, 100)
      const { error, role } = resolveSite(req, siteId, { write: true })
      if (error) return error

      const control = text(body.control, 20)
      if (!['cancel', 'pause', 'run'].includes(control)) {
        return json({ message: 'فرمان کنترل معتبر نیست.', ok: false }, 400)
      }

      const job = await setMigrationControl(
        req,
        siteId,
        param(req, 'id'),
        control as 'cancel' | 'pause' | 'run',
      )
      if (!job) return json({ message: 'کار مهاجرت پیدا نشد.', ok: false }, 404)

      return json({
        job: migrationJobView(job),
        ok: true,
        ...(await migrationCenterView(req, siteId, role)),
      })
    },
    method: 'post',
    path: '/site/migration/job/:id/control',
  },
  {
    handler: async (req) => {
      const { body, error: bodyError } = await readJsonBody(req)
      if (bodyError || !body) return bodyError ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)
      const siteId = text(body.site, 100)
      const { error, role } = resolveSite(req, siteId, { write: true })
      if (error) return error
      if (body.confirmed !== true) {
        return json(
          { message: 'تأیید صریح توقف نوشتن روی وردپرس لازم است.', ok: false },
          400,
        )
      }

      const job = await confirmWriteFence(req, siteId, param(req, 'id'))
      if (!job) return json({ message: 'کار مهاجرت پیدا نشد.', ok: false }, 404)

      return json({
        job: migrationJobView(job),
        ok: true,
        ...(await migrationCenterView(req, siteId, role)),
      })
    },
    method: 'post',
    path: '/site/migration/job/:id/write-fence',
  },
]
