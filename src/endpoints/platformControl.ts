import type { Endpoint, PayloadRequest } from 'payload'

import {
  clampLimit,
  clampPage,
  parseSitePatch,
  parseSnapshotCollections,
} from '@/lib/platform-control'
import { platformEvents } from '@/platform/events'
import { platformOverview, siteReportFor } from '@/platform/report'
import { exportSiteSnapshot, importSiteSnapshot } from '@/platform/snapshot'

import { json, param, requireOperator, search, siteById } from './platformShared'

/**
 * `/api/platform/*` — the whole deployment, administered from outside it.
 *
 * The CMS ships its own admin, and that admin is the right surface for editing one
 * site. It is the wrong surface for the *operator's* questions, which are all
 * cross-site: how many domains are unverified, which merchant's gateway never
 * passed a self-test, did the jobs queue stop, what changed in the last hour, and —
 * the two that had no answer at all — give me this site's content, and take this
 * content back. The sibling POS's super-admin console («سایت‌ساز», see
 * docs/eshobe-cms-integration.md §7) is where an operator already administers every
 * other part of the platform, so this is the surface that lets it administer this
 * one too, from a CMS address plus one credential.
 *
 * ## Who may call it
 *
 * A platform-admin session or a `role: "platform"` API key — the same boundary
 * `provisionSiteEndpoint` and `/api/api-keys/issue` already draw. Nothing here is
 * reachable with a site key: `isPlatformAdminOrPlatformKey` accepts one role and
 * `apiKeyAware` (which is what a site key satisfies) is not in the path at all.
 *
 * That widens what a platform key can *reach* — it can now read every site's
 * content through the snapshot export, where before it could only provision sites
 * and issue keys. Worth being explicit that this is not a new authority: a platform
 * key could already issue itself a `role: "site"` key for any site on the
 * deployment (`/api/api-keys/issue` takes a `siteId`), and that key reads that
 * site's content including drafts. The least-privilege split between the two roles
 * was always a shape, never a boundary; the boundary is that a *site* key still
 * reaches exactly one site, which nothing here changes.
 *
 * ## Why it needs no Caddy carve-out
 *
 * `/api*` on a customer domain is a 404 by design (`@control_plane_paths` in the
 * Caddyfile), and these routes are called with the *control plane's* own `Host` —
 * the POS client only forwards a site's domain on site-scoped calls, so a platform
 * call routes to the control-plane block. Leaving it there is the point, and it is
 * the same decision `POST /api/payments/self-test` records: routing a staff endpoint
 * onto customer domains puts it one `curl` away from anybody standing on a shop's
 * homepage.
 */


const readBody = async (req: PayloadRequest): Promise<{ body?: Record<string, unknown>; error?: Response }> => {
  try {
    const parsed = (await req.json?.()) ?? {}
    if (!parsed || typeof parsed !== 'object') {
      return { error: json({ message: 'بدنهٔ درخواست باید یک شیء JSON باشد.', ok: false }, 400) }
    }
    return { body: parsed as Record<string, unknown> }
  } catch {
    return { error: json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400) }
  }
}

/** `GET /api/platform/overview` — the fleet report the console's front page is built from. */
export const platformOverviewEndpoint: Endpoint = {
  path: '/platform/overview',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    return json({ ok: true, overview: await platformOverview(req, { days: params.get('days') }) })
  },
}

/**
 * `GET /api/platform/sites` — every site with its own counts.
 *
 * Paged, because the per-site figures are `count` calls and the page size decides how
 * many of them one request makes. `q` matches name or domain so the console's search
 * box does not have to pull the whole list to filter it client-side.
 */
export const platformSitesEndpoint: Endpoint = {
  path: '/platform/sites',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const limit = clampLimit(params.get('limit'), 25, 100)
    const page = clampPage(params.get('page'))
    const q = (params.get('q') ?? '').trim().slice(0, 120)
    const status = params.get('status')

    const result = await req.payload.find({
      collection: 'sites',
      depth: 0,
      limit,
      overrideAccess: true,
      page,
      req,
      sort: 'name',
      where: {
        and: [
          ...(q ? [{ or: [{ name: { like: q } }, { domain: { like: q } }] }] : []),
          ...(status && status !== 'all' ? [{ status: { equals: status } }] : []),
        ],
      },
    })

    const sites = []
    for (const doc of result.docs as unknown as Record<string, unknown>[]) {
      sites.push(await siteReportFor(req, doc))
    }

    return json({
      ok: true,
      page: result.page ?? page,
      sites,
      totalDocs: result.totalDocs,
      totalPages: result.totalPages,
    })
  },
}

