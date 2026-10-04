import type { CollectionBeforeChangeHook, CollectionSlug, Field, Plugin } from 'payload'

import { APIError } from 'payload'
import { TENANT_MEDIA_UPLOAD_FIELD } from '@/admin/fields/mediaUploadComponentPath'
import { idOf } from '@/lib/ids'

type FieldRecord = Record<string, unknown>
type DataRecord = Record<string, unknown>

const isRecord = (value: unknown): value is DataRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const fieldsOf = (value: unknown): Field[] => Array.isArray(value) ? value as Field[] : []

const isTenantUpload = (field: FieldRecord): boolean =>
  field.type === 'upload' && field.relationTo === 'media'

const mapMediaFields = (fields: Field[]): Field[] =>
  fields.map((input) => {
    const field = input as unknown as FieldRecord
    let next = input

    if (isTenantUpload(field)) {
      const admin = isRecord(field.admin) ? field.admin : {}
      const components = isRecord(admin.components) ? admin.components : {}
      next = {
        ...input,
        admin: {
          ...admin,
          components: {
            ...components,
            // One client field component serves every site-owned upload field. That
            // includes nested block/SEO fields, and keeps new fields on the same path.
            Field: TENANT_MEDIA_UPLOAD_FIELD,
          },
        },
      } as Field
    }

    const record = next as unknown as FieldRecord
    if (record.type === 'tabs' && Array.isArray(record.tabs)) {
      return {
        ...next,
        tabs: record.tabs.map((tab) => {
          if (!isRecord(tab)) return tab
          return { ...tab, fields: mapMediaFields(fieldsOf(tab.fields)) }
        }),
      } as Field
    }

    if (record.type === 'blocks' && Array.isArray(record.blocks)) {
      return {
        ...next,
        blocks: record.blocks.map((block) => {
          if (!isRecord(block)) return block
          return { ...block, fields: mapMediaFields(fieldsOf(block.fields)) }
        }),
      } as Field
    }

    if (['array', 'collapsible', 'group', 'row'].includes(String(record.type))) {
      return { ...next, fields: mapMediaFields(fieldsOf(record.fields)) } as Field
    }

    return next
  })

const extractMediaIDs = (value: unknown, into: Set<string>): void => {
  if (value === null || value === undefined || value === '') return
  if (Array.isArray(value)) {
    for (const item of value) extractMediaIDs(item, into)
    return
  }
  if (typeof value === 'string' || typeof value === 'number') {
    into.add(String(value))
    return
  }
  if (!isRecord(value)) return

  if ('value' in value) {
    extractMediaIDs(value.value, into)
  } else if ('id' in value) {
    extractMediaIDs(value.id, into)
  } else {
    // Localized values can be keyed by locale rather than represented as a single ID.
    for (const nested of Object.values(value)) extractMediaIDs(nested, into)
  }
}

const collectLexicalMediaRefs = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectLexicalMediaRefs(item, into)
    return
  }
  if (!isRecord(value)) return

  // Lexical's BlocksFeature serializes `mediaBlock` as a block node whose fields
  // contain the upload ID. The editor schema is not represented as a Payload
  // `blocks` field, so validate that one reusable media relation explicitly.
  if (isRecord(value.fields) && value.fields.blockType === 'mediaBlock' && 'media' in value.fields) {
    extractMediaIDs(value.fields.media, into)
  }
  for (const nested of Object.values(value)) collectLexicalMediaRefs(nested, into)
}

const collectFromFields = (fields: Field[], record: unknown, into: Set<string>): void => {
  if (!isRecord(record)) return

  for (const input of fields) {
    const field = input as unknown as FieldRecord
    const fieldName = typeof field.name === 'string' ? field.name : undefined
    const fieldValue = fieldName ? record[fieldName] : record

    if (isTenantUpload(field)) {
      extractMediaIDs(fieldValue, into)
      continue
    }

    switch (field.type) {
      case 'richText':
        collectLexicalMediaRefs(fieldValue, into)
        break
      case 'group':
        collectFromFields(fieldsOf(field.fields), fieldValue, into)
        break
      case 'array':
        if (Array.isArray(fieldValue)) {
          for (const row of fieldValue) collectFromFields(fieldsOf(field.fields), row, into)
        }
        break
      case 'blocks':
        if (Array.isArray(fieldValue)) {
          for (const row of fieldValue) {
            if (!isRecord(row) || typeof row.blockType !== 'string') continue
            const block = fieldsOf(field.blocks).find((candidate) =>
              (candidate as unknown as FieldRecord).slug === row.blockType,
            ) as unknown as FieldRecord | undefined
            if (block) collectFromFields(fieldsOf(block.fields), row, into)
          }
        }
        break
      case 'tabs':
        if (Array.isArray(field.tabs)) {
          for (const tab of field.tabs) {
            if (!isRecord(tab)) continue
            const tabValue = typeof tab.name === 'string' && isRecord(fieldValue)
              ? fieldValue[tab.name]
              : record
            collectFromFields(fieldsOf(tab.fields), tabValue, into)
          }
        }
        break
      case 'collapsible':
      case 'row':
        collectFromFields(fieldsOf(field.fields), record, into)
        break
      default:
        break
    }
  }
}

