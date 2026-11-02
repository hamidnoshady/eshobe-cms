import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * The idempotency ledger: one row per `(site, installation, resource, source
 * id)`. Every importer write is an upsert keyed here, every re-run proves
 * "zero duplicates" against here, rollback unwinds from here, and
 * reconciliation compares the live source against here. The raw payload is
 * the redacted source record (credentials and secret-shaped keys removed)
 * and is not readable over the API — orders and customers carry PII, and the
 * destination documents are the operational copy.
 */
export const MigrationRecords: CollectionConfig = {
  slug: 'migration-records',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'idempotencyKey' },
  labels: { plural: 'دفتر رکوردهای مهاجرت', singular: 'رکورد مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'آخرین کار', relationTo: 'migration-jobs' },
    {
      name: 'source',
      type: 'relationship',
      label: 'مبدأ',
      relationTo: 'migration-sources',
      required: true,
    },
    {
      name: 'idempotencyKey',
      type: 'text',
      label: 'کلید یکتایی',
      index: true,
      required: true,
      unique: true,
    },
    { name: 'installation', type: 'text', label: 'اثر انگشت نصب', index: true, required: true },
    { name: 'resource', type: 'text', label: 'منبع مبدأ', index: true, required: true },
    { name: 'sourceRecordId', type: 'text', label: 'شناسه در مبدأ', index: true, required: true },
    { name: 'sourceSlug', type: 'text', label: 'پیوسته‌نام مبدأ' },
    { name: 'sourcePermalink', type: 'textarea', label: 'نشانی دائمی مبدأ' },
    { name: 'sourceModifiedAt', type: 'date', label: 'ویرایش مبدأ', index: true },
    { name: 'contentHash', type: 'text', label: 'هش محتوا', index: true },
    { name: 'destinationCollection', type: 'text', label: 'مجموعه مقصد', index: true },
    { name: 'destinationId', type: 'text', label: 'شناسه مقصد', index: true },
    {
      name: 'disposition',
      type: 'select',
      label: 'تکلیف',
      defaultValue: 'blocked',
      options: [
        { label: 'برنامه‌ریزی‌شده در اجرای خشک', value: 'planned' },
        { label: 'واردشده', value: 'imported' },
        { label: 'به‌روزشده', value: 'updated' },
        { label: 'بی‌تغییر', value: 'unchanged' },
        { label: 'بایگانی با منشأ', value: 'archived' },
        { label: 'مسدود', value: 'blocked' },
        { label: 'خطادار', value: 'error' },
        { label: 'حذف‌شده در مبدأ', value: 'deleted' },
        { label: 'برگردانده‌شده', value: 'rolled-back' },
      ],
      required: true,
    },
    {
      name: 'createdByMigration',
      type: 'checkbox',
      label: 'سند مقصد ساخته مهاجرت است',
      admin: {
        description: 'بازگشت فقط سندهایی را حذف می‌کند که مهاجرت ساخته، نه سندهای موجودی که به منشأ پیوند خورده‌اند.',
      },
      defaultValue: false,
    },
    { name: 'destinationUpdatedAt', type: 'date', label: 'آخرین ویرایش مقصد هنگام ورود' },
    { name: 'attempts', type: 'number', label: 'تلاش‌ها', defaultValue: 0, min: 0 },
    { name: 'lastError', type: 'textarea', label: 'آخرین خطا' },
    { name: 'metadata', type: 'json', label: 'فراداده اجرایی' },
    {
      name: 'rawPayload',
      type: 'json',
      label: 'بار خام پالوده مبدأ',
      access: { create: noDirectWrite, read: noDirectWrite, update: noDirectWrite },
    },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
