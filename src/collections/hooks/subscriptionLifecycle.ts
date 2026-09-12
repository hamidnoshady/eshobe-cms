import type { CollectionBeforeChangeHook, CollectionBeforeValidateHook } from 'payload'

import { APIError } from 'payload'

import { idOf } from '@/lib/ids'
import { isBillingInterval, periodEnd, type BillingInterval } from '@/lib/saas/plans'

/**
 * What makes a `subscriptions` row coherent.
 *
 * The two invariants a subscription cannot be allowed to break, both of which are
 * silent rather than loud when they do:
 *
 *  1. **One live subscription per site.** Two entitled rows means two answers to
 *     "which plan is this site on?", and whichever one a query happens to sort first
 *     decides the customer's quota that day. Historical rows (cancelled, expired)
 *     are fine and are the whole reason this is a collection.
 *  2. **The period is derived, never typed.** `currentPeriodEnd` decides renewal,
 *     dunning and expiry. Hand-editing it is how a customer ends up billed twice in
 *     a month or never again.
 */

type SubscriptionData = {
  cancelledAt?: unknown
  currentPeriodEnd?: unknown
  currentPeriodStart?: unknown
  plan?: unknown
  reference?: unknown
  site?: unknown
  startedAt?: unknown
  status?: unknown
  trialEndsAt?: unknown
}

const ENTITLED = ['trialing', 'active', 'pastDue', 'suspended']

/**
 * Refuse a second live subscription for the same site.
 *
 * `beforeValidate`, not a unique index: the constraint is "at most one row whose
 * status is in this set", which no ordinary unique index can express. Cancelled and
 * expired rows deliberately do not count, so a customer can re-subscribe after
 * churning without anybody deleting their history.
 */
export const oneSubscriptionPerSite: CollectionBeforeValidateHook = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  const input = (data ?? {}) as SubscriptionData
  const status = String(input.status ?? (originalDoc as SubscriptionData | undefined)?.status ?? 'trialing')
  if (!ENTITLED.includes(status)) return data

  const siteId = idOf(input.site ?? (originalDoc as SubscriptionData | undefined)?.site)
  if (!siteId) return data

  const ownId = operation === 'update' ? String((originalDoc as { id?: unknown } | undefined)?.id ?? '') : ''

  const { docs } = await req.payload.find({
    collection: 'subscriptions',
    depth: 0,
    limit: 5,
    overrideAccess: true,
    pagination: false,
    req,
    select: { status: true },
    where: {
      and: [{ site: { equals: siteId } }, { status: { in: ENTITLED } }],
    },
  })

  const clash = docs.find((doc) => String(doc.id) !== ownId)
  if (clash) {
    throw new APIError(
      'این سایت همین حالا یک اشتراک جاری دارد. برای تغییر طرح، همان ردیف را ویرایش کنید یا ابتدا آن را لغو کنید.',
      400,
    )
  }

  return data
}

/**
 * Derive `startedAt`, the current period and the trial end from the plan.
 *
 * Runs on create and on every update: an operator switching the plan mid-cycle gets
 * a period recomputed from *now*, which is the behaviour a plan change should have
 * — the alternative (keeping the old window) bills the new price for days already
 * paid at the old one.
 *
 * The period is left alone when neither the plan nor the status changed, so an
 * unrelated edit (a note, a limit override) does not silently restart a customer's
 * billing month.
 */
export const syncSubscriptionPeriod: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const input = (data ?? {}) as SubscriptionData
  const previous = (originalDoc ?? {}) as SubscriptionData
  const now = new Date()

  const planId = idOf(input.plan ?? previous.plan)
  if (!planId) return data

  const plan = await req.payload.findByID({
    id: planId,
    collection: 'plans',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })

  if (!plan) return data

  const interval: BillingInterval = isBillingInterval(plan.interval) ? plan.interval : 'monthly'
  const planChanged = idOf(previous.plan) !== planId
  const statusChanged = previous.status !== undefined && input.status !== undefined && previous.status !== input.status

  const startedAt =
    typeof input.startedAt === 'string' && input.startedAt
      ? new Date(input.startedAt)
      : typeof previous.startedAt === 'string' && previous.startedAt
        ? new Date(previous.startedAt)
        : now

  data.startedAt = startedAt.toISOString()

  const needsPeriod =
    operation === 'create' || planChanged || !previous.currentPeriodStart || (statusChanged && input.status === 'active')

  if (needsPeriod) {
    const periodStart = operation === 'create' ? startedAt : now
    const end = periodEnd(periodStart, interval)
    data.currentPeriodStart = periodStart.toISOString()
    data.currentPeriodEnd = end ? end.toISOString() : null
  } else {
    // Preserve what is stored — these columns are read-only in the admin, but the
    // Local API and the renewal job both write through here.
    data.currentPeriodStart = previous.currentPeriodStart ?? null
    data.currentPeriodEnd = input.currentPeriodEnd ?? previous.currentPeriodEnd ?? null
  }

  // Trial end only ever set once, at creation: extending a trial is an operator
  // moving the status back to `trialing`, not a silently sliding date.
  if (operation === 'create') {
    const trialDays = Math.max(0, Math.trunc(Number(plan.trialDays ?? 0)) || 0)
    data.trialEndsAt = trialDays
      ? new Date(startedAt.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString()
      : null
    if (!input.status) data.status = trialDays ? 'trialing' : 'active'
  }

  if (input.status === 'cancelled' && !input.cancelledAt && !previous.cancelledAt) {
    data.cancelledAt = now.toISOString()
  }

  // A human-readable handle for the row, since a subscription has no natural title.
  const siteId = idOf(input.site ?? previous.site)
  if (siteId) {
    const site = await req.payload.findByID({
      id: siteId,
      collection: 'sites',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
      select: { domain: true },
    })
    data.reference = `${(site as { domain?: string } | null)?.domain ?? siteId} · ${plan.code ?? plan.name ?? ''}`
  }

  return data
}
