import type { Access, CollectionSlug, PayloadRequest } from 'payload'

import type { User } from '@/payload-types'

import { isPlatformAdmin } from './platformAdmin'

/** `site` is an id on a shallow write and a document in the admin's form state. */
const idOf = (value: unknown): string =>
  value && typeof value === 'object' ? String((value as { id: unknown }).id) : String(value)

/**
 * The site the write lands on. The admin's form state carries `site`; a REST
 * `PATCH { _status: 'published' }` does not, so the stored document is read for it.
 *
 * Null means neither had it — a create with no site, which the plugin rejects
 * anyway.
 */
const siteOfWrite = async (
  collection: CollectionSlug,
  data: Record<string, unknown> | undefined,
  id: number | string | undefined,
  req: PayloadRequest,
): Promise<null | string> => {
  if (data?.site) return idOf(data.site)
  if (!id) return null

  const doc = await req.payload.findByID({
    id,
    collection,
    depth: 0,
    disableErrors: true,
    // This lookup only answers "which site?" so the role check below can run. It
    // decides nothing on its own, and access-controlling it would recurse.
    overrideAccess: true,
    req,
  })

  return doc && 'site' in doc && doc.site ? idOf(doc.site) : null
}

/**
 * Write access for site content: an editor drafts, only an owner publishes.
 *
 * Payload asks `update` twice for every document — once with `_status: 'draft'`, once
 * with `_status: 'published'` — and hides the Publish button when the second answer
 * is false (`@payloadcms/next`'s `getDocumentPermissions`). So this one function
 * covers the button *and* the REST/Local API; there is no separate publish
 * permission to wire up, and no custom admin component.
 *
 * Tenant scoping is not this function's job. The plugin ANDs its own site constraint
 * onto whatever we return, so returning `true` here still only reaches the user's own
 * sites.
 */
export const writeUnlessPublishing =
  (collection: CollectionSlug): Access =>
  async ({ data, id, req }) => {
    const user = req.user as null | User

    if (!user) return false
    if (isPlatformAdmin(user)) return true

    // Not a publish: saving a draft is what an editor is for.
    if (data?._status !== 'published') return true

    const site = await siteOfWrite(collection, data as Record<string, unknown>, id, req)

    // No site to check the role against — deny rather than guess. Publishing is not
    // the operation to be generous on. (Only reachable by creating a document with no
    // `site` in the payload, which the plugin rejects a moment later regardless.)
    if (!site) return false

    return Boolean(user.tenants?.some((row) => idOf(row.tenant) === site && row.role === 'owner'))
  }
