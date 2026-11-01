import type { CollectionBeforeValidateHook } from 'payload'

import { validateFieldSchema } from '@/lib/custom-fields'
import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

/**
 * A content type definition must be internally valid before any entry trusts
 * it: its `fieldSchema` passes the pure schema validator, and every taxonomy
 * it links belongs to the same site (a definition wired to another tenant's
 * taxonomy would leak that taxonomy into this site's term pickers and
 * validation). Runs before field validation, so absent optional inputs are
 * left for Payload's own checks.
 */
export const validateContentTypeDefinition: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  if (Array.isArray(data.fieldSchema)) {
    const errors = validateFieldSchema(data.fieldSchema)
    if (errors.length) failField(collection, req, errors)
  }

  const siteId = siteIdOfWrite(data, originalDoc)

  if (siteId && Array.isArray(data.taxonomies)) {
    for (const raw of data.taxonomies as unknown[]) {
      const taxonomyId = idOf(raw)
      if (!taxonomyId) continue
      const taxonomy = await findOnSite(req, 'taxonomy-definitions', taxonomyId, siteId, {
        key: true,
      })
      if (!taxonomy) {
        failField(collection, req, [
          {
            message: 'یکی از طبقه‌بندی‌های پیوسته متعلق به این سایت نیست.',
            path: 'taxonomies',
          },
        ])
      }
    }
  }

  return data
}
