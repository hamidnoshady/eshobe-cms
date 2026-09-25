import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { THEME_PACKAGE_SYNC_CONTEXT_KEY } from '@/collections/ThemePackages'
import { fetchThemeManifest } from '@/deploy/github'
import { buildRoutingTable } from '@/deploy/routing'
import {
  advanceDeployment,
  createDeployment,
  stopDeployment,
  stopSiteDeployments,
  updateInfoFor,
  verifyDeployment,
} from '@/deploy/service'
import { idOf, isUuid } from '@/lib/ids'
import { isSafeGitRef } from '@/lib/deploy/manifest'
import {
  DOMAIN_MODES,
  STALE_DOMAIN_MESSAGE,
  isProductionMode,
  needsRedeploy,
  type DomainMode,
} from '@/lib/deploy/status'
import { emitPlatformEvent } from '@/platform/webhooks'

import { json, param, requireOperator, siteById } from './platformShared'

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
 * ## Why `POST …/deployment` (and `/redeploy`, `/rollback`) answer 202
 *
 * Because a Coolify build takes minutes and this request cannot wait for it. The
 * handler validates, writes a `queued` row and returns its id; the jobs queue
 * (`advanceDeployments`) does the network work, and `GET …/deployment` is how the
 * console follows it. `POST …/deployment/poll` advances one row on demand, which is
 * what the console's «بررسی وضعیت» button and its polling call. A synchronous
 * version of any of these would time out at the proxy and leave the operator unable
 * to tell a slow build from a failed one.
 */

/** Session-only. Registering a repository the platform will build and run is a human decision. */
const requireAdminSession = (req: PayloadRequest): null | Response => {
  if (isPlatformAdmin(req.user)) return null
  return json({ message: 'این عملیات فقط با نشست مدیر پلتفرم انجام می‌شود.', ok: false }, 403)
}

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

/**
 * The row shape a console renders. Never includes `revalidateSecret`, `apiKey` or a
 * key's raw value — built field by field so a column added later stays out until
 * somebody decides it belongs here.
 */
const deploymentRow = (
  doc: Record<string, unknown>,
  site: Record<string, unknown>,
  names: { packages: Map<string, string>; targets: Map<string, string> },
): Record<string, unknown> => ({
  appUuid: doc.appUuid ?? null,
  attention: needsRedeploy(doc, site) ? STALE_DOMAIN_MESSAGE : null,
  commitSha: doc.commitSha ?? null,
  createdAt: doc.createdAt ?? null,
  deployedAt: doc.deployedAt ?? null,
  domain: doc.domain ?? null,
  domainMode: doc.domainMode ?? 'preview',
  healthCheckedAt: doc.healthCheckedAt ?? null,
  id: String(doc.id),
  lastError: doc.lastError ?? null,
  logTail: doc.logTail ?? null,
  needsRedeploy: needsRedeploy(doc, site),
  packageName: names.packages.get(String(idOf(doc.themePackage))) ?? null,
  previewDomain: doc.previewDomain ?? null,
  ref: doc.ref ?? null,
  site: idOf(doc.site),
  status: doc.status ?? 'queued',
  target: idOf(doc.target),
  targetName: names.targets.get(String(idOf(doc.target))) ?? null,
  themePackage: idOf(doc.themePackage),
})

/** A deployment row, only if it belongs to the site in the URL — never another site's row by id. */
const deploymentOfSite = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  deploymentId: string,
): Promise<null | Record<string, unknown>> => {
  if (!isUuid(deploymentId)) return null
  const doc = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as null | Record<string, unknown>
  return doc && String(idOf(doc.site)) === String(site.id) ? doc : null
}

/**
 * The deployment a redeploy starts from: the one serving the customer's domain, else
 * a live preview, else the most recent attempt (a first deploy that failed is the
 * case a "try again" button exists for).
 */
const redeploySource = (
  site: Record<string, unknown>,
  rows: Record<string, unknown>[],
): null | Record<string, unknown> => {
  const active = idOf(site.activeDeployment)
  return (
    rows.find((row) => active && String(row.id) === active) ??
    rows.find((row) => row.status === 'live' && isProductionMode(row.domainMode)) ??
    rows.find((row) => row.status === 'live') ??
    rows.find((row) => row.status !== 'removed') ??
    null
  )
}

