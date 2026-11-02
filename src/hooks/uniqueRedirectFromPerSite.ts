import type { CollectionBeforeValidateHook } from 'payload'

import { ValidationError } from 'payload'

/**
 * A redirect source path is unique per site, not across the platform.
 *
 * The redirects plugin models a single-tenant site and marks `from` globally
 * unique. On Eshobe two customers can both retire `/old-page`; only two rules
 * for the same path on the *same* site are ambiguous. The plugin override
 * drops the global DB unique, the migration SQL replaces it with the
 * `(site, from)` unique, and this hook gives editors the scoped validation
 * error instead of a database constraint name.
 */
export const uniqueRedirectFromPerSite: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const from = data?.from ?? originalDoc?.from
  const site = data?.site ?? originalDoc?.site
  const siteId = typeof site === 'object' && site !== null ? site.id : site

  if (!from || !siteId) return data

  const { totalDocs } = await req.payload.count({
    collection: 'redirects',
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        { from: { equals: from } },
        ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    throw new ValidationError({
      collection: collection.slug,
      errors: [
        {
          message: `برای مسیر «${from}» در همین سایت از قبل تغییرمسیر ثبت شده است.`,
          path: 'from',
        },
      ],
      req,
    })
  }

  return data
}
