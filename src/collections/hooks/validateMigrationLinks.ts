import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

/**
 * Tenant-boundary checks for the migration bookkeeping graph.
 *
 * These collections are written by the importer with `overrideAccess`, which
 * is exactly why the graph gets its own hook-level rule: a job, batch, record
 * or error must never point at another tenant's source or job, whatever the
 * caller was allowed to see. The site always comes from the row being
 * written (or the stored row on update), never from a related document.
 */
const LINKS = [
  { collection: 'migration-sources', field: 'source' },
  { collection: 'migration-jobs', field: 'job' },
  { collection: 'migration-batches', field: 'batch' },
  { collection: 'migration-records', field: 'record' },
  { collection: 'users', field: 'actor' },
  { collection: 'redirects', field: 'redirect' },
] as const

export const validateMigrationLinks: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>
  const siteId = siteIdOfWrite(row, stored)

  if (!siteId) return data

  for (const { collection: target, field } of LINKS) {
    const targetId = idOf(row[field] ?? stored[field])
    if (!targetId) continue

    // `users` is the auth collection, not a per-site row with a `site` field;
    // an audit actor is checked by the endpoint that authenticated them.
    if (target === 'users') continue

    const found = await findOnSite(req, target, targetId, siteId, { id: true })
    if (!found) {
      failField(collection, req, [
        {
          message: 'سند پیوندشده متعلق به همین سایت نیست؛ پیوند میان‌سایتی مهاجرت مجاز نیست.',
          path: field,
        },
      ])
    }
  }

  // When both a job and a source are named, they must name the *same* source;
  // same-site alone would still let one job's ledger rows point at another
  // installation of the same tenant and corrupt its idempotency keys.
  const jobId = idOf(row.job ?? stored.job)
  const sourceId = idOf(row.source ?? stored.source)

  if (jobId && sourceId) {
    const job = await findOnSite(req, 'migration-jobs', jobId, siteId, { source: true })
    if (job && idOf(job.source) && idOf(job.source) !== sourceId) {
      failField(collection, req, [
        {
          message: 'مبدأ این ردیف با مبدأ کار مهاجرت یکی نیست.',
          path: 'source',
        },
      ])
    }
  }

  return data
}
