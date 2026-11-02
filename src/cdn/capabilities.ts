import type { CdnProvider } from './types'

/**
 * Provider-native capability matrix.
 *
 * ArvanCloud and Cloudflare are **not** interchangeable configuration backends.
 * This module is the single place that records which provider actually supports
 * which control, so the UI can disable an unsupported control with an explanation
 * instead of silently sending a value the provider API ignores — and the sync can
 * report `unsupported` rather than claiming a setting was applied.
 *
 * The matrix is deliberately conservative: a feature is `true` only where the
 * provider's documented API exposes it. Anything the provider does not expose is
 * `false`, with a short note explaining the nearest equivalent or the mapping the
 * adapter uses instead.
 */
export type CdnFeature =
  | 'ssl.mode'
  | 'ssl.minimumTls'
  | 'origin.https'
  | 'origin.strictTls'
  | 'origin.port'
  | 'origin.hostHeader'
  | 'hsts'
  | 'cache.browserTtl'
  | 'cache.edgeTtl'
  | 'cache.mode'
  | 'cache.ignoreSetCookie'
  | 'security.level'
  | 'security.waf'
  | 'security.ddos'
  | 'security.rules'
  | 'dns.proxy'
  | 'discovery'
  | 'connectionTest'

export interface ProviderCapabilities {
  features: Record<CdnFeature, boolean>
  /** Human-readable explanation for a `false` feature (or the mapping used). */
  notes: Partial<Record<CdnFeature, string>>
}

const allFeatures = (): CdnFeature[] => [
  'ssl.mode',
  'ssl.minimumTls',
  'origin.https',
  'origin.strictTls',
  'origin.port',
  'origin.hostHeader',
  'hsts',
  'cache.browserTtl',
  'cache.edgeTtl',
  'cache.mode',
  'cache.ignoreSetCookie',
  'security.level',
  'security.waf',
  'security.ddos',
  'security.rules',
  'dns.proxy',
  'discovery',
  'connectionTest',
]

const allFalse = (): Record<CdnFeature, boolean> =>
  Object.fromEntries(allFeatures().map((feature) => [feature, false])) as Record<
    CdnFeature,
    boolean
  >

/** Cloudflare exposes zone-level SSL/TLS, HSTS, cache and security settings
 * through its zone-settings and rulesets APIs. */
export const CLOUDFLARE_CAPABILITIES: ProviderCapabilities = {
  features: {
    ...allFalse(),
    'ssl.mode': true,
    'ssl.minimumTls': true,
    'origin.https': true,
    'origin.strictTls': true,
    // Cloudflare has no per-record origin port in basic zone settings; it is
    // reachable only through origin rules (a paid, rule-level feature).
    'origin.port': false,
    'origin.hostHeader': false,
    hsts: true,
    'cache.browserTtl': true,
    'cache.edgeTtl': true,
    'cache.mode': true,
    'cache.ignoreSetCookie': false,
    'security.level': true,
    'security.waf': true,
    'security.ddos': true,
    'security.rules': true,
    'dns.proxy': true,
    discovery: true,
    connectionTest: true,
  },
  notes: {
    'origin.port': 'Cloudflare basic zone settings do not expose a per-record origin port.',
    'origin.hostHeader': 'Origin Host/SNI requires an origin rule (ruleset), not basic settings.',
    'cache.ignoreSetCookie': 'Requires a cache rule with ignore-Set-Cookie (entitlement).',
  },
}

/**
 * ArvanCloud has **no** zone-level `ssl.mode` and cannot enforce strict origin
 * certificate validation. Origin TLS is realised per DNS record via
 * `upstream_https`; the edge minimum TLS and HSTS live on the `/ssl` endpoint.
 */
export const ARVAN_CAPABILITIES: ProviderCapabilities = {
  features: {
    ...allFalse(),
    'ssl.mode': false,
    'ssl.minimumTls': true,
    'origin.https': true,
    'origin.strictTls': false,
    'origin.port': true,
    'origin.hostHeader': true,
    hsts: true,
    'cache.browserTtl': true,
    'cache.edgeTtl': true,
    'cache.mode': false,
    'cache.ignoreSetCookie': false,
    'security.level': false,
    'security.waf': true,
    'security.ddos': true,
    'security.rules': true,
    'dns.proxy': true,
    discovery: true,
    connectionTest: true,
  },
  notes: {
    'ssl.mode':
      'ArvanCloud has no zone-level ssl.mode; it maps to the per-record upstream_https field.',
    'origin.strictTls':
      'ArvanCloud does not expose strict origin certificate validation; strict is applied as upstream_https=on and reported as not fully verifiable.',
    'cache.mode':
      'ArvanCloud has no static-assets cache rule equivalent; only a standard cache level.',
    'cache.ignoreSetCookie': 'Requires the advancedCache entitlement (cache_ignore_sc).',
    'security.level': 'ArvanCloud has no general security level; WAF and DDoS are separate modes.',
  },
}

export const PROVIDER_CAPABILITIES: Record<CdnProvider, ProviderCapabilities> = {
  cloudflare: CLOUDFLARE_CAPABILITIES,
  arvancloud: ARVAN_CAPABILITIES,
}

export const providerCapabilities = (provider: CdnProvider): ProviderCapabilities =>
  PROVIDER_CAPABILITIES[provider] ?? PROVIDER_CAPABILITIES.cloudflare

export const supportsFeature = (provider: CdnProvider, feature: CdnFeature): boolean =>
  providerCapabilities(provider).features[feature] === true

export const featureNote = (provider: CdnProvider, feature: CdnFeature): string | undefined =>
  providerCapabilities(provider).notes[feature]

/** The full list of features, in display order, for a provider. */
export const providerFeatures = (provider: CdnProvider): CdnFeature[] =>
  (Object.keys(providerCapabilities(provider).features) as CdnFeature[])
