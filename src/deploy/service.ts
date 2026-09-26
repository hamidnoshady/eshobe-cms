import type { PayloadRequest } from 'payload'

import { generateApiKey } from '@/lib/api-keys'
import { encryptDeploySecret, decryptDeploySecret, generateRevalidateSecret } from '@/lib/deploy/crypto'
import { isUuid, idOf } from '@/lib/ids'
import { isSafeGitRef, parseRepository, parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  STALE_DOMAIN_MESSAGE,
  canTransition,
  holdsApplication,
  isProductionMode,
  applicationHostOf,
  type DeploymentStatus,
  type DomainMode,
} from '@/lib/deploy/status'
import { resolveEntitlement } from '@/platform/entitlements'
import { applyThemeTemplate } from '@/platform/saas-report'
import { emitPlatformEvent } from '@/platform/webhooks'
import { readDeployTargetToken } from '@/collections/hooks/deploySecrets'
import { CoolifyClient, boundedLabel, coolifyAppName, scrubDetail, type DeployTarget } from './coolify'
import { buildEnvironment } from './environment'
import { resolveCommitSha } from './github'
import { requestThemeRoutesRegeneration } from './routing'

/**
 * The deploy service — everything between "an operator picked a theme for a site"
 * and "it is serving".
 *
 * ## Why this runs in the jobs queue and not in a request handler
 *
 * A Coolify build takes minutes. `POST /api/platform/sites/:id/deployment` validates,
 * writes a `queued` row and answers 202; `advanceDeployments` (src/deploy/task.ts)
 * picks the row up and walks it through `advanceDeployment` below. An endpoint that
 * waited would time out behind Caddy, and the operator would be left with a spinner
 * and a half-created application nothing in the CMS knows about.
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
 *
 * ## One application per (site, theme, production|preview)
 *
 * The application name is deterministic (`coolifyAppName`), so a redeploy, a rollback
 * or a retry after a lost create response reuses the application instead of making a
 * second one. Two consequences are handled here rather than left to chance: a reused
 * application is re-pointed at the new commit and hostnames before it is built, and a
 * superseded row that shares the new row's application is marked stopped *without*
 * stopping the application the new row now runs on. Preview deployments get their own
 * application and hostname, so a rehearsal never rebuilds production's container.
 */

export type DeployOutcome = { deploymentId: string; ok: true } | { message: string; ok: false }

/** Truncate and scrub anything on its way to a field an admin will read. */
const logLine = (value: unknown): string => scrubDetail(value, 4000)

