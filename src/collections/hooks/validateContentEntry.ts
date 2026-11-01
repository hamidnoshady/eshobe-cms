import type { CollectionBeforeValidateHook } from 'payload'

import type { CustomFieldDefinition } from '@/lib/custom-fields'
import {
  mediaIdsInValues,
  relationshipRefsInValues,
  searchableTextForValues,
  splitKnownValues,
  validateFieldValues,
} from '@/lib/custom-fields'
import { idOf } from '@/lib/ids'

import { failField, findOnSite, parentChainOf, siteIdOfWrite } from './contentSameSite'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * The entry write's integrity pass (issue #166 §2/§4):
 *
 * - the content type, parent, hero/gallery media and every document a custom
 *   field references belong to **this site**;
 * - a parent requires a hierarchical type and an entry of the same type, and
 *   cannot close a cycle;
 * - `fieldValues` validates against the type's `fieldSchema`; **unknown keys
 *   are moved into `unmappedMeta`, never dropped** — an ACF key without a
 *   mapping yet stays losslessly on the entry, flagged for a later re-map;
 * - `searchText` is recomputed from searchable fields, and a first publish
 *   stamps `publishedAt`.
 *
 * Partial updates are respected: fields the write does not mention are not
 * re-litigated, except when the content type itself changes — then the
 * stored values must answer to the new type's schema before they ride along.
 */
export const validateContentEntry: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const siteId = siteIdOfWrite(data, originalDoc)
  const contentTypeId = idOf(data.contentType ?? originalDoc?.contentType)

  if (!siteId || !contentTypeId) return data

  const typeDef = await findOnSite(req, 'content-type-definitions', contentTypeId, siteId, {
    fieldSchema: true,
    hierarchical: true,
    key: true,
  })

  if (!typeDef) {
    failField(collection, req, [
      { message: 'گونه محتوای انتخاب‌شده متعلق به این سایت نیست.', path: 'contentType' },
    ])
  }

  const next: Record<string, unknown> = { ...data }

  // --- Parent (hierarchical types only, same type, no cycle) ----------------
  const parentId = idOf(data.parent ?? originalDoc?.parent)

  if (parentId) {
    if (typeDef!.hierarchical !== true) {
      failField(collection, req, [
        { message: 'این گونه محتوا سلسله‌مراتبی نیست و رکورد والد نمی‌پذیرد.', path: 'parent' },
      ])
    }
    const parent = await findOnSite(req, 'content-entries', parentId, siteId, {
      contentType: true,
    })
    if (!parent) {
      failField(collection, req, [
        { message: 'رکورد والد متعلق به این سایت نیست.', path: 'parent' },
      ])
    }
    if (idOf(parent!.contentType) !== contentTypeId) {
      failField(collection, req, [
        { message: 'رکورد والد باید از همان گونه محتوا باشد.', path: 'parent' },
      ])
    }
    const ownId = originalDoc?.id ? String(originalDoc.id) : null
    if (ownId && (parentId === ownId || (await parentChainOf(req, 'content-entries', parentId, siteId)).includes(ownId))) {
      failField(collection, req, [{ message: 'این والد، دور در سلسله‌مراتب رکوردها می‌سازد.', path: 'parent' }])
    }
  }

  // --- Media named by the write itself ---------------------------------------
  const assertOwnMedia = async (ids: (string | null)[], path: string): Promise<void> => {
    for (const mediaId of ids) {
      if (!mediaId) continue
      const media = await findOnSite(req, 'media', mediaId, siteId, { filename: true })
      if (!media) {
        failField(collection, req, [
          { message: 'رسانه انتخاب‌شده متعلق به این سایت نیست.', path },
        ])
      }
    }
  }

  if ('heroImage' in data) await assertOwnMedia([idOf(data.heroImage)], 'heroImage')
  if ('ogImage' in data) await assertOwnMedia([idOf(data.ogImage)], 'ogImage')
  if (Array.isArray(data.gallery)) {
    await assertOwnMedia((data.gallery as unknown[]).map(idOf), 'gallery')
  }

  // --- Typed field values ------------------------------------------------------
  const schema = (typeDef!.fieldSchema ?? []) as CustomFieldDefinition[]
  const typeChanged =
    Boolean(originalDoc) && idOf(originalDoc!.contentType) !== contentTypeId
  const valuesToCheck =
    'fieldValues' in data ? data.fieldValues : typeChanged ? originalDoc?.fieldValues : undefined

  if (valuesToCheck !== undefined) {
    const { errors } = validateFieldValues(schema, valuesToCheck)

    if (errors.length) {
      failField(
        collection,
        req,
        errors.map((error) => ({
          message: error.message,
          path: error.path ? `fieldValues.${error.path}` : 'fieldValues',
        })),
      )
    }

    const { known, unknown } = splitKnownValues(schema, valuesToCheck)

    next.fieldValues = known
    if (Object.keys(unknown).length) {
      next.unmappedMeta = { ...asObject(originalDoc?.unmappedMeta), ...unknown }
    }
    next.searchText = searchableTextForValues(schema, known)

    await assertOwnMedia(mediaIdsInValues(schema, known), 'fieldValues')

    for (const ref of relationshipRefsInValues(schema, known)) {
      for (const targetId of ref.ids) {
        const target = await findOnSite(req, ref.collection, targetId, siteId, { id: true } as never)
        if (!target) {
          failField(collection, req, [
            {
              message: `سند پیوسته (${ref.collection}/${targetId}) متعلق به این سایت نیست.`,
              path: 'fieldValues',
            },
          ])
        }
      }
    }
  }

  // --- First publish timestamp -------------------------------------------------
  if (
    data.status === 'published' &&
    !data.publishedAt &&
    !originalDoc?.publishedAt
  ) {
    next.publishedAt = new Date().toISOString()
  }

  return next as typeof data
}
