import type { PayloadRequest } from 'payload'

import { generateApiKey } from '@/lib/api-keys'
import { encryptDeploySecret, decryptDeploySecret, generateRevalidateSecret } from '@/lib/deploy/crypto'
import { isUuid, idOf } from '@/lib/ids'
import { isSafeGitRef, parseRepository, parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'
import { canTransition, holdsApplication, type DeploymentStatus, type DomainMode } from '@/lib/deploy/status'
import { resolveEntitlement } from '@/platform/entitlements'
import { applyThemeTemplate } from '@/platform/saas-report'
import { emitPlatformEvent } from '@/platform/webhooks'
import { readDeployTargetToken } from '@/collections/hooks/deploySecrets'
import { CoolifyClient, coolifyAppName, scrubDetail, type DeployTarget } from './coolify'
import { buildEnvironment } from './environment'
import { resolveCommitSha } from './github'

/**
 * The deploy service — everything between "a customer picked a theme" and "it is
 * serving".
 *
 * ## Why this is a job and not a request handler
 *
 * A Coolify build takes minutes. `POST /api/platform/sites/:id/deployment` answers
 * 202 with a row id and returns; this runs behind it. An endpoint that waited would
 * time out behind Caddy, and the operator would be left with a spinner and a half-
 * created application nothing in the CMS knows about.
 *
 * ## The invariant every step is arranged around
 *
 * **A failed theme deploy must never take a live site down.** The site keeps being
 * served by whatever served it before — the built-in renderer, or the previous
 * deployment — until a new one has actually answered a health check. `sites.renderedBy`
 * flips at the very end, after verification, and `failed` is a state that touches
 * nothing but this row.
 *
 * The second invariant, cheaper to state and more expensive to miss: **`appUuid` is
 * persisted before anything else can fail.** An orphaned Coolify application with no
 * row pointing at it is the one state that costs a human being an afternoon.
 */

export type DeployOutcome = { deploymentId: string; ok: true } | { message: string; ok: false }

/** Truncate and scrub anything on its way to a field an admin will read. */
const logLine = (value: unknown): string => scrubDetail(value, 4000)

/**
 * Write a status, refusing an illegal move.
 *
 * The refusal is logged rather than thrown: a job that crashes mid-transition leaves
 * a row stuck in `building` forever, which is worse than a row whose last legal state
 * is recorded with a warning beside it.
 */
export const setDeploymentStatus = async (
  req: PayloadRequest,
  deploymentId: string,
  status: DeploymentStatus,
  extra: Record<string, unknown> = {},
): Promise<void> => {
  const current = await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })

  if (!current) return

  const from = (current as { status?: unknown }).status

  if (!canTransition(from, status)) {
    req.payload.logger.warn({
      msg: `deployment ${deploymentId}: refused ${String(from)} → ${status}`,
    })
    return
  }

  try {
    await req.payload.update({
      collection: 'site-deployments',
      data: { ...extra, status },
      depth: 0,
      id: deploymentId,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    /**
     * The read above proves the row existed a moment ago, not that it still does. A
     * deploy runs for minutes and an operator can delete its row mid-flight; when they
     * do, the remaining status writes have nothing to write to.
     *
     * This is a status *update* — it carries no work of its own, and the deploy that
     * called it is either finishing or already lost. Throwing here would turn a row
     * the operator deliberately removed into an unhandled rejection in the jobs queue,
     * so it is logged and swallowed.
     */
    req.payload.logger.warn({
      err: error,
      msg: `deployment ${deploymentId}: could not record status ${status} (row removed?)`,
    })
  }
}

const fail = async (
  req: PayloadRequest,
  deploymentId: string,
  message: string,
  detail?: unknown,
): Promise<DeployOutcome> => {
  await setDeploymentStatus(req, deploymentId, 'failed', {
    lastError: logLine(message),
    ...(detail === undefined ? {} : { logTail: logLine(detail) }),
  })
  return { message, ok: false }
}

/** Load a target with its token decrypted. The only caller of `readDeployTargetToken`. */
export const loadTarget = async (
  req: PayloadRequest,
  id: string,
): Promise<null | DeployTarget> => {
  if (!isUuid(id)) return null

  const doc = (await req.payload.findByID({
    collection: 'deploy-targets',
    depth: 0,
    disableErrors: true,
    id,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!doc) return null

  const apiToken = await readDeployTargetToken(req, id)
  if (!apiToken) return null

  return {
    apiToken,
    baseUrl: String(doc.baseUrl ?? ''),
    environmentName: String(doc.environmentName ?? 'production'),
    githubAppUuid: doc.githubAppUuid ? String(doc.githubAppUuid) : null,
    gitSource: (doc.gitSource as DeployTarget['gitSource']) ?? 'public',
    id,
    name: String(doc.name ?? ''),
    privateKeyUuid: doc.privateKeyUuid ? String(doc.privateKeyUuid) : null,
    projectUuid: String(doc.projectUuid ?? ''),
    serverUuid: String(doc.serverUuid ?? ''),
  }
}

/** The manifest a package last synced, re-parsed rather than trusted as stored shape. */
export const manifestOf = (pkg: Record<string, unknown>): null | ThemeManifest => {
  const raw = pkg.manifest
  if (!raw || typeof raw !== 'object') return null
  // Re-validated against *this* deployment's contract version, not the one that was
  // current at sync time: a CMS downgrade must not silently keep deploying a theme
  // whose contract it no longer serves.
  const parsed = parseThemeManifest(
    raw,
    Number(pkg.contractVersion ?? 1) || 1,
  )
  return parsed.ok ? parsed.manifest : null
}

/**
 * The preview hostname a deployment gets before any customer DNS moves.
 *
 * `<site-slug>-<theme-key>.sites.example.com`. Deterministic, so a redeploy of the
 * same pair reuses it, and so `findApplicationByName` has something stable to
 * reconcile against.
 */
export const previewHostname = (
  wildcardDomain: null | string | undefined,
  site: Record<string, unknown>,
  themeKey: string,
): null | string => {
  const base = String(wildcardDomain ?? '').replace(/^\*\./, '').trim()
  if (!base) return null
  const label = `${String(site.domain ?? site.id)}-${themeKey}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return `${label}.${base}`
}

export type StartDeploymentInput = {
  domainMode?: DomainMode
  packageRef: string
  ref?: null | string
  req: PayloadRequest
  site: Record<string, unknown>
  targetRef?: null | string
}

/**
 * Validate everything, create the row, and hand back its id. Fast — no network.
 *
 * Every refusal here is a Persian message and a 400, *before* a row exists. The
 * refusals that need a row (Coolify said no) are statuses on it. Mixing the two is
 * how a catalogue of half-created deployment rows accumulates from typos.
 */
export const createDeployment = async (
  input: StartDeploymentInput,
): Promise<{ deploymentId: string; ok: true } | { message: string; ok: false; status: number }> => {
  const { packageRef, req, site } = input
  const siteId = String(site.id)

  if (site.status !== 'active') {
    return { message: 'سایت فعال نیست؛ ابتدا وضعیت آن را به «فعال» تغییر دهید.', ok: false, status: 409 }
  }

  const pkg = await packageByRef(req, packageRef)
  if (!pkg) return { message: `پوستهٔ «${packageRef}» پیدا نشد.`, ok: false, status: 404 }

  if (pkg.status !== 'published') {
    return {
      message: 'این پوسته منتشر نشده است. ابتدا آن را همگام‌سازی و منتشر کنید.',
      ok: false,
      status: 409,
    }
  }

  const manifest = manifestOf(pkg)
  if (!manifest) {
    return {
      message: 'مانیفست این پوسته خوانده نشده یا نامعتبر است. «همگام‌سازی از گیت‌هاب» را اجرا کنید.',
      ok: false,
      status: 409,
    }
  }

  const siteType = String(site.type ?? 'business')
  /**
   * Both lists have to allow the type, and they are not the same list.
   *
   * `manifest.siteTypes` is the theme author's declaration, frozen at the last sync:
   * a portfolio theme with no product blocks genuinely cannot render a store, and no
   * operator setting should be able to override that.
   *
   * The row's `siteTypes` is the operator's own narrowing — "we bought this one for
   * stores only", "this one is not ready for portfolios yet". Reading only the
   * manifest would make that field decorative, and a field in the admin UI that
   * silently does nothing is worse than no field.
   */
  const rowTypes = (Array.isArray(pkg.siteTypes) ? pkg.siteTypes : []).map(String)
  const allowed =
    manifest.siteTypes.includes(siteType as (typeof manifest.siteTypes)[number]) &&
    (rowTypes.length === 0 || rowTypes.includes(siteType))

  if (!allowed) {
    return {
      message: `این پوسته برای سایت از نوع «${siteType}» ساخته نشده است.`,
      ok: false,
      status: 409,
    }
  }

  // A paid theme is a plan question, answered by the machinery that already answers
  // plan questions — not a second entitlement system living in this file.
  const requiredFeature = String(pkg.requiredFeature ?? '').trim()
  if (requiredFeature) {
    const entitlement = await resolveEntitlement(req, site)
    if (!entitlement?.featureMap?.[requiredFeature]) {
      return {
        message: 'پلن این سایت شامل این پوسته نیست.',
        ok: false,
        status: 402,
      }
    }
  }

  const targetId = await resolveTargetId(req, input.targetRef, pkg)
  if (!targetId) {
    return { message: 'سرور استقرار مشخص یا در دسترس نیست.', ok: false, status: 409 }
  }

  /**
   * Precedence: an explicit ref beats the package's pin, which beats its default
   * branch. The pin exists so an operator can freeze a theme at a known-good commit
   * without freezing the *branch* for everyone; an explicit ref is how a rollback
   * asks for an older one, and it has to win or a rollback would silently redeploy
   * the pin it is rolling back from.
   */
  const effectiveRef = String(input.ref || pkg.pinnedCommit || pkg.defaultRef || 'main')
  if (!isSafeGitRef(effectiveRef)) {
    return { message: 'نام شاخه یا تگ نامعتبر است.', ok: false, status: 400 }
  }

  const domainMode: DomainMode = input.domainMode ?? 'preview'

  if (domainMode !== 'preview' && site.domainVerified !== true) {
    return {
      message: 'تا وقتی دامنهٔ اصلی تأیید نشده، فقط حالت «پیش‌نمایش» ممکن است.',
      ok: false,
      status: 409,
    }
  }

  // The rule §5 of docs/theme-deployments.md exists to state: in `direct` mode the
  // customer's DNS leaves Caddy, so the reserved API paths — checkout, the contact
  // form, media — only work if the theme proxies them back. A theme that does not
  // declare `proxiesApi` would take checkout down the moment DNS moved.
  if (domainMode === 'direct' && !manifest.proxiesApi) {
    return {
      message:
        'این پوسته مسیرهای /api را پراکسی نمی‌کند، پس حالت «دامنه مستقیم» پرداخت و فرم تماس را از کار می‌اندازد. از حالت Caddy استفاده کنید.',
      ok: false,
      status: 409,
    }
  }

  const target = await req.payload.findByID({
    collection: 'deploy-targets',
    depth: 0,
    disableErrors: true,
    id: targetId,
    overrideAccess: true,
    req,
  })

  const preview = previewHostname(
    (target as null | Record<string, unknown>)?.wildcardDomain as null | string,
    site,
    String(pkg.key ?? 'theme'),
  )

  if (domainMode === 'preview' && !preview) {
    return {
      message: 'برای حالت پیش‌نمایش، سرور استقرار باید «دامنهٔ عام پیش‌نمایش» داشته باشد.',
      ok: false,
      status: 409,
    }
  }

  const created = await req.payload.create({
    collection: 'site-deployments',
    data: {
      domain: domainMode === 'preview' ? preview : String(site.domain ?? ''),
      domainMode,
      previewDomain: preview,
      ref: effectiveRef,
      site: siteId,
      status: 'queued',
      target: targetId,
      themePackage: String(pkg.id),
    },
    depth: 0,
    overrideAccess: true,
    req,
  })

  return { deploymentId: String((created as { id: unknown }).id), ok: true }
}

const packageByRef = async (
  req: PayloadRequest,
  ref: string,
): Promise<null | Record<string, unknown>> => {
  const value = String(ref ?? '').trim()
  if (!value) return null

  if (isUuid(value)) {
    const doc = await req.payload.findByID({
      collection: 'theme-packages',
      depth: 0,
      disableErrors: true,
      id: value,
      overrideAccess: true,
      req,
    })
    return (doc as unknown as null | Record<string, unknown>) ?? null
  }

  const { docs } = await req.payload.find({
    collection: 'theme-packages',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: value } },
  })
  return (docs[0] as unknown as undefined | Record<string, unknown>) ?? null
}

const resolveTargetId = async (
  req: PayloadRequest,
  requested: null | string | undefined,
  pkg: Record<string, unknown>,
): Promise<null | string> => {
  const wanted = String(requested ?? '').trim()

  if (wanted) {
    if (isUuid(wanted)) return wanted
    const { docs } = await req.payload.find({
      collection: 'deploy-targets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { and: [{ key: { equals: wanted } }, { active: { equals: true } }] },
    })
    return docs[0] ? String((docs[0] as { id: unknown }).id) : null
  }

  const fromPackage = idOf(pkg.defaultTarget)
  if (fromPackage) return fromPackage

  const { docs } = await req.payload.find({
    collection: 'deploy-targets',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    sort: 'createdAt',
    where: { active: { equals: true } },
  })
  return docs[0] ? String((docs[0] as { id: unknown }).id) : null
}

/**
 * Mint the credential this deployment authenticates with.
 *
 * A `role: "site"` key, scoped to exactly this site, one per deployment. Never a
 * platform key: `docs/platform-control-api.md` §1 is explicit that a platform key is
 * the deployment's root credential, and a theme running on a customer's domain is the
 * last process that should hold one.
 *
 * The raw value exists in exactly one place after this returns — the Coolify
 * environment — and in this function's return value on the way there.
 */
const mintSiteKey = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  themeName: string,
): Promise<{ id: string; raw: string }> => {
  const { raw, hash, prefix } = generateApiKey()

  const doc = await req.payload.create({
    collection: 'api-keys',
    data: {
      keyHash: hash,
      keyPrefix: prefix,
      name: `پوستهٔ ${themeName} — ${String(site.domain ?? site.id)}`,
      role: 'site',
      site: String(site.id),
    },
    depth: 0,
    overrideAccess: true,
    req,
  })

  return { id: String((doc as { id: unknown }).id), raw }
}

/** Revoke a deployment's key. Called when it is stopped or superseded — a dead deployment's credential is a live one. */
export const revokeDeploymentKey = async (
  req: PayloadRequest,
  deployment: Record<string, unknown>,
): Promise<void> => {
  const keyId = idOf(deployment.apiKey)
  if (!keyId) return

  try {
    await req.payload.update({
      collection: 'api-keys',
      data: { disabledAt: new Date().toISOString() },
      depth: 0,
      id: keyId,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    req.payload.logger.warn({ msg: `could not revoke key ${keyId}: ${(error as Error).message}` })
  }
}

/**
 * Run one deployment to completion.
 *
 * Long, and deliberately linear: every step is a named failure with a Persian reason
 * written onto the row. Splitting it into a pipeline abstraction would hide exactly
 * the thing an operator reads this for — which step stopped, and what it said.
 */
export const runDeployment = async (
  req: PayloadRequest,
  deploymentId: string,
): Promise<DeployOutcome> => {
  const deployment = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!deployment) return { message: 'استقرار پیدا نشد.', ok: false }

  const siteId = idOf(deployment.site)
  const site = siteId
    ? ((await req.payload.findByID({
        collection: 'sites',
        depth: 0,
        disableErrors: true,
        id: siteId,
        overrideAccess: true,
        req,
      })) as unknown as null | Record<string, unknown>)
    : null

  if (!site) return fail(req, deploymentId, 'سایت این استقرار پیدا نشد.')

  const pkg = (await req.payload.findByID({
    collection: 'theme-packages',
    depth: 0,
    disableErrors: true,
    id: String(idOf(deployment.themePackage)),
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!pkg) return fail(req, deploymentId, 'پوستهٔ این استقرار پیدا نشد.')

  const manifest = manifestOf(pkg)
  if (!manifest) return fail(req, deploymentId, 'مانیفست پوسته نامعتبر است.')

  const target = await loadTarget(req, String(idOf(deployment.target)))
  if (!target) {
    return fail(req, deploymentId, 'سرور استقرار در دسترس نیست یا توکن آن خوانا نیست.')
  }

  const repo = parseRepository(pkg.repository)
  if (!repo) return fail(req, deploymentId, 'نشانی مخزن پوسته نامعتبر است.')

  await setDeploymentStatus(req, deploymentId, 'creating', { lastError: null })

  const client = new CoolifyClient(target)
  const themeKey = String(pkg.key ?? 'theme')
  const appName = coolifyAppName(String(site.domain ?? site.id), themeKey)
  const ref = String(deployment.ref ?? pkg.defaultRef ?? 'main')
  const commitSha = String(pkg.pinnedCommit ?? '') || (await resolveCommitSha(String(pkg.repository), ref))

  const domainMode = String(deployment.domainMode ?? 'preview') as DomainMode
  const previewDomain = deployment.previewDomain ? String(deployment.previewDomain) : null
  const siteDomain = String(site.domain ?? '')

  /**
   * Which hostnames the application answers on.
   *
   * In `edge` mode Caddy holds the customer's domain and proxies to this app, so the
   * app must *not* also claim the domain in Coolify — two certificate authorities
   * racing for one hostname is a rate limit and an outage. It gets the preview name
   * only, and Caddy points at it.
   */
  const domains =
    domainMode === 'direct'
      ? [siteDomain, previewDomain].filter(Boolean).map((host) => `https://${host}`)
      : [previewDomain].filter(Boolean).map((host) => `https://${host}`)

  if (!domains.length) {
    return fail(req, deploymentId, 'هیچ میزبانی برای این استقرار مشخص نشده است.')
  }

  const serviceDomain = domainMode === 'direct' ? siteDomain : previewDomain!

  // ---------------------------------------------------------------------------
  // 1. The application. Reconcile first: a create whose response was lost must not
  //    produce a second one on retry.
  // ---------------------------------------------------------------------------
  let appUuid = deployment.appUuid ? String(deployment.appUuid) : ''

  if (!appUuid) {
    const existing = await client.findApplicationByName(appName)
    if (existing.ok && existing.data) appUuid = existing.data.uuid
  }

  if (!appUuid) {
    const created = await client.createApplication({
      baseDirectory: manifest.build.baseDirectory,
      buildCommand: manifest.build.buildCommand,
      buildPack: manifest.build.buildPack,
      dockerfileLocation: manifest.build.dockerfileLocation,
      domains,
      gitBranch: ref,
      gitCommitSha: commitSha,
      gitRepository:
        target.gitSource === 'public'
          ? `https://github.com/${repo.owner}/${repo.name}`
          : `${repo.owner}/${repo.name}`,
      healthCheckPath: manifest.build.healthCheckPath,
      installCommand: manifest.build.installCommand,
      isStatic: manifest.build.isStatic,
      name: appName,
      port: manifest.build.port,
      publishDirectory: manifest.build.publishDirectory,
      startCommand: manifest.build.startCommand,
    })

    if (!created.ok) {
      return fail(req, deploymentId, `ساخت اپلیکیشن در Coolify ناموفق بود: ${created.message}`, created.detail)
    }

    appUuid = String(created.data.uuid ?? '')
    if (!appUuid) return fail(req, deploymentId, 'Coolify شناسهٔ اپلیکیشن برنگرداند.')
  }

  // Before anything else can fail. An application Coolify holds and the CMS does not
  // know about is the one state nothing here can clean up.
  await req.payload.update({
    collection: 'site-deployments',
    data: { appUuid, commitSha: commitSha ?? null, domain: serviceDomain },
    depth: 0,
    id: deploymentId,
    overrideAccess: true,
    req,
  })

  // ---------------------------------------------------------------------------
  // 2. Credentials and environment.
  // ---------------------------------------------------------------------------
  let apiKeyId = idOf(deployment.apiKey)
  let apiKeyRaw: null | string = null

  if (!apiKeyId) {
    const minted = await mintSiteKey(req, site, String(pkg.name ?? themeKey))
    apiKeyId = minted.id
    apiKeyRaw = minted.raw
  }

  const revalidateSecret =
    decryptDeploySecret(deployment.revalidateSecret as null | string) ?? generateRevalidateSecret()

  const environment = await buildEnvironment({
    apiKey: apiKeyRaw,
    manifest,
    req,
    revalidateSecret,
    serviceDomain,
    site,
    themePackageId: String(pkg.id),
  })

  if (environment.errors.length) {
    return fail(req, deploymentId, `تنظیمات پوسته کامل نیست: ${environment.errors.join(' ')}`)
  }

  const envResult = await client.setEnvironment(appUuid, environment.variables)
  if (!envResult.ok) {
    return fail(req, deploymentId, `نوشتن متغیرهای محیطی ناموفق بود: ${envResult.message}`, envResult.detail)
  }

  await req.payload.update({
    collection: 'site-deployments',
    data: {
      apiKey: apiKeyId,
      revalidateSecret: encryptDeploySecret(revalidateSecret),
    },
    depth: 0,
    id: deploymentId,
    overrideAccess: true,
    req,
  })

  // ---------------------------------------------------------------------------
  // 3. Build.
  // ---------------------------------------------------------------------------
  const deployStarted = await client.deploy(appUuid)
  if (!deployStarted.ok) {
    return fail(req, deploymentId, `شروع استقرار ناموفق بود: ${deployStarted.message}`, deployStarted.detail)
  }

  await setDeploymentStatus(req, deploymentId, 'building', {
    lastDeploymentUuid: deployStarted.data.deploymentUuid,
    logTail: `استقرار در Coolify آغاز شد (${appName}).`,
  })

  await emitPlatformEvent(req, {
    data: { deployment: deploymentId, package: themeKey, ref, target: target.name },
    event: 'deployment.started',
    message: `استقرار پوستهٔ «${String(pkg.name ?? themeKey)}» روی ${serviceDomain} آغاز شد.`,
    site,
    targetCollection: 'site-deployments',
    targetId: deploymentId,
  })

  return { deploymentId, ok: true }
}

/**
 * Poll one building deployment and advance it.
 *
 * Separate from `runDeployment` so the queue can call it on a schedule without
 * re-running the create path — and so a CMS restart mid-build picks the deployment
 * back up instead of leaving it `building` forever.
 */
export const pollDeployment = async (
  req: PayloadRequest,
  deploymentId: string,
): Promise<{ changed: boolean; status: string }> => {
  const deployment = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!deployment) return { changed: false, status: 'missing' }

  const status = String(deployment.status ?? '')
  if (status !== 'building' && status !== 'creating') return { changed: false, status }

  const target = await loadTarget(req, String(idOf(deployment.target)))
  if (!target) return { changed: false, status }

  const client = new CoolifyClient(target)
  const buildUuid = deployment.lastDeploymentUuid ? String(deployment.lastDeploymentUuid) : ''

  if (!buildUuid) return { changed: false, status }

  const result = await client.deploymentStatus(buildUuid)
  if (!result.ok) return { changed: false, status }

  if (result.data.status === 'failed') {
    await setDeploymentStatus(req, deploymentId, 'failed', {
      lastError: `Coolify گزارش داد: ${result.data.raw}`,
    })
    return { changed: true, status: 'failed' }
  }

  if (result.data.status === 'succeeded') {
    await setDeploymentStatus(req, deploymentId, 'verifying', {
      logTail: `بیلد کامل شد (${result.data.raw}).`,
    })
    return { changed: true, status: 'verifying' }
  }

  return { changed: false, status }
}

/**
 * The last gate: does it actually answer?
 *
 * A build that succeeded is not a site that works — a theme can compile perfectly and
 * 500 on its first request because an env var it needed is absent. Nothing flips to
 * `live`, and no site's `renderedBy` changes, until this has had a 2xx.
 */
export const verifyDeployment = async (
  req: PayloadRequest,
  deploymentId: string,
): Promise<{ message: string; ok: boolean }> => {
  const deployment = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!deployment) return { message: 'استقرار پیدا نشد.', ok: false }

  const host = String(deployment.domain ?? '')
  if (!host) return { message: 'میزبانی برای بررسی وجود ندارد.', ok: false }

  const pkg = (await req.payload.findByID({
    collection: 'theme-packages',
    depth: 0,
    disableErrors: true,
    id: String(idOf(deployment.themePackage)),
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  const path = String(pkg?.healthCheckPath ?? '') || '/'

  let response: null | Response = null
  try {
    response = await fetch(`https://${host}${path}`, {
      headers: { 'user-agent': 'eshobe-cms-healthcheck' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    await req.payload.update({
      collection: 'site-deployments',
      data: { healthCheckedAt: new Date().toISOString(), lastError: logLine((error as Error).message) },
      depth: 0,
      id: deploymentId,
      overrideAccess: true,
      req,
    })
    return { message: 'پوسته پاسخ نداد.', ok: false }
  }

  const healthy = response.status >= 200 && response.status < 400

  if (!healthy) {
    await setDeploymentStatus(req, deploymentId, 'failed', {
      healthCheckedAt: new Date().toISOString(),
      lastError: `بررسی سلامت پاسخ ${response.status} گرفت.`,
    })
    return { message: `بررسی سلامت پاسخ ${response.status} گرفت.`, ok: false }
  }

  await promoteDeployment(req, deployment)
  return { message: 'پوسته در حال سرویس‌دهی است.', ok: true }
}

/**
 * Make this deployment the site's renderer, and retire whatever was.
 *
 * Order matters and is the opposite of intuition: the new row is marked `live`
 * *first*, then the old ones are stopped. Stopping first would leave a window in
 * which the site has no live deployment and `renderedBy` points at nothing.
 */
export const promoteDeployment = async (
  req: PayloadRequest,
  deployment: Record<string, unknown>,
): Promise<void> => {
  const deploymentId = String(deployment.id)
  const siteId = String(idOf(deployment.site))

  await setDeploymentStatus(req, deploymentId, 'live', {
    deployedAt: new Date().toISOString(),
    healthCheckedAt: new Date().toISOString(),
    lastError: null,
  })

  const { docs: previous } = await req.payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit: 50,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        { id: { not_equals: deploymentId } },
        { status: { in: ['live', 'verifying', 'building', 'creating'] } },
      ],
    },
  })

  for (const row of previous as unknown as Record<string, unknown>[]) {
    await stopDeployment(req, String(row.id), 'جایگزین شد با استقرار تازه.')
  }

  const pkg = (await req.payload.findByID({
    collection: 'theme-packages',
    depth: 0,
    disableErrors: true,
    id: String(idOf(deployment.themePackage)),
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  const site = (await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: siteId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  // The tokens the theme renders with. A copy, exactly as `applyThemeTemplate`
  // documents — a live link would repaint twenty customers when an operator tweaks a
  // preset.
  const templateId = idOf(pkg?.themeTemplate)
  if (templateId && site) {
    await applyThemeTemplate(req, site, templateId)
  }

  /**
   * `renderedBy` only leaves `platform` for a mode where the customer's own domain is
   * actually involved. A preview deployment is a rehearsal: the site keeps being
   * served by this app, which is what makes the whole preview step reversible.
   */
  const mode = String(deployment.domainMode ?? 'preview')
  if (mode !== 'preview') {
    await req.payload.update({
      collection: 'sites',
      data: { activeDeployment: deploymentId, renderedBy: 'deployment' },
      depth: 0,
      id: siteId,
      overrideAccess: true,
      req,
    })
  }

  await emitPlatformEvent(req, {
    data: { deployment: deploymentId, domainMode: mode },
    event: 'deployment.live',
    message: `پوسته روی ${String(deployment.domain ?? '')} در حال سرویس‌دهی است.`,
    site: site ?? siteId,
    targetCollection: 'site-deployments',
    targetId: deploymentId,
  })
}

/**
 * Stop an application without deleting it.
 *
 * The same reasoning as "do not delete a site": Coolify keeps the application, its
 * volumes and its build history, and starting it again is one call. Deleting throws
 * away the only copy of what was running when something broke.
 */
export const stopDeployment = async (
  req: PayloadRequest,
  deploymentId: string,
  reason: string,
): Promise<{ message: string; ok: boolean }> => {
  const deployment = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!deployment) return { message: 'استقرار پیدا نشد.', ok: false }

  if (holdsApplication(deployment.status) && deployment.appUuid) {
    const target = await loadTarget(req, String(idOf(deployment.target)))
    if (target) {
      const result = await new CoolifyClient(target).stop(String(deployment.appUuid))
      if (!result.ok) {
        req.payload.logger.warn({ msg: `stop failed for ${deploymentId}: ${result.message}` })
      }
    }
  }

  await setDeploymentStatus(req, deploymentId, 'stopped', { lastError: logLine(reason) })
  await revokeDeploymentKey(req, deployment)

  const siteId = String(idOf(deployment.site))
  const site = (await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: siteId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  // If this was the site's renderer, hand traffic back to the built-in one. A
  // suspended or stopped deployment must not leave a site pointing at a dead
  // container — `SiteHolding` and the platform renderer are the safe floor.
  if (site && String(idOf(site.activeDeployment)) === deploymentId) {
    await req.payload.update({
      collection: 'sites',
      data: { activeDeployment: null, renderedBy: 'platform' },
      depth: 0,
      id: siteId,
      overrideAccess: true,
      req,
    })
  }

  await emitPlatformEvent(req, {
    data: { deployment: deploymentId, reason },
    event: 'deployment.stopped',
    message: `استقرار روی ${String(deployment.domain ?? '')} متوقف شد: ${reason}`,
    site: site ?? siteId,
    targetCollection: 'site-deployments',
    targetId: deploymentId,
  })

  return { message: 'استقرار متوقف شد.', ok: true }
}