const isCommitSha = (value: unknown): value is string => /^[0-9a-f]{40}$/i.test(String(value ?? ''))

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
): Promise<boolean> => {
  const current = await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })

  if (!current) return false

  const from = (current as { status?: unknown }).status

  if (!canTransition(from, status)) {
    req.payload.logger.warn({
      msg: `deployment ${deploymentId}: refused ${String(from)} → ${status}`,
    })
    return false
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
    return true
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
    return false
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
 * The ref a new deployment of `pkg` builds, and the one place that decides it.
 *
 * Precedence: an explicit ref beats the package's pin, which beats its default
 * branch. The pin exists so an operator can freeze a theme at a known-good commit
 * without freezing the *branch* for everyone; an explicit ref is how a rollback
 * asks for an older one, and it has to win or a rollback would silently redeploy
 * the pin it is rolling back from.
 */
export const effectiveRefFor = (pkg: Record<string, unknown>, explicit?: null | string): string =>
  String(explicit || pkg.pinnedCommit || pkg.defaultRef || 'main')

/**
 * The commit a new deployment of `pkg` *without* an explicit ref would build, as far
 * as the CMS knows without asking GitHub: the pin, or what the last successful sync
 * resolved the default ref to. `null` when neither is known (never synced, or the
 * default ref was edited after the last sync).
 */
export const latestPackageCommit = (pkg: Record<string, unknown>): null | string => {
  if (isCommitSha(pkg.pinnedCommit)) return String(pkg.pinnedCommit).toLowerCase()
  if (isCommitSha(pkg.syncedCommitSha)) return String(pkg.syncedCommitSha).toLowerCase()
  return null
}

export type UpdateInfo = {
  deployedCommit: null | string
  latestCommit: null | string
  packageRef: string
  updateAvailable: boolean
}

/**
 * Is there a newer version of the theme a deployment runs?
 *
 * Commit shas on both sides, never branch names: `main` today and `main` last month
 * are the same string and different programs. "Newer" means *different from what the
 * package would deploy now* — the CMS cannot order commits without asking GitHub, and
 * an operator who pinned an older commit on purpose is exactly the case where the
 * running deployment and the package disagree and a redeploy is what reconciles them.
 */
export const updateInfoFor = (
  deployment: Record<string, unknown>,
  pkg: null | Record<string, unknown>,
): UpdateInfo => {
  const deployedCommit = isCommitSha(deployment.commitSha) ? String(deployment.commitSha).toLowerCase() : null
  const latestCommit = pkg ? latestPackageCommit(pkg) : null
  return {
    deployedCommit,
    latestCommit,
    packageRef: pkg ? effectiveRefFor(pkg) : '',
    updateAvailable: Boolean(deployedCommit && latestCommit && deployedCommit !== latestCommit),
  }
}

/**
 * The preview hostname a deployment gets before any customer DNS moves.
 *
 * `<site-domain>-<theme-key>[-<variant>].sites.example.com`. Deterministic, so a
 * redeploy of the same pair reuses it, and so `findApplicationByName` has something
 * stable to reconcile against. An `edge`/`direct` deployment uses the unsuffixed
 * name (it is also Caddy's upstream); a `preview` deployment passes `'preview'` and
 * gets a hostname — and an application — of its own.
 */
export const previewHostname = (
  wildcardDomain: null | string | undefined,
  site: Record<string, unknown>,
  themeKey: string,
  variant?: null | string,
): null | string => {
  const base = String(wildcardDomain ?? '').replace(/^\*\./, '').trim()
  if (!base) return null
  const label = boundedLabel(`${String(site.domain ?? site.id)}-${themeKey}`, 50, variant)
  return label ? `${label}.${base}` : null
}

/** Preview rehearsals get their own Coolify application and hostname; production modes share one. */
const variantFor = (mode: DomainMode): null | string => (mode === 'preview' ? 'preview' : null)

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
 * Every refusal here is a Persian message and a 4xx, *before* a row exists. The
 * refusals that need a row (Coolify said no) are statuses on it. Mixing the two is
 * how a catalogue of half-created deployment rows accumulates from typos.
 */
export const createDeployment = async (
  input: StartDeploymentInput,
): Promise<{ deploymentId: string; ok: true; ref: string } | { message: string; ok: false; status: number }> => {
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

  const effectiveRef = effectiveRefFor(pkg, input.ref)
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
    variantFor(domainMode),
  )

  // Every mode needs the wildcard: `preview` is served on it, `edge` uses it as
  // Caddy's upstream, and `direct` keeps it as the hostname the health check reaches
  // before customer DNS has moved.
  if (!preview) {
    return {
      message: 'سرور استقرار باید «دامنهٔ عام پیش‌نمایش» داشته باشد.',
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

  return { deploymentId: String((created as { id: unknown }).id), ok: true, ref: effectiveRef }
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
 * Move a `queued` row to `creating`, and say whether this caller won it.
 *
 * The queue task and the console's poll button can both reach the same queued row.
 * Two `runDeployment`s on one row would be two Coolify creates; the conditional
 * update narrows that to whoever's update lands first.
 */
const claimQueued = async (req: PayloadRequest, deploymentId: string): Promise<boolean> => {
  const { docs } = await req.payload.update({
    collection: 'site-deployments',
    data: { lastError: null, status: 'creating' },
    depth: 0,
    overrideAccess: true,
    req,
    where: { and: [{ id: { equals: deploymentId } }, { status: { equals: 'queued' } }] },
  })
  return docs.length > 0
}

/**
 * Run one deployment's Coolify side: create or re-point the application, write its
 * environment, start the build. Returns once the build has *started*; the queue
 * follows it from there (`pollDeployment`, `verifyDeployment`).
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

  if (deployment.status !== 'queued') {
    return { message: `استقرار در وضعیت «${String(deployment.status)}» است و اجرا نمی‌شود.`, ok: false }
  }
  if (!(await claimQueued(req, deploymentId))) {
    return { message: 'این استقرار را فرایند دیگری آغاز کرده است.', ok: false }
  }

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

  // Re-checked at run time, not only at create: a site suspended while its deploy sat
  // in the queue must not get a running application a minute later.
  if (site.status !== 'active') return fail(req, deploymentId, 'سایت فعال نیست؛ استقرار انجام نشد.')

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

  const domainMode = String(deployment.domainMode ?? 'preview') as DomainMode
  const previewDomain = deployment.previewDomain ? String(deployment.previewDomain) : null
  const siteDomain = String(site.domain ?? '')

  // The customer's domain is read now, not copied from create time: the row must
  // describe the hostname this build will actually be attached to.
  if (isProductionMode(domainMode) && site.domainVerified !== true) {
    return fail(req, deploymentId, 'دامنهٔ اصلی سایت تأیید نشده است؛ فقط حالت پیش‌نمایش ممکن است.')
  }

  const client = new CoolifyClient(target)
  const themeKey = String(pkg.key ?? 'theme')
  const appName = coolifyAppName(siteDomain || String(site.id), themeKey, variantFor(domainMode))
  const ref = String(deployment.ref ?? effectiveRefFor(pkg))
  // A sha is a commit, not a branch: Coolify clones `git_branch` and then checks out
  // `git_commit_sha`, so a pinned or rolled-back deployment clones the default branch.
  const branch = isCommitSha(ref) ? String(pkg.defaultRef || 'main') : ref
  const commitSha = isCommitSha(ref) ? ref.toLowerCase() : await resolveCommitSha(String(pkg.repository), ref)

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

  // The public origin: what the row is for, and what the theme builds links from.
  const rowDomain = domainMode === 'preview' ? previewDomain! : siteDomain

  // ---------------------------------------------------------------------------
  // 1. The application. Reconcile first: a create whose response was lost must not
  //    produce a second one on retry, and a redeploy reuses its application.
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
      gitBranch: branch,
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

    // Before anything else can fail. An application Coolify holds and the CMS does not
    // know about is the one state nothing here can clean up.
    await req.payload.update({
      collection: 'site-deployments',
      data: { appUuid, commitSha: commitSha ?? null, domain: rowDomain },
      depth: 0,
      id: deploymentId,
      overrideAccess: true,
      req,
    })
  } else {
    // Recorded first for the same reason as above, then re-pointed. Without the
    // patch, an existing application keeps building the commit and hostnames it was
    // created with — a redeploy that silently ships the old version, or a direct-mode
    // redeploy after a domain change that still answers on the old domain.
    await req.payload.update({
      collection: 'site-deployments',
      data: { appUuid, commitSha: commitSha ?? null, domain: rowDomain },
      depth: 0,
      id: deploymentId,
      overrideAccess: true,
      req,
    })

    const repointed = await client.updateApplication(appUuid, {
      domains: domains.join(','),
      git_branch: branch,
      git_commit_sha: commitSha ?? 'HEAD',
    })
    if (!repointed.ok) {
      return fail(req, deploymentId, `به‌روزرسانی اپلیکیشن در Coolify ناموفق بود: ${repointed.message}`, repointed.detail)
    }
  }

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
    serviceDomain: rowDomain,
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
    message: `استقرار پوستهٔ «${String(pkg.name ?? themeKey)}» روی ${rowDomain} آغاز شد.`,
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
 * Why this deployment may not become the site's renderer right now, or `null`.
 *
 * Checked at the moment of promotion, against the site as it is *now*: a site
 * suspended during the build must not come back to life through its theme, and an
 * `edge`/`direct` build made for a hostname the site has since left must not take
 * over — it would be attached to the old hostname while the operator believes the
 * new one is themed.
 */
export const promotionBlocker = (
  deployment: Record<string, unknown>,
  site: null | Record<string, unknown>,
): null | string => {
  if (!site) return 'سایت این استقرار پیدا نشد.'
  if (site.status !== 'active') return 'سایت فعال نیست؛ پوسته فعال نشد.'
  if (!isProductionMode(deployment.domainMode)) return null
  if (String(deployment.domain ?? '') !== String(site.domain ?? '')) return STALE_DOMAIN_MESSAGE
  if (site.domainVerified !== true) return 'دامنهٔ اصلی سایت تأیید نشده است؛ پوسته روی آن فعال نشد.'
  return null
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
  if (deployment.status !== 'verifying') {
    return { message: `استقرار در وضعیت «${String(deployment.status)}» است، نه «در حال بررسی سلامت».`, ok: false }
  }

  const site = (await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: String(idOf(deployment.site)),
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  const blocker = promotionBlocker(deployment, site)
  if (blocker) {
    await setDeploymentStatus(req, deploymentId, 'failed', { lastError: blocker })
    return { message: blocker, ok: false }
  }

  // The application itself, never the customer's domain (see `applicationHostOf`).
  const host = applicationHostOf(deployment)
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
 * Make this deployment the site's renderer, and retire whatever it replaces.
 *
 * Order matters and is the opposite of intuition: the new row is marked `live`
 * *first*, then the old ones are stopped. Stopping first would leave a window in
 * which the site has no live deployment and `renderedBy` points at nothing.
 *
 * What it replaces depends on the mode. A production (`edge`/`direct`) deployment
 * replaces every other row of the site. A `preview` deployment replaces only other
 * previews: a rehearsal succeeding must never stop the deployment serving the
 * customer's domain, and never moves `renderedBy`.
 */
export const promoteDeployment = async (
  req: PayloadRequest,
  deployment: Record<string, unknown>,
): Promise<void> => {
  const deploymentId = String(deployment.id)
  const siteId = String(idOf(deployment.site))
  const mode = String(deployment.domainMode ?? 'preview')
  const appUuid = deployment.appUuid ? String(deployment.appUuid) : ''

  const promoted = await setDeploymentStatus(req, deploymentId, 'live', {
    deployedAt: new Date().toISOString(),
    healthCheckedAt: new Date().toISOString(),
    lastError: null,
  })
  if (!promoted) return

  try {
    const { recordDeploymentUsage } = await import('@/billing/usage/deployment-record')
    await recordDeploymentUsage(req, {
      commitSha: typeof deployment.commitSha === 'string' ? deployment.commitSha : null,
      deploymentId,
      mode,
      siteId,
    })
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: `deployment ${deploymentId}: usage measurement failed` })
  }

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
        ...(isProductionMode(mode) ? [] : [{ domainMode: { equals: 'preview' } }]),
      ],
    },
  })

  for (const row of previous as unknown as Record<string, unknown>[]) {
    await stopDeployment(req, String(row.id), 'جایگزین شد با استقرار تازه.', {
      // Same application: the new row is running on it now.
      stopApplication: !appUuid || String(row.appUuid ?? '') !== appUuid,
    })
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

  if (isProductionMode(mode)) {
    // The tokens the theme renders with. A copy, exactly as `applyThemeTemplate`
    // documents — a live link would repaint twenty customers when an operator tweaks a
    // preset. Only for production: a preview must not repaint the live site.
    const templateId = idOf(pkg?.themeTemplate)
    if (templateId && site) {
      await applyThemeTemplate(req, site, templateId)
    }

    await req.payload.update({
      collection: 'sites',
      data: { activeDeployment: deploymentId, renderedBy: 'deployment' },
      depth: 0,
      id: siteId,
      overrideAccess: true,
      req,
    })
  }

  if (mode === 'edge') requestThemeRoutesRegeneration(req, `deployment ${deploymentId} live (edge)`)

  await emitPlatformEvent(req, {
    data: { deployment: deploymentId, domainMode: mode },
    event: 'deployment.live',
    message: `پوسته روی ${String(deployment.domain ?? '')} در حال سرویس‌دهی است.`,
    site: site ?? siteId,
    targetCollection: 'site-deployments',
    targetId: deploymentId,
  })
}

