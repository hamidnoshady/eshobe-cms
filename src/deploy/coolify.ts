import { isSafeGitRef, type BuildPack } from '@/lib/deploy/manifest'
import type { DeploymentLane } from '@/lib/deploy/lane'

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
  previewProjectUuid: null | string
  privateKeyUuid: null | string
  productionProjectUuid: null | string
  projectUuid: string
  serverUuid: string
  publicGitEnabled?: boolean
  githubAppEnabled?: boolean
  deployKeyEnabled?: boolean
  publicRegistryPullEnabled?: boolean
  ghcrEnabled?: boolean
  ghcrCredentialUuid?: null | string
  previewServerUuid?: null | string
  productionServerUuid?: null | string
  previewEnvironmentName?: null | string
  productionEnvironmentName?: null | string
}

export type ProjectUuidSource = {
  previewProjectUuid?: unknown
  productionProjectUuid?: unknown
  projectUuid?: unknown
}

export const projectUuidForLane = (target: ProjectUuidSource, lane: DeploymentLane): string => {
  if (lane === 'preview') {
    const preview = String(target.previewProjectUuid ?? '').trim()
    if (preview) return preview
  } else {
    const production = String(target.productionProjectUuid ?? '').trim()
    if (production) return production
  }
  return String(target.projectUuid ?? '').trim()
}

export const targetPinnedToBinding = (
  base: DeployTarget,
  binding: Record<string, unknown>,
): DeployTarget => ({
  ...base,
  environmentName: String(binding.environmentName ?? base.environmentName),
  projectUuid: String(binding.coolifyProjectUuid ?? base.projectUuid),
  serverUuid: String(binding.serverUuid ?? base.serverUuid),
})

export type ApplicationLookup = {
  name: string
  projectUuid: string
  serverUuid: string
}

const applicationProjectOf = (row: Record<string, unknown>): string =>
  String(
    row.project_uuid ??
      row.projectUuid ??
      (row.project as Record<string, unknown> | undefined)?.uuid ??
      '',
  )

const applicationServerOf = (row: Record<string, unknown>): string =>
  String(
    row.destination_uuid ??
      row.destinationUuid ??
      row.server_uuid ??
      row.serverUuid ??
      (row.destination as Record<string, unknown> | undefined)?.uuid ??
      '',
  )

export type CoolifyResult<T> =
  { data: T; ok: true } | { detail?: null | string; message: string; ok: false; status: number }

export type ApplicationSource =
  | {
      type: 'git'
      repository: string
      branch: string
      commitSha: null | string
      buildPack: BuildPack
      access: 'public' | 'github-app' | 'deploy-key'
      githubAppUuid?: string
      privateKeyUuid?: string
      baseDirectory: string
      buildCommand: null | string
      dockerfileLocation: null | string
      installCommand: null | string
      isStatic: boolean
      publishDirectory: null | string
      startCommand: null | string
    }
  | {
      type: 'registry-image'
      image: string
      digest: string
      registryCredentialUuid?: string
    }

export type CreateApplicationInput = {
  source: ApplicationSource
  domains: string[]
  healthCheckPath: null | string
  name: string
  port: number
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
  /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/g,
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

/**
 * The host Coolify's container health check curls, from inside the container.
 *
 * Coolify's default is `localhost`, which an IPv6-first image resolves to `::1`;
 * a server bound to IPv4 only (or to `0.0.0.0` behind some base images) then
 * refuses the connection, Docker marks the container unhealthy and Traefik answers
 * the public hostname with «no available server» until a human rewrites the check
 * by hand. `127.0.0.1` names IPv4 explicitly and is what the srv1 workaround
 * ended up being, so it is pinned here for every application this platform creates
 * or re-points. The *path* stays the theme's own (`build.healthCheckPath`).
 */
export const HEALTH_CHECK_HOST = '127.0.0.1'

/** Coolify's `fqdn` column: `https://a.example,https://b.example` → its entries. */
export const domainListOf = (fqdn: unknown): string[] =>
  String(fqdn ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

/** `https://Shop.Example.ir:443/path` → `shop.example.ir`. */
export const hostOfDomain = (domain: string): string =>
  domain
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/:].*$/, '')
    .toLowerCase()

