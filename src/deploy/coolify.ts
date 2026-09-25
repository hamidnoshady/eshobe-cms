import { isSafeGitRef, type BuildPack } from '@/lib/deploy/manifest'

/**
 * The Coolify REST client — the only place in this codebase that knows Coolify's
 * wire shape.
 *
 * Everything above it speaks `DeployTarget` + `CreateApplicationInput` and gets back
 * `CoolifyResult`; everything below is HTTP. That boundary is why `deploy-targets`
 * carries a `provider` enum with one value in it today: a second provider is a second
 * module implementing this interface, not a rewrite of the job.
 *
 * ## Three properties this file is responsible for
 *
 * 1. **A failure is a value, never a throw.** Every method answers
 *    `{ ok: false, status, message, detail }`. The deploy job writes that onto the
 *    deployment row and stops; an exception escaping into the jobs queue would retry
 *    an application-create and leave a second orphaned app behind.
 * 2. **Nothing it returns is safe to show a tenant verbatim.** Coolify echoes request
 *    bodies in validation errors, and a request body here contains a freshly minted
 *    site API key. `scrubDetail` runs on every error string before it leaves.
 * 3. **The token never appears in a message, a log line or a thrown stack.** It is
 *    read once per call, used in one header, and not interpolated anywhere else.
 */

const DEFAULT_TIMEOUT_MS = 20_000

export type DeployTarget = {
  apiToken: string
  baseUrl: string
  environmentName: string
  githubAppUuid: null | string
  gitSource: 'deployKey' | 'githubApp' | 'public'
  id: string
  name: string
  privateKeyUuid: null | string
  projectUuid: string
  serverUuid: string
}

export type CoolifyResult<T> =
  | { data: T; ok: true }
  | { detail?: null | string; message: string; ok: false; status: number }

export type CreateApplicationInput = {
  baseDirectory: string
  buildCommand: null | string
  buildPack: BuildPack
  /** Every hostname this app should answer on, as origins. Coolify wants them comma-joined. */
  domains: string[]
  dockerfileLocation: null | string
  gitBranch: string
  gitCommitSha: null | string
  /** `https://github.com/owner/name` for public, `owner/name` for a GitHub App source. */
  gitRepository: string
  healthCheckPath: null | string
  installCommand: null | string
  isStatic: boolean
  name: string
  port: number
  publishDirectory: null | string
  startCommand: null | string
}

export type DeploymentStatus = {
  raw: string
  status: 'building' | 'failed' | 'queued' | 'succeeded' | 'unknown'
}

/**
 * Coolify error bodies echo the request. The request contained `ESHOBE_API_KEY`, and
 * this string is on its way to an admin screen and an audit row.
 */
const SECRET_PATTERNS: RegExp[] = [
  /eshobe_live_[A-Za-z0-9]+/g,
  /esrv_[A-Za-z0-9]+/g,
  /\bBearer\s+\S+/gi,
  /"?(?:api[_-]?token|password|secret|authorization)"?\s*[:=]\s*"?[^\s",}]+/gi,
]

export const scrubDetail = (value: unknown, max = 2000): string => {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]')
  return text.slice(0, max)
}

/**
 * `https://coolify.example.com` → a validated origin.
 *
 * `http` is rejected outside localhost: this request carries a token that can start
 * and stop every customer's storefront, and sending it in clear over a network is
 * not a configuration choice anybody should be able to make by typing one character.
 */
export const normalizeBaseUrl = (value: unknown): null | string => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * A lowercase, hyphenated label of at most `max` characters, with `suffix` kept
 * intact at the end. Truncating *after* appending would let a long domain cut the
 * suffix off and collide with the unsuffixed name.
 */
export const boundedLabel = (base: string, max: number, suffix?: null | string): string => {
  const tail = suffix ? `-${suffix}` : ''
  const head = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max - tail.length)
    .replace(/-+$/g, '')
  return head ? `${head}${tail}` : ''
}

/**
 * Coolify's application name: lowercase, hyphenated, bounded. It ends up in a
 * container name.
 *
 * `variant` separates a preview rehearsal from production: `preview` deployments get
 * their own application, so previewing a new version of the theme a site is already
 * serving in `edge`/`direct` mode never rebuilds the container production runs on.
 */
export const coolifyAppName = (domain: string, themeKey: string, variant?: null | string): string =>
  boundedLabel(`${domain}-${themeKey}`, 60, variant) || 'eshobe-site'