export type StopOutcome = { applicationStopped: boolean; message: string; ok: boolean }

/**
 * Stop an application without deleting it.
 *
 * The same reasoning as "do not delete a site": Coolify keeps the application, its
 * volumes and its build history, and starting it again is one call. Deleting throws
 * away the only copy of what was running when something broke.
 *
 * Idempotent. Stopping a row that is already `stopped` asks Coolify to stop the
 * application again (the one step that can fail on a flaky network, so repeating it
 * is how an operator retries) but does not re-revoke, re-emit or touch the site.
 *
 * A Coolify failure does not make the row lie: it is still marked `stopped` — its key
 * is revoked and routing drops it either way — and the failure is written onto the
 * row so the operator knows the container may still be running.
 */
export const stopDeployment = async (
  req: PayloadRequest,
  deploymentId: string,
  reason: string,
  options: { stopApplication?: boolean } = {},
): Promise<StopOutcome> => {
  const deployment = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!deployment) return { applicationStopped: false, message: 'استقرار پیدا نشد.', ok: false }

  const status = String(deployment.status ?? '')
  if (status === 'removed') {
    return { applicationStopped: false, message: 'اپلیکیشن این استقرار حذف شده است.', ok: true }
  }

  // `failed` keeps its status and its reason — `failed → stopped` is not a legal move
  // — but a row that failed its health check can still have a container running on
  // its preview hostname, so the application is stopped all the same.
  const alreadyStopped = status === 'stopped' || status === 'failed'
  let applicationStopped = false
  let stopProblem: null | string = null

  if (options.stopApplication !== false && holdsApplication(status) && deployment.appUuid) {
    const target = await loadTarget(req, String(idOf(deployment.target)))
    if (!target) {
      stopProblem = 'سرور استقرار در دسترس نیست؛ اپلیکیشن در Coolify متوقف نشد.'
    } else {
      const result = await new CoolifyClient(target).stop(String(deployment.appUuid))
      if (result.ok) applicationStopped = true
      else stopProblem = `توقف اپلیکیشن در Coolify ناموفق بود: ${result.message}`
    }
    if (stopProblem) {
      req.payload.logger.error({
        msg: `deployment ${deploymentId}: ${stopProblem} — the container may still be serving; retry the stop.`,
      })
    }
  }

  const lastError = logLine(stopProblem ? `${reason} — ${stopProblem}` : reason)

  if (alreadyStopped) {
    if (status === 'stopped' && (stopProblem || applicationStopped)) {
      await req.payload.update({
        collection: 'site-deployments',
        data: { lastError },
        depth: 0,
        id: deploymentId,
        overrideAccess: true,
        req,
      })
    }
    return {
      applicationStopped,
      message: stopProblem ?? 'استقرار از قبل متوقف بود.',
      ok: true,
    }
  }

  await setDeploymentStatus(req, deploymentId, 'stopped', { lastError })
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

  if (status === 'live' && deployment.domainMode === 'edge') {
    requestThemeRoutesRegeneration(req, `deployment ${deploymentId} stopped (edge)`)
  }

  await emitPlatformEvent(req, {
    data: { deployment: deploymentId, reason },
    event: 'deployment.stopped',
    message: `استقرار روی ${String(deployment.domain ?? '')} متوقف شد: ${reason}`,
    site: site ?? siteId,
    targetCollection: 'site-deployments',
    targetId: deploymentId,
  })

  return {
    applicationStopped,
    message: stopProblem ?? 'استقرار متوقف شد.',
    ok: true,
  }
}

