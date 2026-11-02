import type { CollectionConfig } from 'payload'

import { hiddenFromOperators } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import {
  encryptMigrationSecrets,
  maskMigrationSecret,
} from './hooks/migrationSecrets'
import { validateMigrationSource } from './hooks/validateMigrationSource'

const noDirectWrite = () => false
const secretAccess = { create: noDirectWrite, read: noDirectWrite, update: noDirectWrite }

/**
 * One WordPress/WooCommerce installation a site may migrate from.
 *
 * Created only through the Migration Center endpoint (`src/endpoints/migration.ts`),
 * which owns the site from the caller's membership, DNS-checks the URL and
 * encrypts the credentials — direct collection writes are refused so a pasted
 * application password can never take an unencrypted path into the row. The
 * `installation` fingerprint is a segment of every idempotency key the
 * importer writes (`migration-records`), so a source row is never repointed
 * at a different WordPress: a different install is a different row.
 */
export const MigrationSources: CollectionConfig = {
  slug: 'migration-sources',
  access: {
    create: noDirectWrite,
    delete: noDirectWrite,
    read: authenticated,
    update: noDirectWrite,
  },
  admin: {
    defaultColumns: ['name', 'baseUrl', 'status', 'lastCheckedAt'],
    description:
      'اتصال‌های وردپرس/ووکامرس این سایت. ساخت و ویرایش از «مرکز مهاجرت» انجام می‌شود؛ اعتبارنامه‌ها رمزشده‌اند و هرگز نمایش داده نمی‌شوند.',
    group: 'مهاجرت',
    hidden: hiddenFromOperators,
    useAsTitle: 'name',
  },
  labels: { plural: 'مبدأهای مهاجرت', singular: 'مبدأ مهاجرت' },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام',
      required: true,
    },
    {
      name: 'baseUrl',
      type: 'text',
      label: 'نشانی پایه وردپرس',
      admin: { description: 'فقط HTTPS روی دامنه عمومی؛ نشانی داخلی یا خصوصی پذیرفته نمی‌شود.' },
      index: true,
      required: true,
    },
    {
      name: 'installation',
      type: 'text',
      label: 'اثر انگشت نصب',
      admin: {
        description:
          'شناسه پایدار همین نصب وردپرس؛ بخشی از کلید یکتایی هر رکورد واردشده است و بعد از نخستین ورود تغییر نمی‌کند.',
        readOnly: true,
      },
      access: { update: noDirectWrite },
      index: true,
      required: true,
    },
    {
      name: 'wpUsername',
      type: 'text',
      label: 'نام کاربری وردپرس',
      admin: {
        description: 'حساب مدیر وردپرس که رمز برنامه (Application Password) برایش ساخته شده است.',
      },
    },
    {
      name: 'wpApplicationPassword',
      type: 'text',
      label: 'رمز برنامه وردپرس',
      access: secretAccess,
      hooks: { afterRead: [maskMigrationSecret()] },
    },
    {
      name: 'wooConsumerKey',
      type: 'text',
      label: 'کلید مصرف‌کننده ووکامرس',
      access: secretAccess,
      hooks: { afterRead: [maskMigrationSecret()] },
    },
    {
      name: 'wooConsumerSecret',
      type: 'text',
      label: 'کلید خصوصی ووکامرس',
      access: secretAccess,
      hooks: { afterRead: [maskMigrationSecret()] },
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت اعتبارنامه‌ها',
      access: { update: noDirectWrite },
      admin: { readOnly: true },
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'untested',
      options: [
        { label: 'آزموده‌نشده', value: 'untested' },
        { label: 'آماده', value: 'ready' },
        { label: 'مسدود', value: 'blocked' },
        { label: 'خطادار', value: 'error' },
      ],
      required: true,
    },
    {
      name: 'inventory',
      type: 'json',
      label: 'موجودی کشف‌شده مبدأ',
      admin: {
        description: 'فهرست گونه‌های محتوا و طبقه‌بندی‌های دیده‌شده در آخرین کشف (discovery).',
        readOnly: true,
      },
      access: { update: noDirectWrite },
    },
    {
      name: 'coverage',
      type: 'json',
      label: 'ماتریس پوشش',
      admin: {
        description: 'تکلیف هر بخش مبدأ در مقصد: پشتیبانی‌شده، نیازمند نگاشت، بایگانی یا مسدود.',
        readOnly: true,
      },
      access: { update: noDirectWrite },
    },
    { name: 'lastCheckedAt', type: 'date', label: 'آخرین بررسی اتصال' },
    {
      name: 'lastError',
      type: 'textarea',
      label: 'آخرین خطا',
      admin: { readOnly: true },
      access: { update: noDirectWrite },
    },
    {
      name: 'jobs',
      type: 'join',
      collection: 'migration-jobs',
      label: 'کارهای مهاجرت این مبدأ',
      on: 'source',
    },
  ],
  hooks: {
    beforeChange: [encryptMigrationSecrets],
    beforeValidate: [validateMigrationSource],
  },
}
