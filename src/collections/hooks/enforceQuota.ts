import type { CollectionBeforeValidateHook } from 'payload'

import { APIError } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'
import type { QuotaMetric } from '@/lib/saas/plans'
import { quotaBlockMessage } from '@/platform/entitlements'

/**
 * Refuse a create that would put a site past its plan's limit.
 *
 * ## Why `beforeValidate` and only on `create`
 *
 * `create` is the only operation that can increase a count — an update to an
 * existing page cannot put a site over its page limit, and running the check there
 * would make every save pay for a quota read. `beforeValidate` rather than
 * `beforeChange` so the refusal happens before Payload does any of the work of
 * building the document.
 *
 * ## Why it is off unless the operator turns it on
 *
 * `quotaBlockMessage` returns `null` unless the resolved enforcement policy is
 * `enforce` — and the platform default is `warn` (`platform-settings`). A quota
 * system whose default is "block" turns a half-configured plan row into a customer
 * who cannot publish, with no error message that explains why. Warn-first means the
 * operator sees the overage in the dashboard and the report *before* anybody is
 * stopped.
 *
 * ## Why the site is resolved twice
 *
 * A write from the admin UI carries `site` in the payload (the multi-tenant plugin
 * puts it there). A write from a site API key does not — `forceApiKeySite` stamps
 * it, but that is a `beforeChange` hook and runs *after* this one. Without the key
 * fallback below, every headless write would slip past the quota silently, which is
 * exactly the traffic a limit on `posts` or `products` exists to bound.
 *
 * ## Why it never blocks a platform admin
 *
 * Support work happens over a customer's limit by definition: an operator fixing a
 * shop at 3am must not be stopped by the shop's own plan. The check is on the
 * customer's path, not on the operator's.
 */
export const enforceQuota =
  (metric: QuotaMetric): CollectionBeforeValidateHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create') return data
    if (!req?.payload) return data

    // Platform staff bypass: see above. `role` is the same check every other
    // platform-admin decision in this codebase makes.
    if ((req.user as { role?: unknown } | null | undefined)?.role === 'platformAdmin') return data

    const siteId =
      idOf((data as { site?: unknown } | undefined)?.site) ||
      (await requestApiKey(req).then((key) => (key?.role === 'site' ? key.siteId : null)))
    if (!siteId) return data

    const message = await quotaBlockMessage(req, siteId, metric)
    if (message) throw new APIError(message, 402)

    return data
  }
