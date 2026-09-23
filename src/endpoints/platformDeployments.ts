import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { fetchThemeManifest } from '@/deploy/github'
import {
  createDeployment,
  pollDeployment,
  runDeployment,
  stopDeployment,
  verifyDeployment,
} from '@/deploy/service'
import { idOf, isUuid } from '@/lib/ids'
import { isSafeGitRef } from '@/lib/deploy/manifest'
import { DOMAIN_MODES, type DomainMode } from '@/lib/deploy/status'
import { emitPlatformEvent } from '@/platform/webhooks'

/**
 * `/api/platform/theme-packages/*` and `/api/platform/sites/:id/deployment*` — the
 * operator's deployment surface.
 *
 * Same namespace, same guard and same conventions as `platformSaas.ts` and
 * `platformControl.ts`: a platform-admin session or a `role: "platform"` key, never a
 * site key, and deliberately no Caddy carve-out — these are called with the control
 * plane's own `Host`, and routing "deploy arbitrary code for any customer" onto a
 * customer domain is not a thing to leave one `curl` away from a shop's homepage.
 *
 * ## Ordering
 *
 * Payload matches endpoints in array order. Every literal `/platform/sites/:id/<word>`
 * here must be registered before the fleet file's bare `/platform/sites/:id`, which
 * would otherwise swallow it and answer 200 with the wrong body — the failure mode
 * that does not look like one. `payload.config` spreads this array with the SaaS one,
 * ahead of `platformControlEndpoints`, for exactly that reason.
 *
 * ## Why `POST …/deployment` answers 202
 *
 * Because a Coolify build takes minutes and this request cannot wait for it. The
 * response carries the deployment row's id; `GET …/deployment` is how the console
 * follows it. A synchronous version of this route would time out at the proxy and
 * leave the operator unable to tell a slow build from a failed one.
 */

const noStore = { 'cache-control': 'no-store' }

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: noStore, status })

const requireOperator = async (req: PayloadRequest): Promise<null | Response> => {
  if (await isPlatformAdminOrPlatformKey(req, isPlatformAdmin(req.user))) return null
  return json({ message: 'این بخش فقط برای مدیر پلتفرم است.', ok: false }, 403)
}

/** Session-only. Registering a repository the platform will build and run is a human decision. */
const requireAdminSession = (req: PayloadRequest): null | Response => {
  if (isPlatformAdmin(req.user)) return null
  return json({ message: 'این عملیات فقط با نشست مدیر پلتفرم انجام می‌شود.', ok: false }, 403)
}

const param = (req: PayloadRequest, name: string): string =>
  String((req.routeParams as Record<string, unknown> | undefined)?.[name] ?? '')

const readBody = async (
  req: PayloadRequest,
): Promise<{ body?: Record<string, unknown>; error?: Response }> => {
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

const siteById = async (req: PayloadRequest, id: string): Promise<null | Record<string, unknown>> => {
  if (!isUuid(id)) return null
  const doc = await req.payload.findByID({
    id,
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })
  return (doc as unknown as null | Record<string, unknown>) ?? null
}

/** The row shape a console renders. Never includes `revalidateSecret` or a key's raw value. */
const deploymentRow = (doc: Record<string, unknown>): Record<string, unknown> => ({
  appUuid: doc.appUuid ?? null,
  commitSha: doc.commitSha ?? null,
  createdAt: doc.createdAt ?? null,
  deployedAt: doc.deployedAt ?? null,
  domain: doc.domain ?? null,
  domainMode: doc.domainMode ?? 'preview',
  healthCheckedAt: doc.healthCheckedAt ?? null,
  id: String(doc.id),
  lastError: doc.lastError ?? null,
  logTail: doc.logTail ?? null,
  previewDomain: doc.previewDomain ?? null,
  ref: doc.ref ?? null,
  site: idOf(doc.site),
  status: doc.status ?? 'queued',
  target: idOf(doc.target),
  themePackage: idOf(doc.themePackage),
})

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** `GET /api/platform/theme-packages` — the deployable themes this operator offers. */
export const themePackagesListEndpoint: Endpoint = {
  path: '/platform/theme-packages',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const { docs } = await req.payload.find({
      collection: 'theme-packages',
      depth: 0,
      limit: 200,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'name',
    })

    return json({
      ok: true,
      packages: (docs as unknown as Record<string, unknown>[]).map((doc) => ({
        buildPack: doc.buildPack ?? null,
        contractVersion: doc.contractVersion ?? null,
        defaultRef: doc.defaultRef ?? null,
        defaultTarget: idOf(doc.defaultTarget),
        description: doc.description ?? null,
        // Only the declared shape, never stored values: this list is how a console
        // draws the tenant's settings form, and a value belongs to a site.
        envSchema: doc.envSchema ?? [],
        id: String(doc.id),
        key: String(doc.key ?? ''),
        name: String(doc.name ?? ''),
        pinnedCommit: doc.pinnedCommit ?? null,
        proxiesApi: doc.proxiesApi === true,
        repository: doc.repository ?? null,
        requiredFeature: doc.requiredFeature ?? null,
        siteTypes: Array.isArray(doc.siteTypes) ? (doc.siteTypes as unknown[]).map(String) : [],
        status: doc.status ?? 'draft',
        syncedAt: doc.manifestSyncedAt ?? null,
        syncError: doc.syncError ?? null,
      })),
    })
  },
}

