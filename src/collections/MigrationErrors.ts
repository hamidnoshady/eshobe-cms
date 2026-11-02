import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * The dead-letter queue: records that could not be imported, archived or
 * proven blocked cleanly. An open error blocks reconciliation and therefore
 * cutover — a migration is never "done except for a few rows nobody saw".
 */
export const MigrationErrors: CollectionConfig = {
  slug: 'migration-errors',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'code' },
  labels: { plural: 'خطاهای مهاجرت', singular: 'خطای مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'کار', relationTo: 'migration-jobs' },
    { name: 'batch', type: 'relationship', label: 'بسته', relationTo: 'migration-batches' },
    { name: 'source', type: 'relationship', label: 'مبدأ', relationTo: 'migration-sources' },
    { name: 'record', type: 'relationship', label: 'رکورد دفتر', relationTo: 'migration-records' },
    { name: 'resource', type: 'text', label: 'منبع', index: true },
    { name: 'sourceRecordId', type: 'text', label: 'شناسه مبدأ', index: true },
    { name: 'code', type: 'text', label: 'کد خطا', index: true, required: true },
    { name: 'message', type: 'textarea', label: 'شرح', required: true },
    { name: 'retryable', type: 'checkbox', label: 'قابل تلاش دوباره', defaultValue: true },
    { name: 'attempts', type: 'number', label: 'تلاش‌ها', defaultValue: 1, min: 0 },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'open',
      options: [
        { label: 'باز', value: 'open' },
        { label: 'حل‌شده', value: 'resolved' },
        { label: 'نادیده گرفته‌شده با تصمیم مالک', value: 'ignored' },
      ],
      required: true,
    },
    { name: 'details', type: 'json', label: 'جزئیات' },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