/**
 * How an immutable digest pin travels to Coolify — one pin, two wire shapes.
 *
 * **Create** (`POST /applications/dockerimage`) wants a full reference in
 * `docker_registry_image_name` — `ghcr.io/owner/repo@sha256:<64 hex>` — validates
 * it with Coolify's `DockerImageFormat` rule and normalizes the pair itself.
 *
 * **Patch** (`PATCH /applications/{uuid}`) is stricter and narrower than its own
 * OpenAPI schema claims: its allowlist rejects `project_uuid`, `server_uuid`,
 * `environment_name` and `docker_registry_uuid` («This field is not allowed»), and
 * `docker_registry_image_name` must be a bare repository — with at most the literal
 * `@sha256` marker Coolify itself appends to digest-pinned rows, the hash itself
 * travelling separately in `docker_registry_image_tag`. That stored shape —
 * `ghcr.io/owner/repo@sha256` + the bare hex — is what a successful create leaves
 * behind, so it is what a re-point sends back.
 */
export const digestReferenceForCreate = (image: string, digest: string): string =>
  `${image}@${digest}`

export const digestPinForPatch = (
  image: string,
  digest: string,
): { name: string; tag: string } => ({
  name: `${image}@sha256`,
  tag: digest.trim().toLowerCase().replace(/^sha256:/, ''),
})

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
  async selfTest(): Promise<
    CoolifyResult<{
      applicationsListed: boolean
      previewProjectFound: boolean
      productionProjectFound: boolean
      projectsDistinct: boolean
      projectsListed: boolean
      serverFound: boolean
      previewServerFound: boolean
      productionServerFound: boolean
      servers: number
    }>
  > {
    const result = await this.call<unknown[]>('GET', '/servers')
    if (!result.ok) return result

    const servers = Array.isArray(result.data) ? result.data : []
    const serverIds = new Set(
      servers.map((row) => String((row as Record<string, unknown>)?.uuid ?? '')),
    )
    const serverFound = serverIds.has(this.target.serverUuid)
    const previewServerFound = serverIds.has(
      this.target.previewServerUuid || this.target.serverUuid,
    )
    const productionServerFound = serverIds.has(
      this.target.productionServerUuid || this.target.serverUuid,
    )

    const previewUuid = projectUuidForLane(this.target, 'preview')
    const productionUuid = projectUuidForLane(this.target, 'production')

    let projectsListed = false
    let previewProjectFound = false
    let productionProjectFound = false

    const projectsResult = await this.call<unknown[]>('GET', '/projects')
    if (projectsResult.ok) {
      projectsListed = true
      const projects = Array.isArray(projectsResult.data) ? projectsResult.data : []
      const ids = new Set(
        projects.map((row) => String((row as Record<string, unknown>)?.uuid ?? '')),
      )
      previewProjectFound = Boolean(previewUuid && ids.has(previewUuid))
      productionProjectFound = Boolean(productionUuid && ids.has(productionUuid))
    }

    const appsResult = await this.call<unknown[]>('GET', '/applications')
    const applicationsListed = appsResult.ok

    return {
      data: {
        applicationsListed,
        previewProjectFound,
        productionProjectFound,
        projectsDistinct: Boolean(previewUuid && productionUuid && previewUuid !== productionUuid),
        projectsListed,
        serverFound,
        previewServerFound,
        productionServerFound,
        servers: servers.length,
      },
      ok: true,
    }
  }

  /**
   * Create the application. Which endpoint depends on how the repo is reached —
   * the one genuine branch in this client.
   */
  async createApplication(input: CreateApplicationInput): Promise<CoolifyResult<{ uuid: string }>> {
    const common: Record<string, unknown> = {
      description: 'ساخته‌شده توسط Eshobe CMS — دستی تغییر ندهید.',
      domains: input.domains.join(','),
      environment_name: this.target.environmentName,
      instant_deploy: false,
      is_auto_deploy_enabled: false,
      is_force_https_enabled: true,
      name: input.name,
      ports_exposes: String(input.port),
      project_uuid: this.target.projectUuid,
      server_uuid: this.target.serverUuid,
    }
    if (input.healthCheckPath) {
      common.health_check_enabled = true
      common.health_check_path = input.healthCheckPath
      common.health_check_port = String(input.port)
      // `localhost` resolves to `::1` on IPv6-first images and the check refuses to
      // connect; see `HEALTH_CHECK_HOST` above.
      common.health_check_host = HEALTH_CHECK_HOST
    }

    if (input.source.type === 'registry-image') {
      if (!/^sha256:[0-9a-f]{64}$/i.test(input.source.digest)) {
        return { message: 'digest تصویر نامعتبر است.', ok: false, status: 0 }
      }
      const body = {
        ...common,
        // The create route takes the full `image@sha256:<hash>` reference and
        // normalizes it itself — `digestReferenceForCreate` documents the pair.
        docker_registry_image_name: digestReferenceForCreate(
          input.source.image,
          input.source.digest,
        ),
        docker_registry_image_tag: '',
        ...(input.source.registryCredentialUuid
          ? { docker_registry_uuid: input.source.registryCredentialUuid }
          : {}),
      }
      return this.call<{ uuid: string }>('POST', '/applications/dockerimage', body)
    }

    if (!isSafeGitRef(input.source.branch)) {
      return { message: 'شاخهٔ گیت نامعتبر است.', ok: false, status: 0 }
    }
    const source = input.source
    Object.assign(common, {
      base_directory: source.baseDirectory,
      build_pack: source.buildPack,
      git_branch: source.branch,
      git_repository: source.repository,
      is_static: source.isStatic,
    })
    if (source.commitSha) common.git_commit_sha = source.commitSha
    if (source.installCommand) common.install_command = source.installCommand
    if (source.buildCommand) common.build_command = source.buildCommand
    if (source.startCommand) common.start_command = source.startCommand
    if (source.publishDirectory) common.publish_directory = source.publishDirectory
    if (source.dockerfileLocation) common.dockerfile_location = source.dockerfileLocation

    if (source.access === 'github-app') {
      if (!source.githubAppUuid)
        return { message: 'شناسهٔ GitHub App تنظیم نشده است.', ok: false, status: 0 }
      return this.call<{ uuid: string }>('POST', '/applications/private-github-app', {
        ...common,
        github_app_uuid: source.githubAppUuid,
      })
    }
    if (source.access === 'deploy-key') {
      if (!source.privateKeyUuid)
        return { message: 'کلید خصوصی تنظیم نشده است.', ok: false, status: 0 }
      return this.call<{ uuid: string }>('POST', '/applications/private-deploy-key', {
        ...common,
        private_key_uuid: source.privateKeyUuid,
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
    return this.findApplicationScoped({
      name,
      projectUuid: this.target.projectUuid,
      serverUuid: this.target.serverUuid,
    })
  }

  async findApplicationScoped(
    lookup: ApplicationLookup,
  ): Promise<CoolifyResult<null | { uuid: string }>> {
    const result = await this.call<unknown[]>('GET', '/applications')
    if (!result.ok) return result

    const rows = Array.isArray(result.data) ? result.data : []
    const match = rows.find((row) => {
      const record = row as Record<string, unknown>
      if (String(record.name ?? '') !== lookup.name) return false

      const project = applicationProjectOf(record)
      const server = applicationServerOf(record)

      if (lookup.projectUuid && project && project !== lookup.projectUuid) return false
      if (lookup.serverUuid && server && server !== lookup.serverUuid) return false

      return true
    })

    return {
      data: match ? { uuid: String((match as Record<string, unknown>).uuid) } : null,
      ok: true,
    }
  }

  async setEnvironment(
    appUuid: string,
    variables: { isBuildTime?: boolean; key: string; value: string }[],
  ): Promise<CoolifyResult<unknown>> {
    if (!variables.length) return { data: {}, ok: true }
    return this.call('PATCH', `/applications/${encodeURIComponent(appUuid)}/envs/bulk`, {
      data: variables.map((variable) => ({
        is_build_time: variable.isBuildTime ?? true,
        is_literal: true,
        is_preview: false,
        key: variable.key,
        value: variable.value,
      })),
    })
  }

  /**
   * Re-point an existing application at the source and hostnames a new deployment
   * runs — the only PATCH this platform makes, and deliberately a typed method
   * rather than a bare `updateApplication(appUuid, patch)`.
   *
   * `PATCH /applications/{uuid}` in Coolify's API v1 rejects, with
   * `Validation failed`, both fields it does not own and fields its own create
   * routes accept: `project_uuid`, `server_uuid`, `environment_name`,
   * `destination_uuid`, `docker_registry_uuid`, `github_app_uuid` and
   * `private_key_uuid` are all answered «This field is not allowed». Placement is
   * decided once, at create, and a git source's access method cannot change here.
   * Building the body from this closed input type is what keeps that allowlist a
   * property of the client instead of a 422 an operator reads off a row.
   *
   * The digest travels in the stored shape (`digestPinForPatch`): the bare
   * repository plus Coolify's `@sha256` marker in the name column, the bare hash
   * in the tag column.
   */
  async repointApplication(
    appUuid: string,
    input: {
      domains: string
      healthCheckPath: null | string
      port: number
      source:
        | { digest: string; image: string; type: 'registry-image' }
        | {
            baseDirectory: string
            branch: string
            buildCommand: null | string
            buildPack: BuildPack
            commitSha: null | string
            dockerfileLocation: null | string
            installCommand: null | string
            publishDirectory: null | string
            repository: string
            startCommand: null | string
            type: 'git'
          }
    },
  ): Promise<CoolifyResult<unknown>> {
    const patch: Record<string, unknown> = {
      domains: input.domains,
      ports_exposes: String(input.port),
      health_check_enabled: Boolean(input.healthCheckPath),
    }
    if (input.healthCheckPath) {
      patch.health_check_path = input.healthCheckPath
      patch.health_check_port = String(input.port)
      patch.health_check_host = HEALTH_CHECK_HOST
    }

    if (input.source.type === 'registry-image') {
      if (!/^sha256:[0-9a-f]{64}$/i.test(input.source.digest)) {
        return { message: 'digest تصویر نامعتبر است.', ok: false, status: 0 }
      }
      const pin = digestPinForPatch(input.source.image, input.source.digest)
      patch.docker_registry_image_name = pin.name
      patch.docker_registry_image_tag = pin.tag
    } else {
      patch.git_repository = input.source.repository
      patch.git_branch = input.source.branch
      patch.git_commit_sha = input.source.commitSha ?? 'HEAD'
      patch.build_pack = input.source.buildPack
      patch.base_directory = input.source.baseDirectory
      patch.install_command = input.source.installCommand
      patch.build_command = input.source.buildCommand
      patch.start_command = input.source.startCommand
      patch.publish_directory = input.source.publishDirectory
      patch.dockerfile_location = input.source.dockerfileLocation
    }

    return this.call('PATCH', `/applications/${encodeURIComponent(appUuid)}`, patch)
  }

  /**
   * Every application whose domains include `hostname`, with all of its domains.
   *
   * Coolify refuses (`Domain conflicts detected`) to give a hostname to a second
   * application, stopped ones included, so moving a customer's domain between two
   * theme applications starts by finding who holds it now.
   */
  async applicationsHoldingHost(
    hostname: string,
  ): Promise<CoolifyResult<{ domains: string[]; name: string; uuid: string }[]>> {
    const host = hostname.trim().toLowerCase()
    const result = await this.call<unknown[]>('GET', '/applications')
    if (!result.ok) return result

    const rows = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : []
    return {
      data: rows
        .map((row) => ({
          domains: domainListOf(row.fqdn),
          name: String(row.name ?? ''),
          uuid: String(row.uuid ?? ''),
        }))
        .filter((row) => row.uuid && row.domains.some((domain) => hostOfDomain(domain) === host)),
      ok: true,
    }
  }

  /** One application's current domains. */
  async applicationDomains(appUuid: string): Promise<CoolifyResult<string[]>> {
    const result = await this.call<Record<string, unknown>>(
      'GET',
      `/applications/${encodeURIComponent(appUuid)}`,
    )
    if (!result.ok) return result
    return { data: domainListOf(result.data?.fqdn), ok: true }
  }

  /**
   * Replace an application's domains, and nothing else.
   *
   * Only the stored configuration changes: a running container keeps the routing
   * labels it was started with until it is restarted. The domain cut-over relies on
   * exactly that — the old theme keeps answering the customer's domain while the new
   * one is restarted onto it.
   */
  async setDomains(appUuid: string, domains: string[]): Promise<CoolifyResult<unknown>> {
    return this.call('PATCH', `/applications/${encodeURIComponent(appUuid)}`, {
      domains: domains.join(','),
    })
  }

  /**
   * Recreate the application's container without rebuilding it, so it picks up its
   * current domains. Answers with a deployment that `deploymentStatus` can follow.
   */
  async restart(appUuid: string): Promise<CoolifyResult<{ deploymentUuid: string }>> {
    const result = await this.call<Record<string, unknown>>(
      'POST',
      `/applications/${encodeURIComponent(appUuid)}/restart`,
    )
    if (!result.ok) return result

    const uuid = String(result.data?.deployment_uuid ?? '')
    if (!uuid) {
      return {
        detail: scrubDetail(result.data),
        message: 'Coolify شناسهٔ استقرار راه‌اندازی مجدد را برنگرداند.',
        ok: false,
        status: 502,
      }
    }
    return { data: { deploymentUuid: uuid }, ok: true }
  }

  async deploy(appUuid: string): Promise<CoolifyResult<{ deploymentUuid: string }>> {
    /**
     * `/deploy` used to be GET-with-query-parameters. Current Coolify releases reject
     * that request with 405 and `This endpoint has changed to a POST request.`. Keep
     * the selector in the JSON body, as documented by the current API, so application
     * UUIDs do not end up in proxy access-log URLs either.
     */
    const result = await this.call<Record<string, unknown>>('POST', '/deploy', {
      force: false,
      uuid: appUuid,
    })
    if (!result.ok) return result

    // Coolify answers `{ deployments: [{ deployment_uuid }] }`; some older builds
    // answered a bare object. Read both shapes, but do not report success without an
    // id: the poller cannot follow such a build and would otherwise leave the row in
    // `building` until the one-hour stale-job timeout.
    const deployments = (result.data as { deployments?: unknown[] })?.deployments
    const first = Array.isArray(deployments) ? (deployments[0] as Record<string, unknown>) : null
    const uuid =
      (first?.deployment_uuid as string | undefined) ??
      ((result.data as Record<string, unknown>)?.deployment_uuid as string | undefined) ??
      ''

    if (!uuid) {
      return {
        detail: scrubDetail(result.data),
        message: 'Coolify شناسهٔ استقرار را برنگرداند.',
        ok: false,
        status: 502,
      }
    }

    return { data: { deploymentUuid: String(uuid) }, ok: true }
  }

  async deploymentStatus(deploymentUuid: string): Promise<CoolifyResult<DeploymentStatus>> {
    const result = await this.call<Record<string, unknown>>(
      'GET',
      `/deployments/${encodeURIComponent(deploymentUuid)}`,
    )
    if (!result.ok) return result
    const raw = String(result.data?.status ?? 'unknown')
    return { data: { raw, status: statusFromRaw(raw) }, ok: true }
  }

  /**
   * The only way this platform takes an application out of service. There is
   * deliberately no delete and no start: a stopped application keeps its volumes and
   * build history for a human to inspect, and bringing a theme back is a new
   * deployment through the health check, never a container resurrected as it was.
   */
  async stop(appUuid: string): Promise<CoolifyResult<unknown>> {
    // Lifecycle actions are POST in Coolify's current API. Older versions accepted
    // POST as well, so this avoids the same GET → POST break that affected `/deploy`.
    return this.call('POST', `/applications/${encodeURIComponent(appUuid)}/stop`)
  }
}
