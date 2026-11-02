import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * The importer's human-readable timeline. Messages are plain language and
 * must never carry a credential, a raw payload or customer PII — the engine
 * sanitizes before writing (`src/lib/migration/records.ts`).
 */
export const MigrationEvents: CollectionConfig = {
  slug: 'migration-events',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'eventType' },
  labels: { plural: 'رویدادهای مهاجرت', singular: 'رویداد مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'کار', relationTo: 'migration-jobs' },
    { name: 'source', type: 'relationship', label: 'مبدأ', relationTo: 'migration-sources' },
    { name: 'eventType', type: 'text', label: 'گونه رویداد', index: true, required: true },
    {
      name: 'level',
      type: 'select',
      label: 'سطح',
      defaultValue: 'info',
      options: [
        { label: 'اطلاع', value: 'info' },
        { label: 'هشدار', value: 'warning' },
        { label: 'خطا', value: 'error' },
      ],
      required: true,
    },
    { name: 'resource', type: 'text', label: 'منبع', index: true },
    { name: 'sourceRecordId', type: 'text', label: 'شناسه مبدأ', index: true },
    { name: 'message', type: 'textarea', label: 'پیام', required: true },
    { name: 'details', type: 'json', label: 'جزئیات' },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