const statusFromRaw = (raw: string): DeploymentStatus['status'] => {
  const value = raw.toLowerCase()
  if (value.includes('queue')) return 'queued'
  if (value.includes('progress') || value.includes('running') || value.includes('build')) {
    return 'building'
  }
  if (value.includes('finished') || value.includes('success')) return 'succeeded'
  if (value.includes('fail') || value.includes('error') || value.includes('cancel')) return 'failed'
  return 'unknown'
}

export class CoolifyClient {
  private readonly target: DeployTarget
  private readonly timeoutMs: number

  constructor(target: DeployTarget, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.target = target
    this.timeoutMs = timeoutMs
  }

  private async call<T>(
    method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<CoolifyResult<T>> {
    const base = normalizeBaseUrl(this.target.baseUrl)
    if (!base) {
      return { message: 'نشانی Coolify نامعتبر است؛ باید https باشد.', ok: false, status: 0 }
    }
    if (!this.target.apiToken) {
      return { message: 'توکن Coolify خوانا نیست. آن را دوباره وارد کنید.', ok: false, status: 0 }
    }

    let response: Response
    try {
      response = await fetch(`${base}/api/v1${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.target.apiToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      // A timeout on a *create* is the dangerous one: Coolify may have made the app.
      // The caller reconciles by name before retrying; see `findApplicationByName`.
      return {
        detail: scrubDetail((error as Error)?.message ?? ''),
        message: 'اتصال به Coolify برقرار نشد.',
        ok: false,
        status: 0,
      }
    }

    const text = await response.text().catch(() => '')
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }

    if (!response.ok) {
      const messageFromBody =
        parsed && typeof parsed === 'object' && 'message' in (parsed as Record<string, unknown>)
          ? String((parsed as Record<string, unknown>).message)
          : ''
      return {
        detail: scrubDetail(parsed ?? text),
        message:
          response.status === 401 || response.status === 403
            ? 'توکن Coolify پذیرفته نشد.'
            : scrubDetail(messageFromBody, 300) || `Coolify پاسخ ${response.status} داد.`,
        ok: false,
        status: response.status,
      }
    }

    return { data: (parsed ?? {}) as T, ok: true }
  }

  /**
   * The self-test: can this token reach this Coolify, and does the named server exist?
   *
   * `GET /servers` rather than a version probe, because the credential being *valid*
   * is only half the question — a token scoped to another team authenticates fine and
   * then cannot see the server the operator typed, which is the mistake this catches
   * at configuration time instead of at a customer's first deploy.
   */
  async selfTest(): Promise<CoolifyResult<{ serverFound: boolean; servers: number }>> {
    const result = await this.call<unknown[]>('GET', '/servers')
    if (!result.ok) return result

    const servers = Array.isArray(result.data) ? result.data : []
    const serverFound = servers.some(
      (row) => String((row as Record<string, unknown>)?.uuid ?? '') === this.target.serverUuid,
    )

    return { data: { serverFound, servers: servers.length }, ok: true }
  }

  /**
   * Create the application. Which endpoint depends on how the repo is reached —
   * the one genuine branch in this client.
   */
  async createApplication(input: CreateApplicationInput): Promise<CoolifyResult<{ uuid: string }>> {
    if (!isSafeGitRef(input.gitBranch)) {
      return { message: 'شاخهٔ گیت نامعتبر است.', ok: false, status: 0 }
    }

    const common: Record<string, unknown> = {
      base_directory: input.baseDirectory,
      build_pack: input.buildPack,
      description: 'ساخته‌شده توسط Eshobe CMS — دستی تغییر ندهید.',
      destination_uuid: undefined,
      domains: input.domains.join(','),
      environment_name: this.target.environmentName,
      git_branch: input.gitBranch,
      git_repository: input.gitRepository,
      instant_deploy: false,
      // Off, deliberately. A theme author pushing to `main` must not redeploy twenty
      // customers' storefronts at once; an upgrade is a per-site decision. See
      // docs/theme-deployments.md §7.
      is_auto_deploy_enabled: false,
      is_force_https_enabled: true,
      is_static: input.isStatic,
      name: input.name,
      ports_exposes: String(input.port),
      project_uuid: this.target.projectUuid,
      server_uuid: this.target.serverUuid,
    }

    if (input.gitCommitSha) common.git_commit_sha = input.gitCommitSha
    if (input.installCommand) common.install_command = input.installCommand
    if (input.buildCommand) common.build_command = input.buildCommand
    if (input.startCommand) common.start_command = input.startCommand
    if (input.publishDirectory) common.publish_directory = input.publishDirectory
    if (input.dockerfileLocation) common.dockerfile_location = input.dockerfileLocation
    if (input.healthCheckPath) {
      common.health_check_enabled = true
      common.health_check_path = input.healthCheckPath
      common.health_check_port = String(input.port)
    }

    if (this.target.gitSource === 'githubApp') {
      if (!this.target.githubAppUuid) {
        return { message: 'شناسهٔ GitHub App روی این سرور تنظیم نشده است.', ok: false, status: 0 }
      }
      return this.call<{ uuid: string }>('POST', '/applications/private-github-app', {
        ...common,
        github_app_uuid: this.target.githubAppUuid,
      })
    }

    if (this.target.gitSource === 'deployKey') {
      if (!this.target.privateKeyUuid) {
        return { message: 'کلید خصوصی روی این سرور تنظیم نشده است.', ok: false, status: 0 }
      }
      return this.call<{ uuid: string }>('POST', '/applications/private-deploy-key', {
        ...common,
        private_key_uuid: this.target.privateKeyUuid,
      })
    }

    return this.call<{ uuid: string }>('POST', '/applications/public', common)
  }

  /**
   * Reconciliation for the one unrecoverable case: a create whose response was lost.
   *
   * Without this, a timed-out create followed by a retry makes two applications for
   * one site and the CMS knows about neither. The app name is deterministic
   * (`coolifyAppName`), which is what makes the lookup possible at all.
   */
  async findApplicationByName(name: string): Promise<CoolifyResult<null | { uuid: string }>> {
    const result = await this.call<unknown[]>('GET', '/applications')
    if (!result.ok) return result

    const rows = Array.isArray(result.data) ? result.data : []
    const match = rows.find((row) => String((row as Record<string, unknown>)?.name ?? '') === name)

    return { data: match ? { uuid: String((match as Record<string, unknown>).uuid) } : null, ok: true }
  }

  async setEnvironment(
    appUuid: string,
    variables: { isBuildTime?: boolean; key: string; value: string }[],
  ): Promise<CoolifyResult<unknown>> {
    if (!variables.length) return { data: {}, ok: true }
    return this.call('PATCH', `/applications/${appUuid}/envs/bulk`, {
      data: variables.map((variable) => ({
        is_build_time: variable.isBuildTime ?? true,
        is_literal: true,
        is_preview: false,
        key: variable.key,
        value: variable.value,
      })),
    })
  }

  async updateApplication(
    appUuid: string,
    patch: Record<string, unknown>,
  ): Promise<CoolifyResult<unknown>> {
    return this.call('PATCH', `/applications/${appUuid}`, patch)
  }

  async deploy(appUuid: string): Promise<CoolifyResult<{ deploymentUuid: null | string }>> {
    const result = await this.call<Record<string, unknown>>(
      'GET',
      `/deploy?uuid=${encodeURIComponent(appUuid)}`,
    )
    if (!result.ok) return result

    // Coolify answers `{ deployments: [{ deployment_uuid }] }`; older builds answer a
    // bare object. Read both rather than depend on the shape of one release.
    const deployments = (result.data as { deployments?: unknown[] })?.deployments
    const first = Array.isArray(deployments) ? (deployments[0] as Record<string, unknown>) : null
    const uuid =
      (first?.deployment_uuid as string | undefined) ??
      ((result.data as Record<string, unknown>)?.deployment_uuid as string | undefined) ??
      null

    return { data: { deploymentUuid: uuid ? String(uuid) : null }, ok: true }
  }

  async deploymentStatus(deploymentUuid: string): Promise<CoolifyResult<DeploymentStatus>> {
    const result = await this.call<Record<string, unknown>>('GET', `/deployments/${deploymentUuid}`)
    if (!result.ok) return result
    const raw = String(result.data?.status ?? 'unknown')
    return { data: { raw, status: statusFromRaw(raw) }, ok: true }
  }

  async stop(appUuid: string): Promise<CoolifyResult<unknown>> {
    return this.call('GET', `/applications/${appUuid}/stop`)
  }

  async start(appUuid: string): Promise<CoolifyResult<unknown>> {
    return this.call('GET', `/applications/${appUuid}/start`)
  }

  async remove(appUuid: string): Promise<CoolifyResult<unknown>> {
    return this.call('DELETE', `/applications/${appUuid}`)
  }
}