/**
 * `POST /api/platform/theme-packages/:id/sync` — re-read `eshobe.theme.json`.
 *
 * This is the only writer of the manifest-derived fields. An operator cannot type a
 * build command into the form, because the repository is what has to build and a
 * value typed twice is a value that is wrong once.
 *
 * A sync that fails leaves the previous manifest in place and records the reason. The
 * alternative — blanking it — would take a working package out of service because
 * GitHub had a bad minute.
 */
export const themePackageSyncEndpoint: Endpoint = {
  path: '/platform/theme-packages/:id/sync',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const id = param(req, 'id')
    if (!isUuid(id)) return json({ message: 'شناسهٔ پوسته نامعتبر است.', ok: false }, 400)

    const pkg = (await req.payload.findByID({
      collection: 'theme-packages',
      depth: 0,
      disableErrors: true,
      id,
      overrideAccess: true,
      req,
    })) as null | Record<string, unknown>

    if (!pkg) return json({ message: 'پوسته پیدا نشد.', ok: false }, 404)

    const { body } = await readBody(req)
    const requestedRef = String(body?.ref ?? '') || String(pkg.defaultRef ?? 'main')

    if (!isSafeGitRef(requestedRef)) {
      return json({ message: 'نام شاخه یا تگ نامعتبر است.', ok: false }, 400)
    }

    const result = await fetchThemeManifest(String(pkg.repository ?? ''), requestedRef)

    if (!result.ok) {
      await req.payload.update({
        collection: 'theme-packages',
        data: { syncError: result.errors.join('\n') },
        depth: 0,
        id,
        overrideAccess: true,
        req,
      })
      return json({ errors: result.errors, message: result.errors[0], ok: false }, 422)
    }

    const { manifest } = result

    const updated = await req.payload.update({
      collection: 'theme-packages',
      data: {
        buildPack: manifest.build.buildPack,
        contractVersion: manifest.contractVersion,
        defaultRef: requestedRef,
        envSchema: manifest.env,
        healthCheckPath: manifest.build.healthCheckPath,
        manifest: manifest as unknown as Record<string, unknown>,
        manifestSyncedAt: new Date().toISOString(),
        port: manifest.build.port,
        proxiesApi: manifest.proxiesApi,
        siteTypes: manifest.siteTypes,
        syncError: null,
      },
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })

    await emitPlatformEvent(req, {
      data: { commit: result.sha, key: String(pkg.key ?? ''), ref: requestedRef },
      event: 'plugin.changed',
      message: `مانیفست پوستهٔ «${String(pkg.name ?? '')}» از ${requestedRef} خوانده شد.`,
      targetCollection: 'theme-packages',
      targetId: id,
    })

    return json({
      commit: result.sha,
      manifest,
      ok: true,
      package: { id: String((updated as { id: unknown }).id), key: String(pkg.key ?? '') },
    })
  },
}

/**
 * `POST /api/platform/theme-packages/:id/publish` — make it selectable.
 *
 * Session-only, and it refuses rather than warns. Publishing a package with no
 * manifest, no deploy target or a contract this deployment does not serve creates a
 * row a customer can pick and that cannot possibly deploy — a failure discovered by
 * the customer rather than by the operator.
 */
