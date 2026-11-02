import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * The human-reviewed mapping between a source resource/field and its Eshobe
 * destination. The engine writes `proposed` rows from discovery + the dry
 * run; the wizard confirms or rejects them. Import treats an
 * `unsupported-blocking` row as a stop sign for that resource, and cutover
 * treats an unresolved one the same way.
 */
export const MigrationMappings: CollectionConfig = {
  slug: 'migration-mappings',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'resource' },
  labels: { plural: 'نگاشت‌های مهاجرت', singular: 'نگاشت مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'کار', relationTo: 'migration-jobs', required: true },
    { name: 'source', type: 'relationship', label: 'مبدأ', relationTo: 'migration-sources' },
    { name: 'resource', type: 'text', label: 'منبع مبدأ', index: true, required: true },
    { name: 'sourceField', type: 'text', label: 'فیلد مبدأ', index: true },
    { name: 'destination', type: 'text', label: 'مقصد در ای‌شوب', required: true },
    {
      name: 'disposition',
      type: 'select',
      label: 'تکلیف پوشش',
      defaultValue: 'requires-mapping',
      options: [
        { label: 'پشتیبانی‌شده', value: 'supported' },
        { label: 'نیازمند نگاشت', value: 'requires-mapping' },
        { label: 'مسدودِ پشتیبانی‌نشده', value: 'unsupported-blocking' },
        { label: 'فقط بایگانی', value: 'archive-only' },
        { label: 'حذف‌شده از مهاجرت', value: 'excluded' },
      ],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت بازبینی',
      defaultValue: 'proposed',
      options: [
        { label: 'پیشنهاد موتور', value: 'proposed' },
        { label: 'تأییدشده', value: 'confirmed' },
        { label: 'ردشده', value: 'rejected' },
      ],
      required: true,
    },
    { name: 'transform', type: 'json', label: 'تبدیل/گزینه‌های نگاشت' },
    { name: 'reason', type: 'textarea', label: 'دلیل' },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
