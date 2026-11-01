import type { Access, CollectionSlug, PayloadRequest } from 'payload'

import type { User } from '@/payload-types'

import { isPlatformAdmin } from './platformAdmin'

/**
 * Public-read and publish gates for the custom content engine (issue #166).
 *
 * `content-entries` does not use Payload's draft versions — it carries a
 * WordPress-shaped `status` (draft/pending/published/private/scheduled/trash,
 * `src/lib/entry-status.ts`) — so the two halves of the platform's usual rule
 * are restated against that field:
 *
 * - an anonymous read is the `Where` `{ status: published }`, never a
 *   boolean (CLAUDE.md), composed with the tenant scope by `scopedPublicRead`;
 * - publishing is an owner act, mirroring `writeUnlessPublishing`
 *   (`src/access/publish.ts`): an editor drafts, an owner puts it in front of
 *   visitors. `private`/`scheduled`/`trash` are ordinary editor states; only
 *   the step into `published` is gated.
 */

const idOf = (value: unknown): string =>
  value && typeof value === 'object' ? String((value as { id: unknown }).id) : String(value)

export const authenticatedOrEntryPublished: Access = ({ req: { user } }) => {
  if (user) return true

  return { status: { equals: 'published' } }
}

/**
 * The same gate seen from a relation row. An `entry-term-relations` /
 * `content-relations` document carries no content of its own, but its bare
 * existence names the source entry's id — so anonymously it is only visible
 * when that entry is itself public.
 */
export const authenticatedOrSourceEntryPublished =
  (field: 'entry' | 'fromEntry'): Access =>
  ({ req: { user } }) => {
    if (user) return true

    return { [`${field}.status`]: { equals: 'published' } }
  }

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
    overrideAccess: true,
    req,
  })

  return doc && 'site' in doc && doc.site ? idOf(doc.site) : null
}

export const writeUnlessEntryPublishing =
  (collection: CollectionSlug): Access =>
  async ({ data, id, req }) => {
    const user = req.user as null | User

    if (!user) return false
    if (isPlatformAdmin(user)) return true

    // Anything short of putting the entry in front of visitors is editor work.
    if ((data as { status?: string } | undefined)?.status !== 'published') return true

    const site = await siteOfWrite(collection, data as Record<string, unknown>, id, req)

    if (!site) return false

    return Boolean(user.tenants?.some((row) => idOf(row.tenant) === site && row.role === 'owner'))
  }
