import type { PayloadRequest } from 'payload'

import type { UsageEventV1 } from '@/billing/contract/v1'
import { deploymentMeasure } from '@/billing/meters/deployment'
import { enqueueUsageEvent } from '@/billing/usage/outbox'

/** Record one successful production deployment. Preview and failure record nothing. */
export const recordDeploymentUsage = async (
  req: PayloadRequest,
  args: { commitSha?: null | string; deploymentId: string; mode: unknown; siteId: string },
): Promise<boolean> => {
  const measure = deploymentMeasure({ ...args, status: 'live' })
  if (!measure) return false
  const start = new Date()
  const end = new Date(start.getTime() + 1000)
  const event: UsageEventV1 = {
    actor: null,
    contractVersion: 1,
    correctsEventId: null,
    correctionReason: null,
    dimensions: measure.dimensions,
    eventId: measure.eventId,
    kind: 'measurement',
    meterKey: 'cms.deployment',
    occurredAt: end.toISOString(),
    periodEnd: end.toISOString(),
    periodStart: start.toISOString(),
    quantity: 1,
    resourceId: measure.resourceId,
    resourceType: 'deployment',
    siteId: measure.siteId,
    unit: 'deployment',
  }
  await enqueueUsageEvent(req, event)
  return true
}
