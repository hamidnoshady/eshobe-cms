import type { CollectionBeforeChangeHook } from 'payload'

/**
 * Where one site's files live in the bucket.
 *
 * Every tenant shares one R2 bucket, so the key has to carry the tenant or two
 * customers who both upload `logo.png` overwrite each other — the filename is
 * unique per collection in Postgres, not per site. The prefix also makes the
 * per-site operations possible at all: a lifecycle rule, a `rclone sync` of one
 * customer's media, or deleting an offboarded site's files is a prefix operation.
 *
 * `sites/<id>/media` and not `media/<id>`: grouping by tenant first keeps
 * everything one customer owns under one key prefix, which is what backup and
 * deletion policies are written against.
 */
export const sitePrefix = (siteId: string): string => `sites/${siteId}/media`

const idOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value) {
    const { id } = value as { id?: unknown }
    return id == null ? undefined : String(id)
  }
  return undefined
}

/**
 * Stamps the storage prefix onto a media document, once.
 *
 * `beforeChange` and not a field `defaultValue`: the multi-tenant plugin fills
 * `site` from the tenant cookie during field hooks, so a default evaluated earlier
 * sees no site at all.
 *
 * **The prefix never changes after create.** The file already sits at
 * `sites/<id>/media/<filename>` in the bucket; re-deriving the prefix from a moved
 * document would point the record at a key that does not exist, and the delete hook
 * would then miss the real object on cleanup. Reassigning media across sites is a
 * copy, not an update.
 */
export const setMediaPrefix: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  const existing = (originalDoc as { prefix?: unknown } | undefined)?.prefix

  if (typeof existing === 'string' && existing) return { ...data, prefix: existing }

  const siteId = idOf(data?.site ?? (originalDoc as { site?: unknown } | undefined)?.site)

  // No site yet (the tenant field is required, so this is a request that is about
  // to be rejected anyway): leave the prefix alone rather than write a key at the
  // bucket root, where it would be nobody's and outlive the failed create.
  return siteId ? { ...data, prefix: sitePrefix(siteId) } : data
}
