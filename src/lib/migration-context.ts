import type { PayloadRequest } from 'payload'

/**
 * The explicit migration write context (issue #166, hard acceptance gate).
 *
 * Historical imports must be **side-effect-free**: replaying a 2019 WooCommerce
 * order into `orders` must never decrement today's stock, emit `order.paid` to
 * the platform feed/webhooks, or read as a fresh sale. The stock/platform-event
 * hooks therefore check for this context on the request and stand down.
 *
 * How it is set, and how it is not:
 *
 * - Only server-side importer code sets it, on the `req` it passes through its
 *   own Local API writes (`setMigrationContext`). Payload threads that one
 *   `req` through every hook of the write, which is what makes the flag both
 *   reliable and narrow: it can never leak into a neighbouring request.
 * - Nothing reads it from a header, cookie, query parameter or request body.
 *   A caller who could name the flag could suppress stock settlement on a real
 *   order, which is the exact fraud this context must not enable. The importer
 *   itself will run behind an authenticated staff session with the tenant
 *   validated server-side; this module only carries the resulting stamp.
 * - It is site-bound. A context stamped for site A suppresses side effects for
 *   site A's documents only; a hook that sees another site's document treats
 *   the write as ordinary (and the importer's own site checks will already
 *   have refused such a row long before a hook runs).
 */

const MIGRATION_CONTEXT_KEY = 'eshobeMigration'

export type MigrationContext = {
  /** The migration job/run performing the write, for audit correlation. */
  jobId?: string
  /** The tenant every write under this context must belong to. */
  siteId: string
  /** Source system label, e.g. `wordpress` — provenance, never authorization. */
  source: string
}

const isMigrationContext = (value: unknown): value is MigrationContext =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as MigrationContext).siteId === 'string' &&
  (value as MigrationContext).siteId.length > 0 &&
  typeof (value as MigrationContext).source === 'string'

/** The migration stamp on this request, or `null` for an ordinary write. */
export const migrationContextOf = (req: PayloadRequest): MigrationContext | null => {
  const value = req?.context?.[MIGRATION_CONTEXT_KEY]

  return isMigrationContext(value) ? value : null
}

/**
 * Stamp a request as an importer write. Importer code only — see the header.
 * Returns the same `req` so it can be inlined where the request is built.
 */
export const setMigrationContext = (
  req: PayloadRequest,
  context: MigrationContext,
): PayloadRequest => {
  req.context[MIGRATION_CONTEXT_KEY] = context

  return req
}

/**
 * Whether this write is a historical migration write *for the given site*.
 * Hooks pass the document's own site: a context stamped for another tenant
 * must not suppress this document's side effects.
 */
export const isMigrationWrite = (req: PayloadRequest, siteId?: null | string): boolean => {
  const context = migrationContextOf(req)

  if (!context) return false
  if (siteId === undefined || siteId === null) return true

  return context.siteId === siteId
}
