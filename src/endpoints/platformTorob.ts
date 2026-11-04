/**
 * Platform-only Torob enrollment sync for Biza Miz (issue #183).
 *
 * Growth owns the merchant lifecycle; the CMS stores a local projection so the public
 * crawler endpoint never calls Growth at request time. This is configuration plumbing,
 * not a second Torob dashboard: the fields are hidden in the CMS admin and only a
 * platform-admin session or `role: "platform"` key may write them.
 *
 * `PATCH` is a full-state sync (connected, authorizationState, enabled, optional shopId).
 * A disconnect/revocation therefore cannot leave a stale `enabled: true` behind.
 */
import type { Endpoint } from 'payload'

import {
  DEFAULT_TOROB_ENROLLMENT,
  parseTorobEnrollment,
  torobEndpointForSite,
  torobEnrollmentOf,
} from '@/lib/torob/enrollment'

import { json, param, readJsonBody, requireOperator, siteById } from './platformShared'

const projection = (site: Record<string, unknown>) => ({
  audience: String(site.domain),
  endpoint: torobEndpointForSite({ domain: String(site.domain) }),
  enrollment: torobEnrollmentOf(site),
})

export const platformTorobGetEndpoint: Endpoint = {
  path: '/platform/sites/:id/torob',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)
    return json({ ok: true, ...projection(site) })
  },
}

export const platformTorobPatchEndpoint: Endpoint = {
  path: '/platform/sites/:id/torob',
  method: 'patch',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readJsonBody(req)
    if (error) return error
    const parsed = parseTorobEnrollment(body)
    if (!parsed.ok) return json({ message: parsed.message, ok: false }, 400)

    const updated = await req.payload.update({
      id: String(site.id),
      collection: 'sites',
      context: { ...req.context, torobEnrollmentSync: true },
      data: { torob: { ...parsed.value, syncedAt: new Date().toISOString() } },
      depth: 0,
      overrideAccess: true,
      req,
    })
    return json({ ok: true, ...projection(updated as unknown as Record<string, unknown>) })
  },
}

/** Explicit disconnect helper for a console that only wants to stop serving. */
export const platformTorobDisconnectEndpoint: Endpoint = {
  path: '/platform/sites/:id/torob/disconnect',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)
    const updated = await req.payload.update({
      id: String(site.id),
      collection: 'sites',
      context: { ...req.context, torobEnrollmentSync: true },
      data: { torob: { ...DEFAULT_TOROB_ENROLLMENT, syncedAt: new Date().toISOString() } },
      depth: 0,
      overrideAccess: true,
      req,
    })
    return json({ ok: true, ...projection(updated as unknown as Record<string, unknown>) })
  },
}

export const platformTorobEndpoints: Endpoint[] = [
  platformTorobGetEndpoint,
  platformTorobPatchEndpoint,
  platformTorobDisconnectEndpoint,
]