export const collectTenantMediaIDs = (fields: Field[], record: unknown): string[] => {
  const ids = new Set<string>()
  collectFromFields(fields, record, ids)
  return [...ids]
}

const mergeData = (original: unknown, incoming: unknown): unknown => {
  if (incoming === undefined) return original
  if (Array.isArray(incoming)) return incoming
  if (!isRecord(incoming) || !isRecord(original)) return incoming

  const merged: DataRecord = { ...original }
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = key in original ? mergeData(original[key], value) : value
  }
  return merged
}

const assertMediaBelongsToSite: CollectionBeforeChangeHook = async ({
  collection: currentCollection,
  data,
  originalDoc,
  req,
}) => {
  const collection = req.payload.config.collections.find((item) => item.slug === 'media')
  const foldersConfig = req.payload.config.folders as { fieldName?: string; slug?: string } | undefined
  const folderFieldName = foldersConfig?.fieldName || 'folder'
  const dataRecord = data as DataRecord | undefined
  const originalRecord = originalDoc as DataRecord | undefined
  const siteValue = dataRecord && Object.prototype.hasOwnProperty.call(dataRecord, 'site')
    ? dataRecord.site
    : originalRecord?.site
  const siteID = idOf(siteValue)
  const existingMedia = collection?.fields
    ? collectTenantMediaIDs(collection.fields, mergeData(originalDoc, data))
    : []

  if (!siteID && existingMedia.length) {
    throw new APIError('Media selections must belong to the current site.', 400)
  }

  if (siteID && existingMedia.length) {
    const ids = existingMedia
    const { docs } = await req.payload.find({
      collection: 'media',
      depth: 0,
      limit: ids.length,
      overrideAccess: true,
      pagination: false,
      req,
      select: { site: true },
      where: { id: { in: ids } },
    })

    if (docs.length !== ids.length || docs.some((doc) => idOf(doc.site) !== siteID)) {
      // Do not echo the foreign IDs or owning site back to a caller.
      throw new APIError('Media selections must belong to the current site.', 400)
    }
  }

  if (currentCollection.slug === 'media') {
    const effectiveData = mergeData(originalDoc, data) as DataRecord
    const folderID = idOf(effectiveData[folderFieldName])
    if (folderID) {
      try {
        const folderCollection = (foldersConfig?.slug || 'payload-folders') as CollectionSlug
        const folder = await req.payload.findByID({
          collection: folderCollection,
          depth: 0,
          id: folderID,
          overrideAccess: true,
          req,
          select: { folderType: true, site: true },
        })
        const folderRecord = folder as { folderType?: unknown; site?: unknown }
        const folderTypes = folderRecord.folderType
        const acceptsMedia =
          !Array.isArray(folderTypes) || folderTypes.length === 0 || folderTypes.includes('media')
        if (!siteID || idOf(folderRecord.site) !== siteID || !acceptsMedia) {
          throw new APIError('The selected folder does not belong to this site.', 400)
        }
      } catch (error) {
        if (error instanceof APIError) throw error
        throw new APIError('The selected folder does not belong to this site.', 400)
      }
    }
  }

  return data
}

const hasTenantField = (fields: Field[]): boolean =>
  fields.some((field) => (field as unknown as FieldRecord).name === 'site')

const hasMediaUpload = (fields: Field[]): boolean => {
  for (const input of fields) {
    const field = input as unknown as FieldRecord
    if (isTenantUpload(field) || field.type === 'richText') return true
    if (field.type === 'tabs' && Array.isArray(field.tabs)) {
      if (field.tabs.some((tab) => isRecord(tab) && hasMediaUpload(fieldsOf(tab.fields)))) return true
    }
    if (field.type === 'blocks' && Array.isArray(field.blocks)) {
      if (field.blocks.some((block) => isRecord(block) && hasMediaUpload(fieldsOf(block.fields)))) return true
    }
    if (['array', 'collapsible', 'group', 'row'].includes(String(field.type)) && hasMediaUpload(fieldsOf(field.fields))) {
      return true
    }
  }
  return false
}

/**
 * Site-owned upload fields share one folder-aware picker. Writes also validate every
 * media relation against the destination site's actual media rows, so a caller cannot
 * bypass the picker and attach another tenant's file through REST, GraphQL, or Local API.
 */
export const tenantMediaPicker: Plugin = (config) => ({
  ...config,
  collections: config.collections?.map((collection) => {
    const fields = collection.fields ?? []
    const isTenantScoped = hasTenantField(fields)
    const hasMediaField = hasMediaUpload(fields)

    if (!isTenantScoped || !hasMediaField) return collection

    return {
      ...collection,
      fields: mapMediaFields(fields),
      hooks: {
        ...collection.hooks,
        beforeChange: [...(collection.hooks?.beforeChange ?? []), assertMediaBelongsToSite],
      },
    }
  }).map((collection) => {
    if (collection.slug !== 'media') return collection

    return {
      ...collection,
      hooks: {
        ...collection.hooks,
        beforeChange: [...(collection.hooks?.beforeChange ?? []), assertMediaBelongsToSite],
      },
    }
  }),
})
