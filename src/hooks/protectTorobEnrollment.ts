import type { CollectionBeforeChangeHook } from 'payload'

import { Forbidden } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { torobEnrollmentOf } from '@/lib/torob/enrollment'

/**
 * Issue #183 — the Torob enrollment projection is platform configuration, not tenant
 * content. Field-level access hides it in the admin, but a Local/REST update by a site
 * owner must not be able to set `connected/enabled/authorizationState` either.
 *
 * The only writers are a platform admin session and the platform control endpoint
 * (which marks its own request with `context.torobEnrollmentSync` after requireOperator).
 * The domain-change reset hook writes the fail-closed default internally and is allowed.
 */
export const protectTorobEnrollment: CollectionBeforeChangeHook = async ({ data, operation, req }) => {
  // Site creation is platform-admin-only at the collection level; the group's defaults
  // are fail-closed, so there is nothing for a tenant to enable here.
  if (operation === 'create') return data
  if (!data || !('torob' in data)) return data
  const next = torobEnrollmentOf(data)
  // A write that leaves the feed disconnected/disabled/unauthorized is fail-closed; a
  // tenant may always stop their own crawler feed (and the domain-change reset does).
  if (!next.connected || !next.enabled || next.authorizationState !== 'authorized') return data
  if (req.context?.torobEnrollmentSync === true) return data
  if (isPlatformAdmin(req.user)) return data
  throw new Forbidden(req.t)
}
