import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, parentChainOf, siteIdOfWrite } from './contentSameSite'

/**
 * Term-tree integrity (issue #166 §2): the taxonomy is this site's, a parent
 * exists only inside a hierarchical taxonomy, belongs to that same taxonomy
 * and site, and never closes a cycle. A flat (tag-like) taxonomy accepting
 * parents would quietly grow a tree its archive routes do not render.
 */
export const validateTaxonomyTerm: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const siteId = siteIdOfWrite(data, originalDoc)
  const taxonomyId = idOf(data.taxonomy ?? originalDoc?.taxonomy)

  if (!siteId || !taxonomyId) return data

  const taxonomy = await findOnSite(req, 'taxonomy-definitions', taxonomyId, siteId, {
    hierarchical: true,
    key: true,
  })

  if (!taxonomy) {
    failField(collection, req, [
      { message: 'طبقه‌بندی انتخاب‌شده متعلق به این سایت نیست.', path: 'taxonomy' },
    ])
  }

  const parentId = idOf(Object.hasOwn(data, 'parent') ? data.parent : originalDoc?.parent)

  if (parentId) {
    if (taxonomy!.hierarchical !== true) {
      failField(collection, req, [
        {
          message: 'این طبقه‌بندی تخت (برچسب‌گونه) است و واژه والد نمی‌پذیرد.',
          path: 'parent',
        },
      ])
    }

    const parent = await findOnSite(req, 'taxonomy-terms', parentId, siteId, {
      taxonomy: true,
    })

    if (!parent) {
      failField(collection, req, [
        { message: 'واژه والد متعلق به این سایت نیست.', path: 'parent' },
      ])
    }
    if (idOf(parent!.taxonomy) !== taxonomyId) {
      failField(collection, req, [
        { message: 'واژه والد باید از همان طبقه‌بندی باشد.', path: 'parent' },
      ])
    }

    const ownId = originalDoc?.id ? String(originalDoc.id) : null
    if (ownId && parentId === ownId) {
      failField(collection, req, [{ message: 'واژه نمی‌تواند والد خودش باشد.', path: 'parent' }])
    }
    if (ownId) {
      const chain = await parentChainOf(req, 'taxonomy-terms', parentId, siteId)
      if (chain.includes(ownId)) {
        failField(collection, req, [
          { message: 'این والد، دور در درخت واژه‌ها می‌سازد.', path: 'parent' },
        ])
      }
    }
  }

  return data
}
