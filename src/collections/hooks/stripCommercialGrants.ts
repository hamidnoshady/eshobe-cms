import type { CollectionBeforeChangeHook } from 'payload'

/**
 * `site-entitlements.features` and `limitOverrides` are the old commercial
 * override sheet. They stay on the row so a migration can read them, and they
 * are stripped from every write so an operator cannot grant a paid capability
 * from this CMS. Technical holds and quota enforcement policy are the fields
 * that remain writable.
 */
export const stripCommercialGrants: CollectionBeforeChangeHook = ({ data, req }) => {
  if (req?.context?.allowLegacyEntitlementArchive === true) return data
  if (!data || typeof data !== 'object') return data
  const next = { ...(data as Record<string, unknown>) }
  delete next.features
  delete next.limitOverrides
  return next
}
