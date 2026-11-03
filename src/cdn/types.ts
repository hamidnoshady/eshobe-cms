/** Provider-neutral desired state. The Payload collection is intentionally richer
 * than this type; adapters only receive the values they are allowed to manage. */
export type CdnProvider = 'arvancloud' | 'cloudflare'
export type CdnRecordType = 'A' | 'AAAA' | 'CAA' | 'CNAME' | 'MX' | 'TXT'
export type CdnRuleAction = 'block' | 'challenge' | 'log' | 'skip'

export interface CdnDnsRecord {
  id?: string
  name: string
  content: string
  priority?: number | null
  providerRecordId?: string | null
  proxied?: boolean | null
  ttl?: number | null
  type: CdnRecordType
}

export interface CdnSecurityRule {
  action: CdnRuleAction
  description?: string | null
  enabled?: boolean | null
  expression: string
  id?: string
  kind: 'firewall' | 'waf'
  providerRuleId?: string | null
}

/** Origin-to-edge TLS behaviour an ArvanCloud record may request. ArvanCloud has
 * no zone-level `ssl.mode` field; it realises edge↔origin TLS per DNS record via
 * `upstream_https`. `strict` certificate *validation* is not exposed by the
 * documented ArvanCloud API, so a `strict` desired state is applied as
 * `upstream_https: "on"` and explicitly reported as not fully verifiable rather
 * than silently claimed as strict. */
export type CdnArvanOriginHttps = 'default' | 'on' | 'off'

/** Provider-native ArvanCloud origin controls. These are distinct from the
 * provider-neutral `ssl` group: the ArvanCloud adapter only honours what its API
 * actually accepts, and never maps a generic `ssl.mode` onto an endpoint that
 * has no such field. */
export interface CdnArvanOrigin {
  /** Maps to the record-level `upstream_https` field. Wins over `ssl.mode`. */
  originHttps?: CdnArvanOriginHttps | null
  /** Origin TCP port. Only sent when the API's record payload accepts it. */
  originPort?: number | null
  /** Origin Host header / SNI override. */
  originHostHeader?: string | null
}

export interface CdnZoneInput {
  active?: boolean | null
  arvan?: CdnArvanOrigin | null
  arvanDomainMode?: 'full' | 'partial' | null
  arvanPlanLevel?: string | null
  cache?: {
    alwaysOnline?: boolean | null
    browserTtl?: number | null
    developmentMode?: boolean | null
    edgeTtl?: number | null
    ignoreSetCookie?: boolean | null
    mode?: 'respect-origin' | 'static-assets' | null
  } | null
  capabilities?: {
    advancedCache?: boolean | null
    rateLimiting?: boolean | null
    wafCustomRules?: boolean | null
  } | null
  cloudflareAccountId?: string | null
  credentials?: { apiToken?: string | null } | null
  dnsRecords?: CdnDnsRecord[] | null
  hsts?: {
    enabled?: boolean | null
    includeSubdomains?: boolean | null
    maxAge?: number | null
    preload?: boolean | null
  } | null
  /** Per-zone origin override. When set it wins over the shared account's
   * `originTarget`, so two sites on different physical deployments can point at
   * different origins without sharing one global value. */
  originOverrideAt?: string | null
  originOverrideReason?: string | null
  originTarget?: string | null
  id: string
  provider: CdnProvider
  providerZoneId?: string | null
  provisionIfMissing?: boolean | null
  security?: {
    ddosMode?: 'off' | 'cookie' | 'javascript' | 'recaptcha' | null
    securityLevel?: 'off' | 'low' | 'medium' | 'high' | 'under_attack' | null
    wafMode?: 'off' | 'detect' | 'protect' | null
  } | null
  securityRules?: CdnSecurityRule[] | null
  ssl?: {
    alwaysUseHttps?: boolean | null
    minimumTls?: '1.0' | '1.1' | '1.2' | '1.3' | null
    mode?: 'flexible' | 'full' | 'strict' | null
    tls13?: boolean | null
  } | null
  zoneName: string
}

export type CdnActionState = 'applied' | 'blocked' | 'skipped'
export interface CdnAction {
  detail?: string
  name: string
  state: CdnActionState
}
export interface CdnSyncResult {
  actions: CdnAction[]
  externalIds: Record<string, string>
  nameservers?: string[]
  providerZoneId?: string
  status?: string
}

export interface CdnPurgeResult {
  actions: CdnAction[]
}

/** Outcome of a read-only provider probe used to validate credentials before any
 * mutation. Distinguishes "the token is wrong" from "the token cannot see this
 * zone" from "the provider is unreachable", because each has a different remedy. */
export interface CdnConnectionTestResult {
  checkedAt: string
  /** Best-effort list of the scopes the provider reports for this token. Absent
   * when the provider does not expose scope information. */
  scopes?: string[]
  /** The zone/domain the token can actually see, when the probe reached one. */
  zoneName?: string | null
  providerZoneId?: string | null
  ok: boolean
  message: string
}

/** A single remote DNS record as read back from a provider, normalised across
 * Cloudflare and ArvanCloud so the CMS can diff it against desired state. */
export interface CdnRemoteDnsRecord {
  content: string
  /** `cloud` for ArvanCloud, `proxied` for Cloudflare — both mean "edge proxy on". */
  proxied: boolean
  providerRecordId?: string | null
  name: string
  ttl?: number | null
  type: CdnRecordType
}

/** Authoritative remote provider state for one zone, read without mutating it.
 * This is the "import existing state" input: which records/settings are already
 * there and whether the CMS created them (via the `eshobe-cms` marker). */
export interface CdnRemoteState {
  dnsRecords: CdnRemoteDnsRecord[]
  nameservers: string[]
  providerZoneId?: string | null
  /** Remote SSL/TLS/cache/security settings, provider-neutral where possible. */
  settings: {
    hsts?: { enabled?: boolean | null } | null
    minimumTls?: string | null
    mode?: string | null
    securityLevel?: string | null
    wafMode?: string | null
  }
  readAt: string
  status?: string | null
  zoneName: string
}

export interface CdnDiscoveryResult {
  actions: CdnAction[]
  remote: CdnRemoteState
}

/** A zone the provider account already holds, surfaced by the "find existing
 * zone" step of the connection workflow. Only id/name/status — no credentials
 * and no records. */
export interface CdnRemoteZone {
  id: string
  status: string | null
  zoneName: string
}
