import type { CollectionConfig } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { authenticatedOrSourceEntryPublished } from '../access/entryPublished'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import { isMachineKey, machineKeyMessage } from '@/lib/content-paths'
import { migrationSourceField } from './fields/migrationSource'
import { validateContentRelation } from './hooks/validateContentRelation'

const targetCondition = (collection: string) => (_data: unknown, siblingData: { targetCollection?: string }) =>
  siblingData?.targetCollection === collection

/**
 * Typed document-to-document edges from a content entry (issue #166 §2) —
 * ACF relationship fields, cross-CPT references, "related product" and the
 * like, preserved *as edges* rather than flattened into text. `relationKind`
 * is the source field/slot name (`acf:related_projects`, `related`, …), so
 * semantically different relations between the same two documents stay
 * distinguishable and ordered.
 */
export const ContentRelations: CollectionConfig = {
  slug: 'content-relations',
  access: {
    create: apiKeyCreateAware(authenticated),
    delete: apiKeyAware(authenticated),
    // Ids and edge kinds only, and only while the source entry is public;
    // target visibility stays with each target collection's own read access.
    read: apiKeyAware(scopedPublicRead(authenticatedOrSourceEntryPublished('fromEntry'))),
    update: apiKeyUpdateAware(authenticated),
  },
  admin: {
    defaultColumns: ['fromEntry', 'relationKind', 'targetCollection', 'menuOrder', 'updatedAt'],
    description: 'رابطه تایپ‌دار رکورد محتوا با سند دیگر (رکورد، محصول، نوشته، برگه یا رسانه همین سایت).',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
  },
  labels: {
    plural: 'رابطه‌های محتوا',
    singular: 'رابطه محتوا',
  },
  fields: [
    {
      name: 'fromEntry',
      type: 'relationship',
      label: 'رکورد مبدأ رابطه',
      index: true,
      relationTo: 'content-entries',
      required: true,
    },
    {
      name: 'relationKind',
      type: 'text',
      label: 'گونه رابطه',
      admin: {
        description: 'کلید ماشینی شکاف رابطه؛ مثل related یا acf:related_projects (بخش پس از دونقطه کلید فیلد مبدأست).',
      },
      index: true,
      required: true,
      validate: (value: string | null | undefined) => {
        if (!value) return true
        const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value
        return isMachineKey(tail) ? true : machineKeyMessage
      },
    },
    {
      name: 'targetCollection',
      type: 'select',
      label: 'مجموعه مقصد',
      defaultValue: 'content-entries',
      options: [
        { label: 'محتوای سفارشی', value: 'content-entries' },
        { label: 'محصول', value: 'products' },
        { label: 'نوشته', value: 'posts' },
        { label: 'برگه', value: 'pages' },
        { label: 'رسانه', value: 'media' },
      ],
      required: true,
    },
    {
      name: 'targetEntry',
      type: 'relationship',
      label: 'رکورد مقصد',
      admin: { condition: targetCondition('content-entries') },
      relationTo: 'content-entries',
    },
    {
      name: 'targetProduct',
      type: 'relationship',
      label: 'محصول مقصد',
      admin: { condition: targetCondition('products') },
      relationTo: 'products',
    },
    {
      name: 'targetPost',
      type: 'relationship',
      label: 'نوشته مقصد',
      admin: { condition: targetCondition('posts') },
      relationTo: 'posts',
    },
    {
      name: 'targetPage',
      type: 'relationship',
      label: 'برگه مقصد',
      admin: { condition: targetCondition('pages') },
      relationTo: 'pages',
    },
    {
      name: 'targetMedia',
      type: 'relationship',
      label: 'رسانه مقصد',
      admin: { condition: targetCondition('media') },
      relationTo: 'media',
    },
    {
      name: 'menuOrder',
      type: 'number',
      label: 'ترتیب',
      defaultValue: 0,
    },
    migrationSourceField(),
  ],
  hooks: {
    beforeChange: [forceApiKeySite],
    beforeValidate: [validateContentRelation],
  },
}
