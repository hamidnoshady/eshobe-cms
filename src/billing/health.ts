import type { PayloadRequest } from 'payload'

const countStatus = async (req: PayloadRequest, status: string): Promise<number> => {
  try {
    const { totalDocs } = await req.payload.count({
      collection: 'billing-usage-outbox',
      overrideAccess: true,
      req,
      where: { status: { equals: status } },
    })
    return totalDocs
  } catch {
    return -1
  }
}

/**
 * Operational health of the billing boundary. Counts and timestamps only —
 * no revenue, no invoice totals, no prices.
 */
export const billingIntegrationHealth = async (req: PayloadRequest) => {
  const [pending, sending, failed, deadLetters, sent] = await Promise.all([
    countStatus(req, 'pending'),
    countStatus(req, 'sending'),
    countStatus(req, 'failed'),
    countStatus(req, 'dead_letter'),
    countStatus(req, 'sent'),
  ])

  const oldest = await req.payload
    .find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      sort: 'createdAt',
      where: { status: { in: ['pending', 'failed', 'sending'] } },
    })
    .then(({ docs }) => (docs[0] as { createdAt?: string } | undefined)?.createdAt ?? null)
    .catch(() => null)

  const lastSent = await req.payload
    .find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      sort: '-sentAt',
      where: { status: { equals: 'sent' } },
    })
    .then(({ docs }) => (docs[0] as { sentAt?: string } | undefined)?.sentAt ?? null)
    .catch(() => null)

  const lastProjection = await req.payload
    .find({
      collection: 'central-entitlement-projections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      sort: '-receivedAt',
    })
    .then(({ docs }) => (docs[0] as { receivedAt?: string } | undefined)?.receivedAt ?? null)
    .catch(() => null)

  let sites = 0
  let projections = 0
  try {
    sites = (await req.payload.count({ collection: 'sites', overrideAccess: true, req })).totalDocs
    projections = (
      await req.payload.count({ collection: 'central-entitlement-projections', overrideAccess: true, req })
    ).totalDocs
  } catch {
    sites = -1
    projections = -1
  }

  return {
    commercialAuthority: 'cafe-restaurant-pos' as const,
    deadLetters,
    entitlementLastSyncedAt: lastProjection,
    lastSuccessfulPublishAt: lastSent,
    oldestPendingAt: oldest,
    outboxFailed: failed,
    outboxPending: pending,
    outboxSending: sending,
    sitesWithoutProjection: sites < 0 || projections < 0 ? null : Math.max(0, sites - projections),
    usageEventsAccepted: sent,
    usageEventsDead: deadLetters,
    usageEventsFailed: failed,
  }
}

export const billingStatusForSite = async (req: PayloadRequest, siteId: string) => {
  const { docs } = await req.payload.find({
    collection: 'central-entitlement-projections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { site: { equals: siteId } },
  })
  const projection = docs[0] as
    | {
        planCode?: null | string
        receivedAt?: null | string
        serving?: boolean
        subscriptionStatus?: null | string
        version?: number
      }
    | undefined
  const pending = await req.payload
    .count({
      collection: 'billing-usage-outbox',
      overrideAccess: true,
      req,
      where: {
        and: [{ site: { equals: siteId } }, { status: { in: ['pending', 'failed', 'sending', 'dead_letter'] } }],
      },
    })
    .then((result) => result.totalDocs)
    .catch(() => null)

  return {
    commercialAuthority: 'cafe-restaurant-pos' as const,
    planCode: projection?.planCode ?? null,
    projectionVersion: projection?.version ?? null,
    receivedAt: projection?.receivedAt ?? null,
    serving: projection?.serving === true,
    subscriptionStatus: projection?.subscriptionStatus ?? null,
    unsentUsage: pending,
  }
}
