import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

/**
 * One entry↔term edge, kept honest (issue #166 §2):
 *
 * - entry, term and taxonomy all belong to the relation's own site;
 * - the denormalized `taxonomy` always equals the term's taxonomy — filled
 *   from the term when omitted (the importer writes term-first), refused
 *   when it disagrees;
 * - the taxonomy must be linked to the entry's content type, so a "genre"
 *   term cannot be filed onto a type that never declared genres;
 * - the edge is unique per {site, entry, term}: replays and retries land on
 *   the same row or fail loudly, never duplicate silently.
 */
export const validateEntryTermRelation: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const siteId = siteIdOfWrite(data, originalDoc)
  const entryId = idOf(data.entry ?? originalDoc?.entry)
  const termId = idOf(data.term ?? originalDoc?.term)

  if (!siteId || !entryId || !termId) return data

  const entry = await findOnSite(req, 'content-entries', entryId, siteId, {
    contentType: true,
  })
  if (!entry) {
    failField(collection, req, [{ message: 'رکورد محتوا متعلق به این سایت نیست.', path: 'entry' }])
  }

  const term = await findOnSite(req, 'taxonomy-terms', termId, siteId, { taxonomy: true })
  if (!term) {
    failField(collection, req, [{ message: 'واژه متعلق به این سایت نیست.', path: 'term' }])
  }

  const taxonomyId = idOf(term!.taxonomy)
  const declaredTaxonomyId = idOf(data.taxonomy ?? originalDoc?.taxonomy)

  if (declaredTaxonomyId && taxonomyId && declaredTaxonomyId !== taxonomyId) {
    failField(collection, req, [
      { message: 'طبقه‌بندی این پیوند باید طبقه‌بندی خودِ واژه باشد.', path: 'taxonomy' },
    ])
  }

  const contentTypeId = idOf(entry!.contentType)
  const typeDef = contentTypeId
    ? await findOnSite(req, 'content-type-definitions', contentTypeId, siteId, {
        taxonomies: true,
      })
    : undefined
  const linked = ((typeDef?.taxonomies ?? []) as unknown[]).map(idOf)

  if (!taxonomyId || !linked.includes(taxonomyId)) {
    failField(collection, req, [
      {
        message:
          'طبقه‌بندی این واژه به گونه محتوای رکورد پیوسته نیست؛ نخست آن را در تعریف گونه محتوا پیوند دهید.',
        path: 'term',
      },
    ])
  }

  const { totalDocs } = await req.payload.count({
    collection: collection.slug,
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        { entry: { equals: entryId } },
        { term: { equals: termId } },
        ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    failField(collection, req, [
      { message: 'این واژه از قبل به این رکورد پیوسته است.', path: 'term' },
    ])
  }

  return { ...data, taxonomy: taxonomyId }
}
