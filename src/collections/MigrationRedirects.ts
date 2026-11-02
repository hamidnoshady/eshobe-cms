import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * The migration URL inventory: every public WordPress URL that moved, where
 * it lands now, and whether that rule is live in the site's `redirects`.
 * Conflicts (the old path already points elsewhere) are kept visible here
 * instead of overwriting an editor's rule; reconciliation refuses cutover
 * while one is open.
 */
export const MigrationRedirects: CollectionConfig = {
  slug: 'migration-redirects',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'fromUrl' },
  labels: { plural: 'تغییرمسیرهای مهاجرت', singular: 'تغییرمسیر مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'کار', relationTo: 'migration-jobs' },
    { name: 'source', type: 'relationship', label: 'مبدأ', relationTo: 'migration-sources' },
    { name: 'record', type: 'relationship', label: 'رکورد دفتر', relationTo: 'migration-records' },
    { name: 'fromUrl', type: 'text', label: 'از مسیر', index: true, required: true },
    { name: 'toUrl', type: 'text', label: 'به مسیر', required: true },
    { name: 'resource', type: 'text', label: 'منبع', index: true },
    { name: 'sourceRecordId', type: 'text', label: 'شناسه مبدأ', index: true },
    { name: 'destinationCollection', type: 'text', label: 'مجموعه مقصد' },
    { name: 'destinationId', type: 'text', label: 'شناسه مقصد' },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'proposed',
      options: [
        { label: 'پیشنهاد', value: 'proposed' },
        { label: 'اعمال‌شده', value: 'applied' },
        { label: 'نشانی بی‌تغییر', value: 'unchanged' },
        { label: 'ناسازگار', value: 'conflict' },
        { label: 'نادیده گرفته‌شده', value: 'ignored' },
        { label: 'برگردانده‌شده', value: 'rolled-back' },
      ],
      required: true,
    },
    { name: 'redirect', type: 'relationship', label: 'قاعده تغییرمسیر سایت', relationTo: 'redirects' },
    { name: 'message', type: 'textarea', label: 'توضیح' },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