const recentDeployments = async (
  req: PayloadRequest,
  siteId: string,
  limit = 25,
): Promise<Record<string, unknown>[]> => {
  const { docs } = await req.payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit,
    overrideAccess: true,
    req,
    sort: '-createdAt',
    where: { site: { equals: siteId } },
  })
  return docs as unknown as Record<string, unknown>[]
}

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
        syncedCommitSha: doc.syncedCommitSha ?? null,
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
      // Tells `forgetSyncedCommitOnRefEdit` this write *is* the sync — the one writer
      // allowed to set the ref and the commit it resolved together.
      context: { [THEME_PACKAGE_SYNC_CONTEXT_KEY]: true },
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
        // What the ref resolved to *now* — the basis of every "new version available"
        // notice. Null when GitHub would not say; that notice is then withheld rather
        // than guessed.
        syncedCommitSha: result.sha,
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

/**
 * `GET /api/platform/sites/:id/deployment` — what is running, what needs doing, and
 * the history.
 *
 * Two derived signals ride along, both computed from this site's own rows and the
 * packages *they* reference — never a fleet-wide read:
 *
 *  - `needsRedeploy` — a live `edge`/`direct` deployment was built for a primary
 *    domain the site has since left (`needsRedeploy` in `src/lib/deploy/status.ts`);
 *  - `update` — the package would deploy a different commit than the one running
 *    (`updateInfoFor`), from the commit the last sync resolved. No GitHub call here.
 */
export const siteDeploymentGetEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const docs = await recentDeployments(req, String(site.id))

    const packageIds = [...new Set(docs.map((doc) => idOf(doc.themePackage)).filter(Boolean))] as string[]
    const targetIds = [...new Set(docs.map((doc) => idOf(doc.target)).filter(Boolean))] as string[]

    const packages = packageIds.length
      ? ((
          await req.payload.find({
            collection: 'theme-packages',
            depth: 0,
            limit: packageIds.length,
            overrideAccess: true,
            pagination: false,
            req,
            where: { id: { in: packageIds } },
          })
        ).docs as unknown as Record<string, unknown>[])
      : []
    const targets = targetIds.length
      ? ((
          await req.payload.find({
            collection: 'deploy-targets',
            depth: 0,
            limit: targetIds.length,
            overrideAccess: true,
            pagination: false,
            req,
            where: { id: { in: targetIds } },
          })
        ).docs as unknown as Record<string, unknown>[])
      : []

    const names = {
      packages: new Map(packages.map((pkg) => [String(pkg.id), String(pkg.name ?? pkg.key ?? '')])),
      targets: new Map(targets.map((target) => [String(target.id), String(target.name ?? '')])),
    }

    const rows = docs.map((doc) => deploymentRow(doc, site, names))
    const source = redeploySource(site, docs)
    const current = source ? (rows.find((row) => row.id === String(source.id)) ?? null) : null
    const sourcePackage = source
      ? (packages.find((pkg) => String(pkg.id) === String(idOf(source.themePackage))) ?? null)
      : null
    const update = source && source.status === 'live' ? updateInfoFor(source, sourcePackage) : null

    return json({
      current,
      deployments: rows,
      needsRedeploy: rows.some((row) => row.needsRedeploy === true),
      ok: true,
      renderedBy: site.renderedBy ?? 'platform',
      update,
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

    // The queue takes it from here; the row is the contract for everything after.
    return json({ deployment: created.deploymentId, ok: true, ref: created.ref, status: 'queued' }, 202)
  },
}