/** `GET /api/platform/sites/:id` — one site's report, same row shape as the list. */
export const platformSiteEndpoint: Endpoint = {
  path: '/platform/sites/:id',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)
    return json({ ok: true, site: await siteReportFor(req, site) })
  },
}

/**
 * `PATCH /api/platform/sites/:id` — the site lifecycle an operator administers.
 *
 * `parseSitePatch` is an allowlist, and what it leaves out matters more than what it
 * lets in: `domain` is absent because its one write path is `PATCH /api/site/domain`,
 * which resets `domainVerified` and re-checks uniqueness across every site's aliases.
 * A second door onto the same column would be a second place for that invariant to be
 * forgotten.
 */
export const platformSitePatchEndpoint: Endpoint = {
  path: '/platform/sites/:id',
  method: 'patch',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error
    const { data, errors } = parseSitePatch(body)
    if (errors.length) return json({ errors, message: errors[0], ok: false }, 400)

    try {
      const updated = await req.payload.update({
        id: String(site.id),
        collection: 'sites',
        data,
        depth: 0,
        // The operator has been authenticated above; `Sites.access.update` is
        // `authenticated`, which a platform *key* is not — the guard on this endpoint
        // is what stands in for it, and it is the only door a key reaches.
        overrideAccess: true,
        req,
      })
      return json({ ok: true, site: await siteReportFor(req, updated as unknown as Record<string, unknown>) })
    } catch (err) {
      // A collection hook's Persian message (a domain collision, a default locale
      // outside the site's own list) is the useful answer here, not a 500.
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

/** `GET /api/platform/events` — the tail the POS ships into its log store. */
export const platformEventsEndpoint: Endpoint = {
  path: '/platform/events',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const feed = await platformEvents(req, { limit: params.get('limit'), since: params.get('since') })
    return json({ ok: true, ...feed })
  },
}

/** `GET /api/platform/sites/:id/snapshot` — this site's content, out. */
export const platformSnapshotExportEndpoint: Endpoint = {
  path: '/platform/sites/:id/snapshot',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const params = search(req)
    const { collections, unknown } = parseSnapshotCollections(params.get('collections'))
    if (unknown.length) {
      return json({ message: `مجموعهٔ ناشناخته: ${unknown.join(', ')}`, ok: false }, 400)
    }

    return json({ ok: true, snapshot: await exportSiteSnapshot(req, site, collections) })
  },
}

/**
 * `POST /api/platform/sites/:id/snapshot` — content, in.
 *
 * `dryRun: true` answers with the plan and writes nothing, which is what the console
 * shows before an operator confirms: "۴ به‌روزرسانی، ۱ ساخت" is a decision, and a
 * count that only appears afterwards is not.
 */
export const platformSnapshotImportEndpoint: Endpoint = {
  path: '/platform/sites/:id/snapshot',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const snapshot = (body?.snapshot ?? null) as null | { documents?: unknown; site?: unknown }
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.documents) {
      return json({ message: 'تصویر محتوا (snapshot) ارسال نشده است.', ok: false }, 400)
    }

    const { collections, unknown } = parseSnapshotCollections(body?.collections)
    if (unknown.length) {
      return json({ message: `مجموعهٔ ناشناخته: ${unknown.join(', ')}`, ok: false }, 400)
    }

    const result = await importSiteSnapshot(req, site, {
      collections,
      dryRun: body?.dryRun === true,
      force: body?.force === true,
      snapshot,
    })

    if (!result.ok) {
      return json(
        {
          message:
            'این تصویر از سایت دیگری گرفته شده است. ارجاع‌های آن به رسانه و دسته‌بندی‌های آن سایت اشاره می‌کنند؛ برای ادامه force بفرستید.',
          ok: false,
          reason: result.reason,
        },
        409,
      )
    }

    return json({ dryRun: body?.dryRun === true, ...result })
  },
}

export const platformControlEndpoints: Endpoint[] = [
  platformOverviewEndpoint,
  platformEventsEndpoint,
  // The `/snapshot` pair is listed before the bare `:id` pair on purpose: Payload
  // matches endpoints in order, and `/platform/sites/:id` would otherwise swallow
  // `/platform/sites/:id/snapshot` with `id` set to the site and the rest ignored.
  platformSnapshotExportEndpoint,
  platformSnapshotImportEndpoint,
  platformSitesEndpoint,
  platformSiteEndpoint,
  platformSitePatchEndpoint,
]