/**
 * Stop every deployment of a site that holds, or is about to hold, a running
 * application — what suspension, archival and "revert to the built-in renderer" do.
 *
 * Each row is stopped independently: one Coolify call failing must not leave the
 * site's other applications running, and must not fail the caller. Nothing is
 * deleted and nothing is restarted later; resuming a site restores its eligibility
 * to be deployed, not its old containers.
 */
export const stopSiteDeployments = async (
  req: PayloadRequest,
  siteId: string,
  reason: string,
): Promise<{ failed: string[]; stopped: string[] }> => {
  const { docs } = await req.payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        {
          or: [
            { status: { in: [...ACTIVE_DEPLOYMENT_STATUSES] } },
            { and: [{ status: { equals: 'failed' } }, { appUuid: { exists: true } }] },
          ],
        },
      ],
    },
  })

  const stopped: string[] = []
  const failed: string[] = []
  const stoppedApps = new Set<string>()

  for (const row of docs as unknown as Record<string, unknown>[]) {
    const id = String(row.id)
    const appUuid = row.appUuid ? String(row.appUuid) : ''
    try {
      const outcome = await stopDeployment(req, id, reason, {
        stopApplication: !appUuid || !stoppedApps.has(appUuid),
      })
      if (appUuid && outcome.applicationStopped) stoppedApps.add(appUuid)
      ;(outcome.ok ? stopped : failed).push(id)
    } catch (error) {
      failed.push(id)
      req.payload.logger.error({ err: error as Error, msg: `deployment ${id}: stop failed (${reason})` })
    }
  }

  return { failed, stopped }
}

