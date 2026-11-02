import type { CollectionConfig } from 'payload'

import { hiddenFromOperators } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * One migration program for one (site, source): discovery, dry-runs, the
 * import itself, delta syncs, reconciliation, cutover and rollback all run
 * against this row, with `migration-batches/-records/-events/-errors` as its
 * working ledger.
 *
 * State is machine-owned. The wizard endpoints queue an operation by stamping
 * `runRequestedAt` (the `migrationJobs` Payload task picks it up, the same
 * queue-marker pattern as `cdnZoneSync`); `control` is how an owner pauses or
 * cancels a running import between pages. Direct collection writes are
 * refused — a hand-edited status or checkpoint is exactly how an importer
 * re-reads a page it already applied and double-writes a tenant's catalogue.
 */
export const MigrationJobs: CollectionConfig = {
  slug: 'migration-jobs',
  access: {
    create: noDirectWrite,
    delete: noDirectWrite,
    read: authenticated,
    update: noDirectWrite,
  },
  admin: {
    defaultColumns: ['title', 'status', 'phase', 'updatedAt'],
    description:
      'کارهای مهاجرت این سایت؛ وضعیت و نقطه ادامه از «مرکز مهاجرت» مدیریت می‌شود و اینجا فقط گزارش است.',
    group: 'مهاجرت',
    hidden: hiddenFromOperators,
    useAsTitle: 'title',
  },
  labels: { plural: 'کارهای مهاجرت', singular: 'کار مهاجرت' },
  fields: [
    { name: 'title', type: 'text', label: 'عنوان', required: true },
    {
      name: 'source',
      type: 'relationship',
      label: 'مبدأ وردپرس',
      relationTo: 'migration-sources',
      required: true,
    },
    {
      name: 'operation',
      type: 'select',
      label: 'عملیات در صف',
      defaultValue: 'discover',
      options: [
        { label: 'کشف و موجودی', value: 'discover' },
        { label: 'اجرای آزمایشی (dry-run)', value: 'dry-run' },
        { label: 'ورود کامل', value: 'import' },
        { label: 'هم‌گام‌سازی افزایشی', value: 'sync' },
        { label: 'تطبیق و راستی‌آزمایی', value: 'reconcile' },
        { label: 'برش نهایی (cutover)', value: 'cutover' },
        { label: 'بازگشت (rollback)', value: 'rollback' },
      ],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'draft',
      options: [
        { label: 'پیش‌نویس', value: 'draft' },
        { label: 'در صف اجرا', value: 'queued' },
        { label: 'در حال اجرا', value: 'running' },
        { label: 'متوقف موقت', value: 'paused' },
        { label: 'مسدود', value: 'blocked' },
        { label: 'آماده ورود', value: 'ready' },
        { label: 'آماده برش نهایی', value: 'ready-for-cutover' },
        { label: 'تکمیل‌شده', value: 'completed' },
        { label: 'لغوشده', value: 'cancelled' },
        { label: 'خطادار', value: 'failed' },
        { label: 'برگردانده‌شده', value: 'rolled-back' },
      ],
      required: true,
    },
    { name: 'phase', type: 'text', label: 'گام جاری' },
    {
      name: 'control',
      type: 'select',
      label: 'فرمان اپراتور',
      defaultValue: 'run',
      options: [
        { label: 'اجرا', value: 'run' },
        { label: 'توقف موقت', value: 'pause' },
        { label: 'لغو', value: 'cancel' },
      ],
      required: true,
    },
    { name: 'runRequestedAt', type: 'date', label: 'زمان درخواست اجرا', index: true },
    { name: 'currentRunId', type: 'text', label: 'شناسه اجرای جاری', index: true },
    {
      name: 'lockedAt',
      type: 'date',
      label: 'قفل اجرا',
      access: { create: noDirectWrite, read: noDirectWrite, update: noDirectWrite },
    },
    {
      name: 'lockToken',
      type: 'text',
      label: 'نشانه قفل',
      access: { create: noDirectWrite, read: noDirectWrite, update: noDirectWrite },
    },
    {
      name: 'settings',
      type: 'json',
      label: 'تنظیمات نگاشت',
      admin: {
        description:
          'زبان مقصد، واحد پول و Decimals ووکامرس، تأیید ریالی، و این‌که کدام بخش‌ها وارد شوند.',
      },
    },
    {
      name: 'inventory',
      type: 'json',
      label: 'موجودی مبدأ',
      access: { update: noDirectWrite },
    },
    { name: 'coverage', type: 'json', label: 'ماتریس پوشش', access: { update: noDirectWrite } },
    {
      name: 'dryRunReport',
      type: 'json',
      label: 'گزارش اجرای آزمایشی',
      access: { update: noDirectWrite },
    },
    {
      name: 'reconciliationReport',
      type: 'json',
      label: 'گزارش تطبیق',
      access: { update: noDirectWrite },
    },
    {
      name: 'checkpoint',
      type: 'json',
      label: 'نقطه ادامه (checkpoint)',
      admin: {
        description: 'آخرین صفحه خوانده‌شده و مرز زمانی هر منبع؛ ادامه اجرا از همین‌جا ممکن است.',
        readOnly: true,
      },
      access: { update: noDirectWrite },
    },
    { name: 'summary', type: 'json', label: 'خلاصه اجرا', access: { update: noDirectWrite } },
    { name: 'blockers', type: 'json', label: 'مسدودکننده‌ها', access: { update: noDirectWrite } },
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
    { name: 'startedAt', type: 'date', label: 'شروع آخرین اجرا' },
    { name: 'finishedAt', type: 'date', label: 'پایان آخرین اجرا' },
    { name: 'lastSyncAt', type: 'date', label: 'آخرین هم‌گام‌سازی موفق' },
    {
      name: 'sourceWriteFenceConfirmedAt',
      type: 'date',
      label: 'تأیید توقف نوشتن روی وردپرس',
      admin: {
        description:
          'برش نهایی فقط وقتی ممکن است که مالک تأیید کند وردپرس در وضعیت فقط‌خواندنی/نگهداری است و سفارش یا محتوای تازه‌ای نوشته نمی‌شود.',
      },
    },
    { name: 'cutoverAt', type: 'date', label: 'زمان برش نهایی' },
    { name: 'rolledBackAt', type: 'date', label: 'زمان برگشت' },
    { name: 'lastError', type: 'textarea', label: 'آخرین خطا', access: { update: noDirectWrite } },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
