import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * One page of one resource within one importer run. Batches are the
 * resume/checkpoint unit: a crashed import restarts from the first
 * un-completed batch, and per-record idempotency keys make re-applying a
 * half-applied page safe.
 */
export const MigrationBatches: CollectionConfig = {
  slug: 'migration-batches',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'resource' },
  labels: { plural: 'بسته‌های مهاجرت', singular: 'بسته مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'کار', relationTo: 'migration-jobs', required: true },
    { name: 'source', type: 'relationship', label: 'مبدأ', relationTo: 'migration-sources' },
    { name: 'runId', type: 'text', label: 'شناسه اجرا', index: true, required: true },
    { name: 'resource', type: 'text', label: 'منبع داده', index: true, required: true },
    { name: 'page', type: 'number', label: 'صفحه', min: 1, required: true },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'running',
      options: [
        { label: 'در حال اجرا', value: 'running' },
        { label: 'تکمیل‌شده', value: 'completed' },
        { label: 'خطادار', value: 'failed' },
        { label: 'متوقف', value: 'paused' },
        { label: 'لغوشده', value: 'cancelled' },
      ],
      required: true,
    },
    {
      name: 'counts',
      type: 'group',
      label: 'شمارنده‌ها',
      fields: [
        { name: 'seen', type: 'number', label: 'دیده‌شده', defaultValue: 0 },
        { name: 'imported', type: 'number', label: 'واردشده', defaultValue: 0 },
        { name: 'updated', type: 'number', label: 'به‌روزشده', defaultValue: 0 },
        { name: 'unchanged', type: 'number', label: 'بی‌تغییر', defaultValue: 0 },
        { name: 'archived', type: 'number', label: 'بایگانی‌شده', defaultValue: 0 },
        { name: 'blocked', type: 'number', label: 'مسدود', defaultValue: 0 },
        { name: 'errors', type: 'number', label: 'خطادار', defaultValue: 0 },
      ],
    },
    { name: 'checkpoint', type: 'json', label: 'نقطه ادامه' },
    { name: 'startedAt', type: 'date', label: 'شروع' },
    { name: 'finishedAt', type: 'date', label: 'پایان' },
    { name: 'error', type: 'textarea', label: 'خطا' },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
