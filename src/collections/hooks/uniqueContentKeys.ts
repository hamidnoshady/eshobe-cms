import type { CollectionBeforeValidateHook, CollectionSlug } from 'payload'

import { archiveSlugOf } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'

import { failField, siteIdOfWrite } from './contentSameSite'

/**
 * Per-site uniqueness for the content engine's addressing keys (issue #166).
 *
 * Same reasoning as `uniqueSlugPerSite`: neither the multi-tenant plugin nor
 * a compound DB index can express "unique per site (and locale/parent
 * definition)", so the check is application-level and `overrideAccess`
 * (a tenant user cannot necessarily read the sibling row they collide with).
 * Check-then-write races are accepted for hand-typed keys, as there.
 *
 * The scopes differ by key, and the difference is the point:
 * - a definition **machine key** is unique per site within its collection;
 * - an **archive slug** is unique per {site, locale} across *both* definition
 *   collections — `/سبک/…` must mean one thing on a site;
 * - a **term slug** is unique per {site, taxonomy, locale} — the same slug in
 *   two taxonomies is two different terms (WordPress semantics, issue §4);
 * - an **entry slug** is unique per {site, content type, locale}.
 */

export const uniqueKeyPerSite: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const key = data?.key ?? originalDoc?.key
  const siteId = siteIdOfWrite(data, originalDoc)

  if (!key || !siteId) return data

  const { totalDocs } = await req.payload.count({
    collection: collection.slug,
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        { key: { equals: key } },
        ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    failField(collection, req, [
      { message: `کلید «${key}» در این سایت از قبل تعریف شده است.`, path: 'key' },
    ])
  }

  return data
}

const DEFINITION_COLLECTIONS: CollectionSlug[] = [
  'content-type-definitions',
  'taxonomy-definitions',
] as CollectionSlug[]

export const uniqueArchiveSlugPerSite: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const siteId = siteIdOfWrite(data, originalDoc)
  const key = (data?.key ?? originalDoc?.key) as string | undefined

  if (!siteId || !key) return data

  const own = archiveSlugOf({
    archiveSlug: (data?.archiveSlug ?? originalDoc?.archiveSlug) as null | string,
    key,
  })
  const locale = req.locale === 'all' ? undefined : req.locale

  // Definition rows per site are few by construction; comparing the
  // *effective* slug (archiveSlug or key fallback) in memory is simpler and
  // truer than encoding the fallback in a `where`.
  for (const slug of DEFINITION_COLLECTIONS) {
    const { docs } = await req.payload.find({
      collection: slug,
      depth: 0,
      limit: 200,
      locale,
      overrideAccess: true,
      pagination: false,
      req,
      select: { archiveSlug: true, key: true },
      where: { site: { equals: siteId } },
    })

    const clash = docs.find(
      (doc) =>
        !(slug === collection.slug && String(doc.id) === String(originalDoc?.id ?? '')) &&
        archiveSlugOf(doc as { archiveSlug?: null | string; key: string }) === own,
    )

    if (clash) {
      failField(collection, req, [
        {
          message: `بخش نشانی «${own}» در این زبان برای «${(clash as { key?: string }).key}» به کار رفته است؛ هر نشانی بایگانی روی یک سایت فقط یک معنا دارد.`,
          path: 'archiveSlug',
        },
      ])
    }
  }

  return data
}

export const uniqueTermSlugPerTaxonomy: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const slug = data?.slug ?? originalDoc?.slug
  const taxonomyId = idOf(data?.taxonomy ?? originalDoc?.taxonomy)
  const siteId = siteIdOfWrite(data, originalDoc)

  if (!slug || !siteId || !taxonomyId) return data

  const { totalDocs } = await req.payload.count({
    collection: collection.slug,
    locale: req.locale === 'all' ? undefined : req.locale,
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        { taxonomy: { equals: taxonomyId } },
        { slug: { equals: slug } },
        ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    failField(collection, req, [
      {
        message: `پیوسته‌نام «${slug}» در همین طبقه‌بندی و زبان تکراری است.`,
        path: 'slug',
      },
    ])
  }

  return data
}

export const uniqueEntrySlugPerContentType: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const slug = data?.slug ?? originalDoc?.slug
  const contentTypeId = idOf(data?.contentType ?? originalDoc?.contentType)
  const siteId = siteIdOfWrite(data, originalDoc)

  if (!slug || !siteId || !contentTypeId) return data

  const { totalDocs } = await req.payload.count({
    collection: collection.slug,
    locale: req.locale === 'all' ? undefined : req.locale,
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        { contentType: { equals: contentTypeId } },
        { slug: { equals: slug } },
        ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    failField(collection, req, [
      {
        message: `پیوسته‌نام «${slug}» در همین گونه محتوا و زبان تکراری است.`,
        path: 'slug',
      },
    ])
  }

  return data
}