export const themePackagePublishEndpoint: Endpoint = {
  path: '/platform/theme-packages/:id/publish',
  method: 'post',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied

    const id = param(req, 'id')
    if (!isUuid(id)) return json({ message: 'شناسهٔ پوسته نامعتبر است.', ok: false }, 400)

    const pkg = (await req.payload.findByID({
      collection: 'theme-packages',
      depth: 0,
      disableErrors: true,
      id,
      overrideAccess: true,
      req,
    })) as null | Record<string, unknown>

    if (!pkg) return json({ message: 'پوسته پیدا نشد.', ok: false }, 404)

    const { body } = await readBody(req)
    const status = body?.status === 'deprecated' ? 'deprecated' : body?.status === 'draft' ? 'draft' : 'published'

    if (status === 'published') {
      const problems: string[] = []
      if (!pkg.manifest) problems.push('مانیفست خوانده نشده است؛ ابتدا همگام‌سازی کنید.')
      if (!pkg.contractVersion) problems.push('نسخهٔ قرارداد مشخص نیست.')

      if (!idOf(pkg.defaultTarget)) {
        const { totalDocs } = await req.payload.count({
          collection: 'deploy-targets',
          overrideAccess: true,
          req,
          where: { active: { equals: true } },
        })
        if (!totalDocs) problems.push('هیچ سرور استقرار فعالی وجود ندارد.')
      }

      if (problems.length) {
        return json({ message: problems.join(' '), ok: false, problems }, 409)
      }
    }

    await req.payload.update({
      collection: 'theme-packages',
      data: { status },
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })

    await emitPlatformEvent(req, {
      data: { key: String(pkg.key ?? ''), status },
      event: 'theme.published',
      message: `وضعیت پوستهٔ «${String(pkg.name ?? '')}» به «${status}» تغییر کرد.`,
      targetCollection: 'theme-packages',
      targetId: id,
    })

    return json({ ok: true, status })
  },
}

// ---------------------------------------------------------------------------
// Per-site deployment lifecycle
// ---------------------------------------------------------------------------

/** `GET /api/platform/sites/:id/deployment` — what is running, and its history. */
export const siteDeploymentGetEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { docs } = await req.payload.find({
      collection: 'site-deployments',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      req,
      sort: '-createdAt',
      where: { site: { equals: String(site.id) } },
    })

    const rows = (docs as unknown as Record<string, unknown>[]).map(deploymentRow)

    return json({
      current: rows.find((row) => row.status === 'live') ?? rows[0] ?? null,
      deployments: rows,
      ok: true,
      renderedBy: site.renderedBy ?? 'platform',
    })
  },
}

/**
 * `POST /api/platform/sites/:id/deployment` — adopt a theme.
 *
 * `{ package, ref?, target?, domainMode? }` → 202 with the row id. Validation is
 * synchronous and complete: everything that can be refused without touching the
 * network is refused here, before a row exists.
 */
export const siteDeploymentCreateEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const packageRef = String(body?.package ?? body?.themePackage ?? '')
    if (!packageRef) return json({ message: 'کلید یا شناسهٔ پوسته الزامی است.', ok: false }, 400)

    const modeRaw = String(body?.domainMode ?? 'preview')
    if (!(DOMAIN_MODES as readonly string[]).includes(modeRaw)) {
      return json(
        { message: `«domainMode» باید یکی از ${DOMAIN_MODES.join('، ')} باشد.`, ok: false },
        400,
      )
    }

    const created = await createDeployment({
      domainMode: modeRaw as DomainMode,
      packageRef,
      ref: body?.ref ? String(body.ref) : null,
      req,
      site,
      targetRef: body?.target ? String(body.target) : null,
    })

    if (!created.ok) return json({ message: created.message, ok: false }, created.status)

    /**
     * Fire-and-forget, with the same reasoning `emitPlatformEvent` uses for its HTTP
     * fan-out: the caller gets its 202 immediately, and the row is the contract for
     * everything after. An awaited build here is a 504 at the proxy and an operator
     * who cannot tell slow from broken.
     */
    void runDeployment(req, created.deploymentId).catch((err: unknown) => {
      req.payload.logger.error({
        err: err as Error,
        msg: `deployment ${created.deploymentId} crashed`,
      })
    })

    return json({ deployment: created.deploymentId, ok: true, status: 'queued' }, 202)
  },
}

