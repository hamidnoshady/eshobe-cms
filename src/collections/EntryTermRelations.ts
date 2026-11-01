import type { CollectionConfig } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { authenticatedOrSourceEntryPublished } from '../access/entryPublished'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import { migrationSourceField } from './fields/migrationSource'
import { validateEntryTermRelation } from './hooks/validateEntryTermRelation'

/**
 * The explicit entry↔term edge (issue #166 §2): unique per {site, entry,
 * term}, with the taxonomy denormalized for one-query term filtering and the
 * edge's own provenance — the shape term-filtered theme queries and the
 * migration's association reconciliation both need, which a bare `hasMany`
 * join table cannot carry.
 *
 * Public read is deliberate and narrower still: a row here exposes only
 * that two ids are associated, and even that is hidden until the entry
 * itself is published (`authenticatedOrSourceEntryPublished`).
 */
export const EntryTermRelations: CollectionConfig = {
  slug: 'entry-term-relations',
  access: {
    create: apiKeyCreateAware(authenticated),
    delete: apiKeyAware(authenticated),
    read: apiKeyAware(scopedPublicRead(authenticatedOrSourceEntryPublished('entry'))),
    update: apiKeyUpdateAware(authenticated),
  },
  admin: {
    defaultColumns: ['entry', 'term', 'taxonomy', 'menuOrder', 'updatedAt'],
    description: 'پیوند هر رکورد محتوا با واژه‌های طبقه‌بندی‌اش؛ هر جفت (رکورد، واژه) فقط یک‌بار.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
  },
  labels: {
    plural: 'پیوندهای محتوا–واژه',
    singular: 'پیوند محتوا–واژه',
  },
  fields: [
    {
      name: 'entry',
      type: 'relationship',
      label: 'رکورد محتوا',
      index: true,
      relationTo: 'content-entries',
      required: true,
    },
    {
      name: 'term',
      type: 'relationship',
      label: 'واژه',
      index: true,
      relationTo: 'taxonomy-terms',
      required: true,
    },
    {
      name: 'taxonomy',
      type: 'relationship',
      label: 'طبقه‌بندی (از روی واژه)',
      admin: {
        description: 'خودکار از طبقه‌بندی خود واژه پر می‌شود؛ برای پالایش سریع بر اساس طبقه‌بندی.',
      },
      index: true,
      relationTo: 'taxonomy-definitions',
      required: true,
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
    beforeValidate: [validateEntryTermRelation],
  },
}
