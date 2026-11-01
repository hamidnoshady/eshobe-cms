import type { CollectionSlug, PayloadRequest } from 'payload'

import { ValidationError } from 'payload'

import { idOf } from '@/lib/ids'

/**
 * Shared tenant-boundary plumbing for the custom content engine's hooks
 * (issue #166). The engine's graph — entry → type, term → taxonomy,
 * relation → entry/term — is only safe if every edge is checked against the
 * *document's own site*, the same rule `settleStock` documents: the tenant
 * comes from the record being written, and a related document on another
 * site is refused by name. Access control narrows which rows a caller may
 * see; these hooks are what stop a caller who *can* write from wiring their
 * entry to another customer's definition by id.
 */

export type LooseDoc = Record<string, unknown> & { id: string }

/** The site a create/update lands on: incoming data first, else the stored doc. */
export const siteIdOfWrite = (
  data: Record<string, unknown> | undefined,
  originalDoc?: Record<string, unknown>,
): null | string => idOf(data?.site ?? originalDoc?.site)

/** One document of `collection` with this id *on this site*, or undefined. */
export const findOnSite = async (
  req: PayloadRequest,
  collection: string,
  id: null | string,
  siteId: null | string,
  select?: Record<string, boolean>,
): Promise<LooseDoc | undefined> => {
  if (!id || !siteId) return undefined

  const { docs } = await req.payload.find({
    collection: collection as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    ...(select ? { select: select as never } : {}),
    where: {
      and: [{ id: { equals: id } }, { site: { equals: siteId } }],
    },
  })

  return docs[0] as unknown as LooseDoc | undefined
}

/**
 * The ancestor id chain above `startId` (nearest first), for cycle checks.
 * Bounded: a hierarchy deeper than the cap is a data problem the caller
 * reports rather than a loop this walk follows forever.
 */
export const parentChainOf = async (
  req: PayloadRequest,
  collection: string,
  startId: null | string,
  siteId: null | string,
  parentField = 'parent',
): Promise<string[]> => {
  const chain: string[] = []
  let current = startId

  while (current && chain.length < 32) {
    const doc = await findOnSite(req, collection, current, siteId, { [parentField]: true })
    if (!doc) break
    const parent = idOf(doc[parentField])
    if (!parent || chain.includes(parent)) break
    chain.push(parent)
    current = parent
  }

  return chain
}

/** A field-scoped validation failure in the shape the admin renders. */
export const failField = (
  collection: { slug: string },
  req: PayloadRequest,
  errors: { message: string; path: string }[],
): never => {
  throw new ValidationError({ collection: collection.slug, errors, req })
}
