import type { CollectionSlug, PayloadRequest } from 'payload'

import type { Site } from '@/payload-types'

/**
 * The customer dashboard's own-site header + "at a glance" counts, computed
 * tenant-scoped.
 *
 * Every read runs with `overrideAccess: false` so the multi-tenant plugin's read
 * constraint applies — the difference between "this customer's site(s)" and "every
 * customer on the deployment". The Local API defaults `overrideAccess` to `true`,
 * which skips that constraint; the earlier version of the dashboard did exactly
 * that and showed platform-wide totals plus, occasionally, another tenant's site
 * name in the header. Kept as a separate, tested function so that regression is
 * covered by `tests/int/customer-site-summary.int.spec.ts`, not just by eyeballing
 * a React component. Same rule as `src/lib/site-query.ts`.
 */

export type CustomerSiteSummary = {
  counts: Record<string, number>
  site: Site | null
}

export const customerSiteSummary = async (
  req: PayloadRequest,
  countSlugs: readonly string[],
): Promise<CustomerSiteSummary> => {
  const { payload } = req
  const counts: Record<string, number> = {}
  let site: Site | null = null

  const sites = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req,
  })
  site = (sites.docs[0] as Site | undefined) ?? null

  const results = await Promise.all(
    countSlugs.map(async (slug) => {
      try {
        const { totalDocs } = await payload.count({
          collection: slug as CollectionSlug,
          overrideAccess: false,
          req,
        })
        return [slug, totalDocs] as const
      } catch {
        return [slug, 0] as const
      }
    }),
  )
  for (const [slug, total] of results) counts[slug] = total

  return { counts, site }
}
