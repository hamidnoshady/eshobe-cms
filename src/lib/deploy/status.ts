/**
 * The deployment lifecycle, as a machine rather than a set of string writes.
 *
 * `site-deployments.status` is the field the admin renders, the API reports and the
 * operator makes decisions from. Two writers and no rules is how it becomes a field
 * nobody trusts — a row that says `live` because a retry overwrote a `failed`, or a
 * `building` that never resolves because the job crashed between two updates.
 *
 * Framework-free so the transition table can be asserted without a database.
 */

export const DEPLOYMENT_STATUSES = [
  /** The row exists; the job has not started. The only state a create can produce. */
  'queued',
  /** Talking to Coolify: creating the application, writing env. */
  'creating',
  /** Coolify is building the image. */
  'building',
  /** Built; waiting for the health check to answer on the preview or the domain. */
  'verifying',
  /** Serving. At most one per site. */
  'live',
  /** The job refused, or Coolify did. `lastError` says why, in Persian. */
  'failed',
  /** Deliberately stopped — a suspended site, or superseded by a newer deployment. */
  'stopped',
  /** The Coolify application is gone. Terminal; the row survives as history. */
  'removed',
] as const

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  building: 'در حال ساخت',
  creating: 'در حال ایجاد',
  failed: 'ناموفق',
  live: 'در حال سرویس‌دهی',
  queued: 'در صف',
  removed: 'حذف‌شده',
  stopped: 'متوقف',
  verifying: 'در حال بررسی سلامت',
}

/**
 * Which moves are legal.
 *
 * Two properties worth stating because they are the ones a future edit will break:
 *
 * - **`removed` is terminal.** Once the Coolify application is deleted there is
 *   nothing to start; a row that could leave `removed` would be a row claiming to
 *   run an application that does not exist. A new deploy is a new row.
 * - **`failed` can go back to `queued`.** That is a *retry*, and it is the only way
 *   back in. It deliberately cannot jump straight to `live` — a retry re-runs the
 *   whole job, including the refusals at the top of it.
 */
const TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  building: ['verifying', 'failed', 'stopped'],
  creating: ['building', 'verifying', 'failed', 'stopped'],
  failed: ['queued', 'removed'],
  live: ['stopped', 'failed', 'queued', 'removed'],
  queued: ['creating', 'failed', 'stopped'],
  removed: [],
  stopped: ['queued', 'creating', 'live', 'removed'],
  verifying: ['live', 'failed', 'stopped'],
}

export const isDeploymentStatus = (value: unknown): value is DeploymentStatus =>
  typeof value === 'string' && (DEPLOYMENT_STATUSES as readonly string[]).includes(value)

export const canTransition = (from: unknown, to: DeploymentStatus): boolean => {
  if (!isDeploymentStatus(from)) return to === 'queued'
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/** The states in which a deployment is the one answering for its site. */
export const isServing = (status: unknown): boolean => status === 'live'

/** The states from which work is still expected — what a poller keeps watching. */
export const isPending = (status: unknown): boolean =>
  status === 'queued' || status === 'creating' || status === 'building' || status === 'verifying'

/** The states holding a Coolify application that still exists and costs money. */
export const holdsApplication = (status: unknown): boolean =>
  isDeploymentStatus(status) && status !== 'removed' && status !== 'queued'

/**
 * How a site's traffic is served.
 *
 * `platform` — this Next app renders it, the behaviour every existing site has.
 * `deployment` — a theme application does, with Caddy in front (docs/theme-deployments.md §5).
 *
 * This lives on `sites` because `/api/domain-check` and the alias-redirect logic both
 * need it: a site whose traffic no longer arrives at Caddy must not sit waiting to
 * issue a certificate nobody will request.
 */
export const RENDERED_BY = ['platform', 'deployment'] as const
export type RenderedBy = (typeof RENDERED_BY)[number]

/**
 * Where a deployment's traffic is addressed from — the decision §5 of the design doc
 * makes explicit, recorded per deployment because it is switched on one site at a time.
 *
 * `preview`   — only the target's wildcard hostname. No customer DNS involved at all.
 * `edge`      — Caddy stays the edge and proxies non-API paths to the app (recommended).
 * `direct`    — the customer's DNS points at Coolify; the theme must proxy `/api/*` back.
 */
export const DOMAIN_MODES = ['preview', 'edge', 'direct'] as const
export type DomainMode = (typeof DOMAIN_MODES)[number]

export const DOMAIN_MODE_LABELS: Record<DomainMode, string> = {
  direct: 'دامنه مستقیم روی Coolify',
  edge: 'دامنه روی Caddy، پراکسی به پوسته',
  preview: 'فقط زیردامنهٔ پیش‌نمایش',
}

/** The modes in which a deployment answers for the customer's own domain. */
export const isProductionMode = (mode: unknown): boolean => mode === 'edge' || mode === 'direct'

/**
 * The states a site lifecycle change has to stop: everything that holds, or is about
 * to hold, a running application. `queued` is included so a suspended site cannot
 * have a deploy start behind its back a minute later.
 */
export const ACTIVE_DEPLOYMENT_STATUSES = ['queued', 'creating', 'building', 'verifying', 'live'] as const

/**
 * The hostname the theme application itself answers on — what a health check, a
 * revalidation notice and the Caddy upstream address.
 *
 * `domain` is the hostname the deployment is *for*: the preview name in `preview`
 * mode, the customer's domain in `edge` and `direct`. In `edge` mode those differ —
 * Caddy holds the customer's domain and the application only has its preview name
 * in Coolify — so reaching the application means using `previewDomain`.
 */
export const serviceHostOf = (deployment: {
  domain?: unknown
  domainMode?: unknown
  previewDomain?: unknown
}): string => {
  const domain = String(deployment.domain ?? '')
  const preview = String(deployment.previewDomain ?? '')
  if (deployment.domainMode === 'edge') return preview || domain
  return domain || preview
}

export const STALE_DOMAIN_MESSAGE =
  'دامنهٔ اصلی سایت پس از این استقرار تغییر کرده است. برای فعال‌شدن پوسته روی دامنهٔ جدید، استقرار مجدد انجام دهید.'

/**
 * A live `edge`/`direct` deployment built for a hostname the site no longer uses.
 *
 * Derived, never stored: the routing table already drops such a row (so the new
 * domain falls through to the built-in renderer), and a stored flag would be one
 * more thing a domain write could forget to set. The row itself ran fine — this is
 * not a failure, it is a redeploy the operator owes the site.
 */
export const needsRedeploy = (
  deployment: { domain?: unknown; domainMode?: unknown; status?: unknown },
  site: { domain?: unknown },
): boolean =>
  deployment.status === 'live' &&
  isProductionMode(deployment.domainMode) &&
  String(deployment.domain ?? '') !== String(site.domain ?? '')
