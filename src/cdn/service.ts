import type { Payload, PayloadRequest } from 'payload'

import { decryptCdnSecret } from './crypto'
import type {
  CdnAction,
  CdnDnsRecord,
  CdnPurgeResult,
  CdnProvider,
  CdnRuleAction,
  CdnSecurityRule,
  CdnSyncResult,
  CdnZoneInput,
} from './types'

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const ARVAN_API = 'https://napi.arvancloud.ir/cdn/4.0'
const TIMEOUT_MS = 15_000
const CMS_MARKER = 'eshobe-cms'

export class CdnConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdnConfigurationError'
  }
}

export class CdnProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CdnProviderError'
  }
}

type ObjectValue = Record<string, unknown>

const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}

const array = (value: unknown): ObjectValue[] => (Array.isArray(value) ? value.map(object) : [])

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const action = (
  actions: CdnAction[],
  name: string,
  state: CdnAction['state'],
  detail?: string,
): void => {
  actions.push({ ...(detail ? { detail } : {}), name, state })
}

/** Refuse proxying protocols CDNs cannot carry. This is deliberately enforced
 * before any provider request, rather than trusting either API to fail safely. */
const assertProxyable = (record: CdnDnsRecord): void => {
  if (!record.proxied) return
  if (!['A', 'AAAA', 'CNAME'].includes(record.type)) {
    throw new CdnConfigurationError(
      `${record.type} رکورد قابل پراکسی نیست؛ فقط A، AAAA و CNAME HTTP/HTTPS را فعال کنید.`,
    )
  }
}

const apiErrorText = (body: unknown, fallback: string): string => {
  const payload = object(body)
  const errors = array(payload.errors)
  const first = object(errors[0])
  const explicit = asString(first.message) ?? asString(payload.message) ?? asString(payload.error)
  // Never put an entire upstream body in an exception: it may have reflected a
  // request header. A short provider message is enough for the admin and logger.
  return explicit?.slice(0, 500) || fallback
}