/**
 * `POST /api/platform/sites/:id/deployment/redeploy` — build the site's theme again.
 *
 * The upgrade button and the retry button: a *new* row for the same package, target
 * and domain mode as the deployment the site runs (`redeploySource`), at the ref the
 * package would deploy now (`effectiveRefFor` — pin, else default branch), for the
 * site's *current* primary domain. That last part is what clears `needsRedeploy`
 * after a domain change.
 *
 * `{ ref?, domainMode? }` may override those two, and nothing else: the repository,
 * the package and the target come from the source row, so this route cannot be used
 * to build something the operator did not already deploy to this site. Every check
 * `createDeployment` makes — site active, package published, site type, plan
 * entitlement, verified domain, `proxiesApi` for `direct` — runs again.
 */
export const siteDeploymentRedeployEndpoint: Endpoint = {
  path: '/platform/sites/:id/deployment/redeploy',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const ref = body?.ref === undefined || body.ref === null || body.ref === '' ? null : String(body.ref)
    if (ref !== null && !isSafeGitRef(ref)) {
      return json({ message: 'نام شاخه یا تگ نامعتبر است.', ok: false }, 400)
    }

    if (body?.domainMode && !(DOMAIN_MODES as readonly string[]).includes(String(body.domainMode))) {
      return json(
        { message: `«domainMode» باید یکی از ${DOMAIN_MODES.join('، ')} باشد.`, ok: false },
        400,
      )
    }

    const source = redeploySource(site, await recentDeployments(req, String(site.id)))
    if (!source) {
      return json(
        { message: 'این سایت هنوز استقراری ندارد؛ ابتدا یک پوسته مستقر کنید.', ok: false },
        409,
      )
    }

    const modeRaw = body?.domainMode ? String(body.domainMode) : String(source.domainMode ?? 'preview')

    const created = await createDeployment({
      domainMode: modeRaw as DomainMode,
      packageRef: String(idOf(source.themePackage)),
      ref,
      req,
      site,
      targetRef: String(idOf(source.target)),
    })

    if (!created.ok) return json({ message: created.message, ok: false }, created.status)

    return json(
      {
        deployment: created.deploymentId,
        domainMode: modeRaw,
        ok: true,
        ref: created.ref,
        source: String(source.id),
        status: 'queued',
      },
      202,
    )
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
    if (!(await deploymentOfSite(req, site, deploymentId))) {
      return json({ message: 'این استقرار برای این سایت نیست.', ok: false }, 404)
    }

    // The same step the queue takes: a queued row starts, a build is polled, and a
    // build that just finished is verified in the same call.
    const advanced = await advanceDeployment(req, deploymentId)
    return json({ message: advanced.message, ok: advanced.status !== 'failed', status: advanced.status })
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
    if (!(await deploymentOfSite(req, site, deploymentId))) {
      return json({ message: 'این استقرار برای این سایت نیست.', ok: false }, 404)
    }

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
    if (!(await deploymentOfSite(req, site, deploymentId))) {
      return json({ message: 'این استقرار برای این سایت نیست.', ok: false }, 404)
    }

    const reason = String(body?.reason ?? 'توقف دستی توسط مدیر پلتفرم.').slice(0, 500)
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

    return json({ commit, deployment: created.deploymentId, ok: true, status: 'queued' }, 202)
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

    const { failed, stopped } = await stopSiteDeployments(req, String(site.id), 'بازگشت به رندرر داخلی.')

    await req.payload.update({
      collection: 'sites',
      data: { activeDeployment: null, renderedBy: 'platform' },
      depth: 0,
      id: String(site.id),
      overrideAccess: true,
      req,
    })

    return json({ failed, ok: true, reverted: stopped.length })
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
 * The rules for which rows qualify live in `buildRoutingTable`, shared with the
 * in-process regeneration of `theme-routes.caddy`. The response carries hostnames
 * only — no row ids, keys or secrets.
 */
export const routingTableEndpoint: Endpoint = {
  path: '/platform/routing',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const routes = await buildRoutingTable(req.payload, req)
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
  siteDeploymentRedeployEndpoint,
  siteDeploymentPollEndpoint,
  siteDeploymentVerifyEndpoint,
  siteDeploymentStopEndpoint,
  siteDeploymentRollbackEndpoint,
  siteDeploymentRevertEndpoint,
  siteDeploymentGetEndpoint,
  siteDeploymentCreateEndpoint,
]