/** `POST /api/platform/sites/:id/deployment/poll` — advance a building deployment. */
export const siteDeploymentPollEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment/poll',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body } = await readBody(req)
    const deploymentId = String(body?.deployment ?? '')
    if (!isUuid(deploymentId)) return json({ message: 'شناسهٔ استقرار نامعتبر است.', ok: false }, 400)

    const polled = await pollDeployment(req, deploymentId)

    // A build that just finished is verified in the same call: the operator pressed
    // one button and wants one answer, and `verifying` is not a state worth showing.
    if (polled.status === 'verifying') {
      const verified = await verifyDeployment(req, deploymentId)
      return json({ message: verified.message, ok: verified.ok, status: verified.ok ? 'live' : 'failed' })
    }

    return json({ ok: true, status: polled.status })
  },
}

/** `POST /api/platform/sites/:id/deployment/verify` — health-check and promote. */
export const siteDeploymentVerifyEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment/verify',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body } = await readBody(req)
    const deploymentId = String(body?.deployment ?? '')
    if (!isUuid(deploymentId)) return json({ message: 'شناسهٔ استقرار نامعتبر است.', ok: false }, 400)

    const verified = await verifyDeployment(req, deploymentId)
    return json({ message: verified.message, ok: verified.ok }, verified.ok ? 200 : 422)
  },
}

/** `POST /api/platform/sites/:id/deployment/stop` — stop serving, keep the application. */
export const siteDeploymentStopEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment/stop',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body } = await readBody(req)
    const deploymentId = String(body?.deployment ?? '')
    if (!isUuid(deploymentId)) return json({ message: 'شناسهٔ استقرار نامعتبر است.', ok: false }, 400)

    const reason = String(body?.reason ?? 'توقف دستی توسط مدیر پلتفرم.')
    const result = await stopDeployment(req, deploymentId, reason)
    return json(result, result.ok ? 200 : 404)
  },
}

/**
 * `POST /api/platform/sites/:id/deployment/rollback` — redeploy a previous commit.
 *
 * Not an undo button on the running application: it creates a *new* deployment row
 * pinned to the old row's `commitSha`, runs it through the same verification, and
 * promotes it only if it answers. Mutating the live application in place would leave
 * no record of what was rolled back from, and no way back if the rollback is worse.
 */
export const siteDeploymentRollbackEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment/rollback',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body } = await readBody(req)
    const sourceId = String(body?.deployment ?? '')
    if (!isUuid(sourceId)) return json({ message: 'شناسهٔ استقرار نامعتبر است.', ok: false }, 400)

    const source = (await req.payload.findByID({
      collection: 'site-deployments',
      depth: 0,
      disableErrors: true,
      id: sourceId,
      overrideAccess: true,
      req,
    })) as null | Record<string, unknown>

    if (!source) return json({ message: 'استقرار مبدأ پیدا نشد.', ok: false }, 404)
    if (String(idOf(source.site)) !== String(site.id)) {
      return json({ message: 'این استقرار برای این سایت نیست.', ok: false }, 409)
    }

    const commit = String(source.commitSha ?? '')
    if (!commit) {
      return json({ message: 'این استقرار کامیت ثبت‌شده‌ای ندارد؛ بازگشت ممکن نیست.', ok: false }, 409)
    }

    const created = await createDeployment({
      domainMode: String(source.domainMode ?? 'preview') as DomainMode,
      packageRef: String(idOf(source.themePackage)),
      ref: commit,
      req,
      site,
      targetRef: String(idOf(source.target)),
    })

    if (!created.ok) return json({ message: created.message, ok: false }, created.status)

    void runDeployment(req, created.deploymentId).catch((err: unknown) => {
      req.payload.logger.error({ err: err as Error, msg: `rollback ${created.deploymentId} crashed` })
    })

    return json({ commit, deployment: created.deploymentId, ok: true }, 202)
  },
}

/**
 * `POST /api/platform/sites/:id/deployment/revert` — hand the site back to the
 * built-in renderer.
 *
 * The escape hatch that makes everything above safe to try. One call, and the site is
 * served by this Next app again exactly as it was before any of this existed.
 */