/**
 * Take one in-flight deployment one step further — the unit of work the queue task
 * and the console's «بررسی وضعیت» button share.
 *
 * `queued` runs the Coolify side, `creating`/`building` asks Coolify how the build is
 * going, and `verifying` health-checks and promotes. A build that just finished is
 * verified in the same call: the gap between "built" and "serving" is the part a
 * watching operator experiences as the feature being slow.
 */
export const advanceDeployment = async (
  req: PayloadRequest,
  deploymentId: string,
): Promise<{ changed: boolean; message?: string; status: string }> => {
  const row = (await req.payload.findByID({
    collection: 'site-deployments',
    depth: 0,
    disableErrors: true,
    id: deploymentId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  if (!row) return { changed: false, status: 'missing' }

  const status = String(row.status ?? '')

  const statusNow = async (): Promise<string> => {
    const after = await req.payload.findByID({
      collection: 'site-deployments',
      depth: 0,
      disableErrors: true,
      id: deploymentId,
      overrideAccess: true,
      req,
    })
    return String((after as null | { status?: unknown })?.status ?? 'missing')
  }

  if (status === 'queued') {
    const outcome = await runDeployment(req, deploymentId)
    const now = await statusNow()
    return { changed: now !== status, message: outcome.ok ? undefined : outcome.message, status: now }
  }

  if (status === 'verifying') {
    const verified = await verifyDeployment(req, deploymentId)
    const now = await statusNow()
    return { changed: now !== status, message: verified.message, status: now }
  }

  const polled = await pollDeployment(req, deploymentId)
  if (polled.status === 'verifying') {
    const verified = await verifyDeployment(req, deploymentId)
    return { changed: true, message: verified.message, status: await statusNow() }
  }
  return polled
}
