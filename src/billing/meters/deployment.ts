/**
 * A commercial deployment measurement is a successful production promotion.
 * Preview rehearsals and failed builds are not. The event id is the deployment
 * row, so a retry of that same row does not become a second event.
 */

import { isProductionMode } from '@/lib/deploy/status'

import { deploymentEventId } from '@/billing/meters/event-id'

export type DeploymentMeasure = {
  commitSha: null | string
  dimensions: Record<string, string>
  eventId: string
  meterKey: 'cms.deployment'
  mode: string
  quantity: 1
  resourceId: string
  resourceType: 'deployment'
  siteId: string
  unit: 'deployment'
}

export const deploymentMeasure = (args: {
  commitSha?: null | string
  deploymentId: string
  mode: unknown
  siteId: string
  status: unknown
}): DeploymentMeasure | null => {
  if (args.status !== 'live') return null
  if (!isProductionMode(args.mode)) return null
  if (!args.siteId || !args.deploymentId) return null
  return {
    commitSha: args.commitSha ?? null,
    dimensions: {
      domainMode: String(args.mode),
      ...(args.commitSha ? { commitSha: args.commitSha } : {}),
      source: 'deployment-promoted',
    },
    eventId: deploymentEventId(args.deploymentId),
    meterKey: 'cms.deployment',
    mode: String(args.mode),
    quantity: 1,
    resourceId: args.deploymentId,
    resourceType: 'deployment',
    siteId: args.siteId,
    unit: 'deployment',
  }
}
