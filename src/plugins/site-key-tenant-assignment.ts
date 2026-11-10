import type { CollectionBeforeValidateHook, PayloadRequest, Plugin, RelationshipFieldSingleValidation, SingleRelationshipField } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'

const KEYED_COLLECTIONS = new Set(['products', 'taxonomy-definitions', 'taxonomy-terms'])

/**
 * The multi-tenant plugin validates an assigned site against `req.user`. A site
 * API key is a separate principal and names exactly one site; it has no `user`.
 * For that *same* site only, let the plugin's own validators evaluate an internal
 * userless request. This shadow request never mutates the real REST/GraphQL request,
 * so failures, sibling operations, other sites and ordinary users retain the
 * original validation and access rules.
 */
const validationRequest = (req: PayloadRequest): PayloadRequest => new Proxy(req, {
  get(target, property) {
    if (property === 'payloadAPI') return 'local'
    if (property === 'user') return null
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

const keyOwns = async (req: PayloadRequest, value: unknown): Promise<boolean> => {
  const key = await requestApiKey(req)
  return Boolean(key?.role === 'site' && key.siteId && idOf(value) === key.siteId)
}

/** Install immediately after multiTenantPlugin, which appends its membership hook. */
export const siteKeyTenantAssignment: Plugin = (config) => ({
  ...config,
  collections: config.collections?.map((collection) => {
    if (!KEYED_COLLECTIONS.has(collection.slug)) return collection
    const hooks = collection.hooks?.beforeValidate ?? []
    const membership = hooks.at(-1)
    const siteField = collection.fields.find((field) => 'name' in field && field.name === 'site' && field.type === 'relationship')
    if (!membership || !siteField || siteField.type !== 'relationship' || siteField.hasMany || siteField.relationTo !== 'sites' || typeof siteField.validate !== 'function') {
      throw new Error(`Missing multi-tenant validation for ${collection.slug}`)
    }

    const validateSite = siteField.validate as RelationshipFieldSingleValidation
    const keyAwareSite: RelationshipFieldSingleValidation = async (value, options) => {
      if (await keyOwns(options.req, value)) {
        return validateSite(value, { ...options, req: validationRequest(options.req) })
      }
      return validateSite(value, options)
    }
    const keyAwareMembership: CollectionBeforeValidateHook = async (args) => {
      if (await keyOwns(args.req, args.data?.site)) {
        return membership({ ...args, req: validationRequest(args.req) })
      }
      return membership(args)
    }
    const keyAwareSiteField: SingleRelationshipField = { ...siteField, validate: keyAwareSite }
    return {
      ...collection,
      fields: collection.fields.map((field) => field === siteField ? keyAwareSiteField : field),
      hooks: { ...collection.hooks, beforeValidate: [...hooks.slice(0, -1), keyAwareMembership] },
    }
  }),
})
