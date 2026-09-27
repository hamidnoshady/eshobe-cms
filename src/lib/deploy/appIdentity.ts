import type { DeploymentLane } from '@/lib/deploy/lane'
import type { DomainMode } from '@/lib/deploy/status'
import { boundedLabel } from '@/deploy/coolify'

/** Stable Coolify application name — must not depend on mutable site.domain. */
export const bindingAppName = (
  siteId: string,
  themeKey: string,
  lane: DeploymentLane,
): string => {
  const stableSite = String(siteId).replace(/-/g, '').slice(0, 12)
  return boundedLabel(`eshobe-${stableSite}-${themeKey}`, 60, lane) || `eshobe-${lane}`
}

/** Pre-binding naming (domain-based). Used only for legacy adoption. */
export const legacyAppName = (
  siteDomain: string,
  siteId: string,
  themeKey: string,
  domainMode: DomainMode,
): string => {
  const variant = domainMode === 'preview' ? 'preview' : null
  const base = siteDomain.trim() || String(siteId)
  return boundedLabel(`${base}-${themeKey}`, 60, variant) || 'eshobe-site'
}

export const bindingKeyOf = (siteId: string, themePackageId: string, lane: DeploymentLane): string =>
  `${siteId}:${themePackageId}:${lane}`
