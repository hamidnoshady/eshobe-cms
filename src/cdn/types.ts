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

export interface CdnZoneInput {
  active?: boolean | null
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