export const siteDeploymentRevertEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment/revert',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { docs } = await req.payload.find({
      collection: 'site-deployments',
      depth: 0,
      limit: 25,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [
          { site: { equals: String(site.id) } },
          { status: { in: ['live', 'verifying', 'building', 'creating'] } },
        ],
      },
    })

    for (const row of docs as unknown as Record<string, unknown>[]) {
      await stopDeployment(req, String(row.id), 'بازگشت به رندرر داخلی.')
    }

    await req.payload.update({
      collection: 'sites',
      data: { activeDeployment: null, renderedBy: 'platform' },
      depth: 0,
      id: String(site.id),
      overrideAccess: true,
      req,
    })

    return json({ ok: true, reverted: docs.length })
  },
}

/**
 * `GET /api/platform/routing` — the upstream table Caddy needs.
 *
 * §5 Option A of `docs/theme-deployments.md`: Caddy stays the edge and holds the
 * customer's certificate, so it needs to know which host proxies to which theme app.
 * Generated, never hand-written — a hand-maintained map is one forgotten line away
 * from a customer's domain serving another customer's storefront.
 *
 * Only `edge`-mode deployments appear. `preview` ones are reached on the target's own
 * wildcard, and `direct` ones have left Caddy entirely.
 */
export const routingTableEndpoint: Endpoint = {
  path: '/platform/routing',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const { docs } = await req.payload.find({
      collection: 'site-deployments',
      depth: 0,
      limit: 500,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [{ status: { equals: 'live' } }, { domainMode: { equals: 'edge' } }],
      },
    })

    const routes: { host: string; upstream: string }[] = []

    for (const row of docs as unknown as Record<string, unknown>[]) {
      const siteId = idOf(row.site)
      if (!siteId) continue

      const site = (await req.payload.findByID({
        collection: 'sites',
        depth: 0,
        disableErrors: true,
        id: siteId,
        overrideAccess: true,
        req,
      })) as null | Record<string, unknown>

      const upstream = String(row.previewDomain ?? '')
      if (!site?.domain || !upstream) continue

      /**
       * A site that is not `active` is not routed to its theme, however live the
       * deployment is.
       *
       * Suspension is enforced by the built-in renderer: `getSiteContext().serving`
       * is `status === 'active'`, and a suspended site gets `SiteHolding` instead of
       * content. An externally deployed theme does not consult that — it holds its
       * own API key and renders whatever `/api/site` gives it. So leaving a suspended
       * site in this map means the one customer who stopped paying is the one whose
       * storefront keeps working, which is the exact opposite of the intent.
       *
       * Dropping the route falls the hostname back to `web:3000`, where the existing
       * holding page answers. The deployment row is left alone — suspension is
       * usually temporary, and resuming the site should not require a rebuild.
       */
      if (String(site.status ?? '') !== 'active') continue

      /**
       * The host comes from the *deployment*, not from the site, and a drift between
       * the two drops the route rather than papering over it.
       *
       * `row.domain` is the hostname this application was created with, and it is the
       * hostname the upstream's own vhost answers to. If the customer has since
       * changed their domain, routing the new one here sends every request to a
       * Coolify app that will 404 it — a broken site that looks like a CMS bug. A
       * missing route instead falls through to `web:3000` and the built-in renderer,
       * which is the outcome we want while a redeploy is pending.
       */
      const host = String(row.domain ?? '')
      if (!host || host !== String(site.domain)) continue

      routes.push({ host, upstream })

      for (const alias of Array.isArray(site.domains) ? site.domains : []) {
        const entry = alias as { hostname?: unknown; verified?: unknown }
        // An unverified alias resolves no tenant and gets no certificate; routing it
        // would be routing a hostname nobody proved they own.
        if (entry?.verified === true && entry.hostname) {
          routes.push({ host: String(entry.hostname), upstream })
        }
      }
    }

    return json({ generatedAt: new Date().toISOString(), ok: true, routes })
  },
}

/**
 * Registration order: literals before patterns, and every `/platform/sites/:id/<word>`
 * ahead of the fleet file's bare `/platform/sites/:id`.
 */
export const platformDeploymentEndpoints: Endpoint[] = [
  themePackagesListEndpoint,
  themePackageSyncEndpoint,
  themePackagePublishEndpoint,
  routingTableEndpoint,
  // Site-scoped literals — all of these must precede `/platform/sites/:id`.
  siteDeploymentPollEndpoint,
  siteDeploymentVerifyEndpoint,
  siteDeploymentStopEndpoint,
  siteDeploymentRollbackEndpoint,
  siteDeploymentRevertEndpoint,
  siteDeploymentGetEndpoint,
  siteDeploymentCreateEndpoint,
]