class ProviderHttp {
  constructor(
    private readonly provider: CdnProvider,
    private readonly token: string,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<ObjectValue> {
    const response = await fetch(
      `${this.provider === 'cloudflare' ? CLOUDFLARE_API : ARVAN_API}${path}`,
      {
        ...init,
        headers: {
          accept: 'application/json',
          authorization:
            this.provider === 'cloudflare' ? `Bearer ${this.token}` : `API KEY ${this.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    const body: unknown = await response.json().catch(() => null)

    if (!response.ok)
      throw new CdnProviderError(
        apiErrorText(body, `provider responded ${response.status}`),
        response.status,
      )
    if (this.provider === 'cloudflare') {
      const envelope = object(body)
      if (envelope.success === false)
        throw new CdnProviderError(apiErrorText(envelope, 'Cloudflare rejected the request'))
      return object(envelope.result)
    }
    return object(body)
  }

  async list(path: string): Promise<ObjectValue[]> {
    const response = await fetch(
      `${this.provider === 'cloudflare' ? CLOUDFLARE_API : ARVAN_API}${path}`,
      {
        headers: {
          accept: 'application/json',
          authorization:
            this.provider === 'cloudflare' ? `Bearer ${this.token}` : `API KEY ${this.token}`,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok)
      throw new CdnProviderError(
        apiErrorText(body, `provider responded ${response.status}`),
        response.status,
      )
    const result = this.provider === 'cloudflare' ? object(body).result : body
    return array(result)
  }
}

const recordName = (zone: CdnZoneInput, name: string): string =>
  name === '@'
    ? zone.zoneName
    : name.endsWith(`.${zone.zoneName}`)
      ? name
      : `${name}.${zone.zoneName}`

const recordKey = (record: CdnDnsRecord): string | null => (record.id ? `dns:${record.id}` : null)
const ruleKey = (rule: CdnSecurityRule): string | null => (rule.id ? `rule:${rule.id}` : null)

const cloudflareRecord = (zone: CdnZoneInput, record: CdnDnsRecord): ObjectValue => ({
  comment: `${CMS_MARKER}:${zone.id}:${record.id ?? record.name}`,
  content: record.content,
  name: recordName(zone, record.name),
  ...(record.priority !== null && record.priority !== undefined
    ? { priority: record.priority }
    : {}),
  // TTL must be automatic for proxied records. Cloudflare applies the same rule,
  // but encoding it here avoids an avoidable failed sync.
  proxied: Boolean(record.proxied),
  ttl: record.proxied ? 1 : (record.ttl ?? 1),
  type: record.type,
})

const arvanRecord = (record: CdnDnsRecord): ObjectValue => {
  const shared = {
    cloud: Boolean(record.proxied),
    ip_filter_mode: { count: 'single', geo_filter: 'none', order: 'none' },
    name: record.name,
    ttl: record.ttl ?? 120,
    type: record.type,
    upstream_https: 'default',
  }
  if (record.type === 'A' || record.type === 'AAAA') {
    return { ...shared, value: [{ country: '', ip: record.content, port: null, weight: null }] }
  }
  if (record.type === 'CNAME')
    return { ...shared, value: { host: record.content, host_header: 'source', port: -1 } }
  if (record.type === 'MX')
    return { ...shared, value: { host: record.content, priority: String(record.priority ?? 10) } }
  if (record.type === 'TXT') return { ...shared, value: { text: record.content } }
  // CAA's provider format is a structured object and can differ between API
  // revisions. Sending the single RFC value is the documented conservative form.
  return { ...shared, value: { value: record.content } }
}

const nameservers = (value: ObjectValue): string[] => {
  const raw = value.name_servers ?? value.nameservers ?? value.ns
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}

interface ResolvedZone {
  id?: string
  nameservers: string[]
  status?: string
}

const cloudflareZone = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  allowCreate: boolean,
): Promise<ResolvedZone> => {
  if (zone.providerZoneId) {
    const found = await http.request(`/zones/${encodeURIComponent(zone.providerZoneId)}`)
    return {
      id: asString(found.id) ?? zone.providerZoneId,
      nameservers: nameservers(found),
      status: asString(found.status),
    }
  }

  const matches = await http.list(`/zones?name=${encodeURIComponent(zone.zoneName)}&per_page=50`)
  const existing = matches.find(
    (candidate) => asString(candidate.name)?.toLowerCase() === zone.zoneName.toLowerCase(),
  )
  if (existing)
    return {
      id: asString(existing.id),
      nameservers: nameservers(existing),
      status: asString(existing.status),
    }

  if (!allowCreate)
    throw new CdnConfigurationError(
      'zone در Cloudflare یافت نشد. ابتدا آن را بسازید یا «ساخت خودکار» و «اعمال تنظیمات» را فعال کنید.',
    )
  if (!zone.cloudflareAccountId?.trim())
    throw new CdnConfigurationError('برای ساخت zone جدید Cloudflare، Account ID لازم است.')

  const created = await http.request('/zones', {
    body: JSON.stringify({
      account: { id: zone.cloudflareAccountId.trim() },
      jump_start: false,
      name: zone.zoneName,
      type: 'full',
    }),
    method: 'POST',
  })
  return {
    id: asString(created.id),
    nameservers: nameservers(created),
    status: asString(created.status),
  }
}

const arvanZone = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  allowCreate: boolean,
): Promise<ResolvedZone> => {
  try {
    const found = await http.request(`/domains/${encodeURIComponent(zone.zoneName)}`)
    return { nameservers: nameservers(found), status: asString(found.status) }
  } catch (error) {
    if (!(error instanceof CdnProviderError) || error.status !== 404) throw error
  }
  if (!allowCreate)
    throw new CdnConfigurationError(
      'دامنه در ArvanCloud یافت نشد. ابتدا آن را بسازید یا «ساخت خودکار» و «اعمال تنظیمات» را فعال کنید.',
    )

  const created = await http.request('/domains/dns-service', {
    body: JSON.stringify({
      domain: zone.zoneName,
      domain_type: zone.arvanDomainMode ?? 'full',
      ...(zone.arvanDomainMode === 'partial' && zone.arvanPlanLevel
        ? { plan_level: zone.arvanPlanLevel }
        : {}),
    }),
    method: 'POST',
  })
  return { nameservers: nameservers(created), status: asString(created.status) }
}

const syncCloudflareRecords = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  zoneId: string,
  externalIds: Record<string, string>,
  actions: CdnAction[],
): Promise<void> => {
  for (const record of zone.dnsRecords ?? []) {
    assertProxyable(record)
    const payload = cloudflareRecord(zone, record)
    const key = recordKey(record)
    const existingId = record.providerRecordId || (key ? externalIds[key] : undefined)
    if (existingId) {
      const updated = await http.request(
        `/zones/${zoneId}/dns_records/${encodeURIComponent(existingId)}`,
        { body: JSON.stringify(payload), method: 'PUT' },
      )
      if (key && asString(updated.id)) externalIds[key] = asString(updated.id)!
      action(actions, `dns:${record.name}`, 'applied', 'updated')
      continue
    }

    const matches = await http.list(
      `/zones/${zoneId}/dns_records?comment=${encodeURIComponent(String(payload.comment))}`,
    )
    const known = matches[0]
    if (known?.id) {
      const updated = await http.request(
        `/zones/${zoneId}/dns_records/${encodeURIComponent(String(known.id))}`,
        { body: JSON.stringify(payload), method: 'PUT' },
      )
      if (key && asString(updated.id)) externalIds[key] = asString(updated.id)!
      action(actions, `dns:${record.name}`, 'applied', 'reconciled')
    } else {
      const created = await http.request(`/zones/${zoneId}/dns_records`, {
        body: JSON.stringify(payload),
        method: 'POST',
      })
      if (key && asString(created.id)) externalIds[key] = asString(created.id)!
      action(actions, `dns:${record.name}`, 'applied', 'created')
    }
  }
}

const syncArvanRecords = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  externalIds: Record<string, string>,
  actions: CdnAction[],
): Promise<void> => {
  const current = await http.list(`/domains/${encodeURIComponent(zone.zoneName)}/dns-records`)
  for (const record of zone.dnsRecords ?? []) {
    assertProxyable(record)
    const payload = arvanRecord(record)
    const key = recordKey(record)
    let existingId = record.providerRecordId || (key ? externalIds[key] : undefined)
    // An exact existing record is consciously adopted on its first CMS sync; a
    // merely same-name record is not touched, avoiding accidental takeover.
    if (!existingId) {
      const exact = current.find(
        (candidate) =>
          asString(candidate.type) === record.type &&
          asString(candidate.name) === record.name &&
          JSON.stringify(candidate.value).includes(record.content),
      )
      existingId = asString(exact?.id)
    }

    let saved: ObjectValue
    if (existingId) {
      saved = await http.request(
        `/domains/${encodeURIComponent(zone.zoneName)}/dns-records/${encodeURIComponent(existingId)}`,
        { body: JSON.stringify(payload), method: 'PUT' },
      )
      action(actions, `dns:${record.name}`, 'applied', 'updated')
    } else {
      saved = await http.request(`/domains/${encodeURIComponent(zone.zoneName)}/dns-records`, {
        body: JSON.stringify(payload),
        method: 'POST',
      })
      action(actions, `dns:${record.name}`, 'applied', 'created')
    }
    const id = asString(saved.id) ?? existingId
    if (key && id) externalIds[key] = id
    // Arvan's API has a dedicated cloud state endpoint. Apply both true and false:
    // otherwise changing a managed record from proxied to DNS-only would leave its
    // prior edge state enabled.
    if (id) {
      await http.request(
        `/domains/${encodeURIComponent(zone.zoneName)}/dns-records/${encodeURIComponent(id)}/cloud`,
        { body: JSON.stringify({ cloud: Boolean(record.proxied) }), method: 'PUT' },
      )
    }
  }
}

const cfSetting = async (
  http: ProviderHttp,
  zoneId: string,
  id: string,
  value: unknown,
): Promise<void> => {
  await http.request(`/zones/${zoneId}/settings/${id}`, {
    body: JSON.stringify({ value }),
    method: 'PATCH',
  })
}

const syncCloudflareSettings = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  zoneId: string,
  actions: CdnAction[],
): Promise<void> => {
  const ssl = zone.ssl ?? {}
  await Promise.all([
    ssl.mode ? cfSetting(http, zoneId, 'ssl', ssl.mode) : Promise.resolve(),
    ssl.minimumTls ? cfSetting(http, zoneId, 'min_tls_version', ssl.minimumTls) : Promise.resolve(),
    ssl.tls13 !== undefined && ssl.tls13 !== null
      ? cfSetting(http, zoneId, 'tls_1_3', ssl.tls13 ? 'on' : 'off')
      : Promise.resolve(),
    ssl.alwaysUseHttps !== undefined && ssl.alwaysUseHttps !== null
      ? cfSetting(http, zoneId, 'always_use_https', ssl.alwaysUseHttps ? 'on' : 'off')
      : Promise.resolve(),
    zone.security?.securityLevel
      ? cfSetting(http, zoneId, 'security_level', zone.security.securityLevel)
      : Promise.resolve(),
    zone.cache?.browserTtl !== undefined && zone.cache?.browserTtl !== null
      ? cfSetting(http, zoneId, 'browser_cache_ttl', zone.cache.browserTtl)
      : Promise.resolve(),
  ])
  action(actions, 'tls-and-zone-settings', 'applied')
  // Include `enabled: false` too, so turning HSTS off in the CMS reconciles a
  // previously CMS-enabled header instead of leaving it stuck on at the edge.
  if (zone.hsts?.enabled !== undefined && zone.hsts?.enabled !== null) {
    await cfSetting(http, zoneId, 'security_header', {
      enabled: Boolean(zone.hsts.enabled),
      include_subdomains: Boolean(zone.hsts.includeSubdomains),
      max_age: zone.hsts.maxAge ?? 15552000,
      preload: Boolean(zone.hsts.preload),
    })
    action(actions, 'hsts', 'applied')
  }
}

const syncArvanSettings = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  actions: CdnAction[],
): Promise<void> => {
  const domain = encodeURIComponent(zone.zoneName)
  const ssl = zone.ssl ?? {}
  await http.request(`/domains/${domain}/ssl`, {
    body: JSON.stringify({
      ...(ssl.alwaysUseHttps !== undefined ? { https_redirect: ssl.alwaysUseHttps } : {}),
      ...(ssl.minimumTls ? { tls_version: ssl.minimumTls } : {}),
      ...(zone.hsts?.enabled !== undefined
        ? {
            hsts_include_subdomains: Boolean(zone.hsts.includeSubdomains),
            hsts_max_age: zone.hsts.maxAge ?? 15552000,
            hsts_preload: Boolean(zone.hsts.preload),
            hsts_status: zone.hsts.enabled,
          }
        : {}),
    }),
    method: 'PATCH',
  })
  action(actions, 'tls-and-hsts', 'applied')

  const cache = zone.cache ?? {}
  await http.request(`/domains/${domain}/caching`, {
    body: JSON.stringify({
      ...(cache.browserTtl !== undefined && cache.browserTtl !== null
        ? { browser_cache_ttl: cache.browserTtl }
        : {}),
      ...(cache.developmentMode !== undefined ? { development_mode: cache.developmentMode } : {}),
      ...(cache.alwaysOnline !== undefined ? { always_online: cache.alwaysOnline } : {}),
      ...(cache.edgeTtl !== undefined && cache.edgeTtl !== null
        ? { cache_ttl: cache.edgeTtl }
        : {}),
      ...(cache.mode === 'static-assets' ? { cache_level: 'standard' } : {}),
      ...(cache.ignoreSetCookie !== undefined && zone.capabilities?.advancedCache
        ? { cache_ignore_sc: Boolean(cache.ignoreSetCookie) }
        : {}),
    }),
    method: 'PATCH',
  })
  action(actions, 'cache-settings', 'applied')

  if (zone.security?.wafMode) {
    await http.request(`/domains/${domain}/waf`, {
      body: JSON.stringify({ mode: zone.security.wafMode }),
      method: 'PATCH',
    })
    action(actions, 'waf-mode', 'applied')
  }
  if (zone.security?.ddosMode) {
    await http.request(`/domains/${domain}/ddos`, {
      body: JSON.stringify({ mode: zone.security.ddosMode }),
      method: 'PATCH',
    })
    action(actions, 'ddos-mode', 'applied')
  }
}

const rulesetFor = async (
  http: ProviderHttp,
  zoneId: string,
  phase: string,
  name: string,
): Promise<string> => {
  const found = await http.list(`/zones/${zoneId}/rulesets`)
  const existing = found.find(
    (ruleset) => asString(ruleset.phase) === phase && asString(ruleset.kind) === 'zone',
  )
  const existingId = asString(existing?.id)
  if (existingId) return existingId
  const created = await http.request(`/zones/${zoneId}/rulesets`, {
    body: JSON.stringify({ kind: 'zone', name, phase }),
    method: 'POST',
  })
  const id = asString(created.id)
  if (!id) throw new CdnProviderError('Cloudflare did not return a ruleset id')
  return id
}

const cloudflareAction = (input: CdnRuleAction): string => {
  if (input === 'challenge') return 'managed_challenge'
  if (input === 'skip') return 'skip'
  return input
}

const syncCloudflareRules = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  zoneId: string,
  externalIds: Record<string, string>,
  actions: CdnAction[],
): Promise<void> => {
  if (!(zone.securityRules?.length || zone.cache?.mode)) return
  if (zone.securityRules?.length && !zone.capabilities?.wafCustomRules) {
    action(actions, 'security-rules', 'blocked', 'entitlement wafCustomRules is not confirmed')
  } else if (zone.securityRules?.length) {
    const ruleset = await rulesetFor(
      http,
      zoneId,
      'http_request_firewall_custom',
      `${CMS_MARKER} managed firewall`,
    )
    for (const rule of zone.securityRules) {
      const key = ruleKey(rule)
      const payload = {
        action: cloudflareAction(rule.action),
        description: `${CMS_MARKER}:${zone.id}:${rule.id ?? rule.expression}`.slice(0, 500),
        enabled: rule.enabled !== false,
        expression: rule.expression,
        ...(rule.action === 'skip'
          ? { action_parameters: { phases: ['http_ratelimit', 'http_request_firewall_managed'] } }
          : {}),
      }
      const known = rule.providerRuleId || (key ? externalIds[key] : undefined)
      const saved = known
        ? await http.request(
            `/zones/${zoneId}/rulesets/${ruleset}/rules/${encodeURIComponent(known)}`,
            { body: JSON.stringify(payload), method: 'PATCH' },
          )
        : await http.request(`/zones/${zoneId}/rulesets/${ruleset}/rules`, {
            body: JSON.stringify(payload),
            method: 'POST',
          })
      if (key && asString(saved.id)) externalIds[key] = asString(saved.id)!
      action(actions, `security:${rule.description ?? rule.id ?? 'rule'}`, 'applied')
    }
  }

  if (zone.cache?.mode === 'static-assets') {
    const ruleset = await rulesetFor(
      http,
      zoneId,
      'http_request_cache_settings',
      `${CMS_MARKER} managed cache`,
    )
    const expression = '(http.request.uri.path matches "^/(?:_next/static|media)/")'
    const marker = `${CMS_MARKER}:${zone.id}:static-assets`
    const rules = await http.list(`/zones/${zoneId}/rulesets/${ruleset}/rules`)
    const existing = rules.find((rule) => asString(rule.description) === marker)
    const payload = {
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { default: zone.cache.edgeTtl ?? 86400, mode: 'override_origin' },
      },
      description: marker,
      enabled: true,
      expression,
    }
    const existingId = asString(existing?.id)
    if (existingId)
      await http.request(
        `/zones/${zoneId}/rulesets/${ruleset}/rules/${encodeURIComponent(existingId)}`,
        { body: JSON.stringify(payload), method: 'PATCH' },
      )
    else
      await http.request(`/zones/${zoneId}/rulesets/${ruleset}/rules`, {
        body: JSON.stringify(payload),
        method: 'POST',
      })
    action(actions, 'static-asset-cache-rule', 'applied')
  } else {
    // Do not leave an old cache override alive after the administrator returns
    // to origin-controlled caching. Discover an existing CMS rule only; never
    // create a cache ruleset merely to disable it.
    const rulesets = await http.list(`/zones/${zoneId}/rulesets`)
    const cacheRuleset = rulesets.find(
      (ruleset) =>
        asString(ruleset.phase) === 'http_request_cache_settings' &&
        asString(ruleset.kind) === 'zone',
    )
    const cacheRulesetId = asString(cacheRuleset?.id)
    if (cacheRulesetId) {
      const marker = `${CMS_MARKER}:${zone.id}:static-assets`
      const rules = await http.list(`/zones/${zoneId}/rulesets/${cacheRulesetId}/rules`)
      const existing = rules.find((rule) => asString(rule.description) === marker)
      const existingId = asString(existing?.id)
      if (existingId) {
        await http.request(
          `/zones/${zoneId}/rulesets/${cacheRulesetId}/rules/${encodeURIComponent(existingId)}`,
          { body: JSON.stringify({ enabled: false }), method: 'PATCH' },
        )
        action(actions, 'static-asset-cache-rule', 'applied', 'disabled')
      }
    }
  }
}

const arvanAction = (actionName: CdnRuleAction): string =>
  ({ block: 'deny', challenge: 'challenge', log: 'allow', skip: 'bypass' })[actionName]

const syncArvanRules = async (
  http: ProviderHttp,
  zone: CdnZoneInput,
  externalIds: Record<string, string>,
  actions: CdnAction[],
): Promise<void> => {
  if (!zone.securityRules?.length) return
  if (!zone.capabilities?.wafCustomRules) {
    action(actions, 'security-rules', 'blocked', 'entitlement wafCustomRules is not confirmed')
    return
  }
  const domain = encodeURIComponent(zone.zoneName)
  for (const rule of zone.securityRules) {
    const key = ruleKey(rule)
    const known = rule.providerRuleId || (key ? externalIds[key] : undefined)
    const path =
      rule.kind === 'waf' ? `/domains/${domain}/waf/rules` : `/domains/${domain}/firewall/rules`
    const payload =
      rule.kind === 'waf'
        ? {
            action: rule.action === 'skip' ? 'bypass' : 'protect',
            description: rule.description ?? `${CMS_MARKER} managed WAF`,
            id: known ?? null,
            sources: [],
            url_pattern: rule.expression,
          }
        : {
            action: arvanAction(rule.action),
            filter_expr: rule.expression,
            is_enabled: rule.enabled !== false,
            name: rule.description ?? `${CMS_MARKER} managed firewall`,
            note: `${CMS_MARKER}:${zone.id}`,
          }
    const saved = known
      ? await http.request(`${path}/${encodeURIComponent(known)}`, {
          body: JSON.stringify(payload),
          method: 'PATCH',
        })
      : await http.request(path, { body: JSON.stringify(payload), method: 'POST' })
    if (key && asString(saved.id)) externalIds[key] = asString(saved.id)!
    action(actions, `security:${rule.description ?? rule.id ?? 'rule'}`, 'applied')
  }
}

/** Reconcile the desired state owned by CMS. It never deletes existing remote
 * records or rules: remote state outside CMS ownership may be customer-managed. */
export const syncCdnZone = async (zone: CdnZoneInput): Promise<CdnSyncResult> => {
  const token = decryptCdnSecret(zone.credentials?.apiToken)
  if (!token)
    throw new CdnConfigurationError(
      'API token قابل استفاده نیست. آن را دوباره وارد کنید و کلید رمزنگاری CDN را بررسی کنید.',
    )

  const http = new ProviderHttp(zone.provider, token)
  const actions: CdnAction[] = []
  const externalIds: Record<string, string> = {}
  const allowCreate = Boolean(zone.active && zone.provisionIfMissing)
  const resolved =
    zone.provider === 'cloudflare'
      ? await cloudflareZone(http, zone, allowCreate)
      : await arvanZone(http, zone, allowCreate)

  action(actions, 'provider-zone', 'applied', resolved.status ?? 'found')
  if (!zone.active) {
    action(actions, 'desired-state', 'skipped', 'zone is not active')
    return {
      actions,
      externalIds,
      nameservers: resolved.nameservers,
      providerZoneId: resolved.id,
      status: resolved.status,
    }
  }

  if (zone.provider === 'cloudflare') {
    if (!resolved.id) throw new CdnProviderError('Cloudflare zone has no id')
    await syncCloudflareRecords(http, zone, resolved.id, externalIds, actions)
    await syncCloudflareSettings(http, zone, resolved.id, actions)
    await syncCloudflareRules(http, zone, resolved.id, externalIds, actions)
  } else {
    await syncArvanRecords(http, zone, externalIds, actions)
    await syncArvanSettings(http, zone, actions)
    await syncArvanRules(http, zone, externalIds, actions)
    if (zone.cache?.ignoreSetCookie && !zone.capabilities?.advancedCache)
      action(
        actions,
        'cache-ignore-set-cookie',
        'blocked',
        'entitlement advancedCache is not confirmed',
      )
  }
  return {
    actions,
    externalIds,
    nameservers: resolved.nameservers,
    providerZoneId: resolved.id,
    status: resolved.status,
  }
}

export const purgeCdnZone = async (
  zone: CdnZoneInput,
  urls: string[] | null,
): Promise<CdnPurgeResult> => {
  const token = decryptCdnSecret(zone.credentials?.apiToken)
  if (!token) throw new CdnConfigurationError('API token قابل استفاده نیست.')
  const http = new ProviderHttp(zone.provider, token)
  const actions: CdnAction[] = []
  if (urls?.length) {
    for (const url of urls) {
      try {
        new URL(url)
      } catch {
        throw new CdnConfigurationError(`نشانی purge نامعتبر است: ${url}`)
      }
    }
  }

  if (zone.provider === 'cloudflare') {
    const resolved = await cloudflareZone(http, zone, false)
    if (!resolved.id) throw new CdnProviderError('Cloudflare zone has no id')
    await http.request(`/zones/${resolved.id}/purge_cache`, {
      body: JSON.stringify(urls?.length ? { files: urls } : { purge_everything: true }),
      method: 'POST',
    })
  } else {
    await http.request(`/domains/${encodeURIComponent(zone.zoneName)}/caching/purge`, {
      body: JSON.stringify(
        urls?.length ? { purge: 'individual', purge_urls: urls } : { purge: 'all' },
      ),
      method: 'POST',
    })
  }
  action(actions, urls?.length ? 'purge-urls' : 'purge-all', 'applied')
  return { actions }
}

/** Used only by staff-only endpoint code, immediately before a provider call. */
export const cdnZoneInput = (value: unknown): CdnZoneInput => value as CdnZoneInput

export const updateManagedExternalIds = (
  zone: CdnZoneInput,
  externalIds: Record<string, string>,
): ObjectValue => ({
  dnsRecords: (zone.dnsRecords ?? []).map((record) => ({
    ...record,
    ...(recordKey(record) && externalIds[recordKey(record)!]
      ? { providerRecordId: externalIds[recordKey(record)!] }
      : {}),
  })),
  securityRules: (zone.securityRules ?? []).map((rule) => ({
    ...rule,
    ...(ruleKey(rule) && externalIds[ruleKey(rule)!]
      ? { providerRuleId: externalIds[ruleKey(rule)!] }
      : {}),
  })),
})

export const formatCdnActions = (actions: CdnAction[]): string =>
  actions
    .map((entry) => `[${entry.state}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
    .join('\n')

export const writeCdnOperationalState = async (
  payload: Payload,
  req: PayloadRequest,
  zone: CdnZoneInput,
  result: CdnSyncResult,
  ok: boolean,
  detail: string,
): Promise<void> => {
  await payload.update({
    id: zone.id,
    collection: 'cdn-zones',
    data: {
      ...updateManagedExternalIds(zone, result.externalIds),
      lastSyncAt: new Date().toISOString(),
      lastSyncDetail: detail,
      lastSyncOk: ok,
      ...(result.providerZoneId ? { providerZoneId: result.providerZoneId } : {}),
      ...(result.status ? { providerStatus: result.status } : {}),
      ...(result.nameservers
        ? { providerNameservers: result.nameservers.map((hostname) => ({ hostname })) }
        : {}),
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}
