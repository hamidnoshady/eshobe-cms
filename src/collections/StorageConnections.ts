import type { CollectionConfig, FieldAccess, Validate } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { storageConnectionEndpoints } from '@/endpoints/storageConnections'
import { normalizeStorageEndpoint, UnsafeStorageEndpoint } from '@/storage/endpoint'
import { storageProviderOptions } from '@/storage/providers'

import {
  STORAGE_HEALTH_WRITE_CONTEXT_KEY,
  STORAGE_SECRET_READ_CONTEXT_KEY,
  assertConnectionUsable,
  encryptStorageCredentials,
  maskStorageSecret,
} from './hooks/storageConnectionSecrets'
import {
  clearStorageCacheAfterChange,
  clearStorageCacheAfterDelete,
  deactivateOtherStorageConnections,
  invalidateStorageHealthOnChange,
  mergeContextStorageHealth,
  normaliseStorageConnection,
  preventDeleteActiveStorageConnection,
  requireFullHealthBeforeEnable,
} from './hooks/storageConnectionLifecycle'

/**
 * Platform-wide S3-compatible object storage — where every tenant's media lands.
 *
 * Not in the multi-tenant plugin's map (shared infrastructure, like `ApiKeys`).
 * Per-site keys: `sites/<id>/media` (`src/hooks/mediaPrefix.ts`).
 */

const secretReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[STORAGE_SECRET_READ_CONTEXT_KEY] === true

const healthWriteAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req?.user) ||
  req?.context?.[STORAGE_HEALTH_WRITE_CONTEXT_KEY] === true

const validateEndpoint: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  try {
    normalizeStorageEndpoint(String(value))
    return true
  } catch (error) {
    if (error instanceof UnsafeStorageEndpoint) return error.message
    return 'نشانی معتبر نیست.'
  }
}

export const StorageConnections: CollectionConfig<'storage-connections'> = {
  slug: 'storage-connections',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    components: {
      views: {
        list: {
          actions: ['@/storage/admin/StorageNavButton'],
        },
        storageOverview: {
          Component: '@/storage/admin/StorageOverviewView',
          meta: { title: 'ذخیره‌سازی اشیا' },
          path: '/infrastructure/storage',
        },
        storageHealth: {
          Component: '@/storage/admin/StorageHealthView',
          meta: { title: 'سلامت ذخیره‌سازی' },
          path: '/infrastructure/storage/health',
        },
        storageUsage: {
          Component: '@/storage/admin/StorageUsageView',
          meta: { title: 'مصرف ذخیره‌سازی' },
          path: '/infrastructure/storage/usage',
        },
      },
    },
    defaultColumns: ['name', 'provider', 'enabled', 'healthStatus', 'bucket', 'lastCheckedAt'],
    description:
      'اتصال S3-compatible برای رسانهٔ همهٔ سایت‌ها. فقط یک اتصال می‌تواند فعال باشد؛ Secret Key رمزنگاری‌شده ذخیره می‌شود و هرگز از API برنمی‌گردد.',
    group: PLATFORM_GROUPS.infrastructure,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'ui',
      type: 'ui',
      admin: {
        components: {
          Field: '@/storage/admin/StorageConnectionActions',
        },
      },
    },
    {
      name: 'name',
      type: 'text',
      label: 'نام اتصال',
      required: true,
      admin: { description: 'برای خودتان؛ مثلاً «تولید — رسانه».' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'provider',
          type: 'select',
          label: 'ارائه‌دهنده',
          required: true,
          defaultValue: 'arvancloud',
          options: storageProviderOptions(),
          admin: { width: '50' },
        },
        {
          name: 'enabled',
          type: 'checkbox',
          label: 'فعال (اتصال تولید)',
          defaultValue: false,
          admin: {
            width: '50',
            description:
              'اتصال فعال پس از خودآزمایی کامل. فعال‌سازی، اتصال قبلی را خودکار غیرفعال می‌کند.',
          },
        },
      ],
    },
    {
      name: 'storageMode',
      type: 'select',
      label: 'حالت ذخیره‌سازی',
      defaultValue: 'object_storage_with_local_mirror',
      required: true,
      options: [
        { label: 'فقط دیسک محلی (توسعه)', value: 'local' },
        { label: 'شیء‌نگاری (مرجع)', value: 'object_storage' },
        { label: 'شیء‌نگاری + آینهٔ محلی', value: 'object_storage_with_local_mirror' },
      ],
      admin: {
        description:
          'در «شیء‌نگاری»، فایل پس از آپلود موفق به S3 از دیسک محلی حذف می‌شود. بدون اتصال فعال، Payload همچنان از دیسک سرو می‌دهد.',
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'endpoint',
          type: 'text',
          label: 'Endpoint',
          required: true,
          validate: validateEndpoint,
          admin: {
            description: 'نشانی S3-compatible (بدون اسلش انتهایی).',
            placeholder: 'https://s3.ir-thr-at1.arvanstorage.ir',
            width: '60',
          },
        },
        {
          name: 'bucket',
          type: 'text',
          label: 'Bucket',
          required: true,
          admin: { width: '40' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'region',
          type: 'text',
          label: 'Region',
          defaultValue: 'default',
          admin: { width: '40' },
        },
        {
          name: 'forcePathStyle',
          type: 'checkbox',
          label: 'Path-style endpoint',
          defaultValue: true,
          admin: { width: '60' },
        },
      ],
    },
    {
      name: 'accessKeyId',
      type: 'text',
      label: 'Access key',
      required: true,
    },
    {
      name: 'secretAccessKey',
      type: 'text',
      label: 'Secret key',
      access: {
        create: platformAdminFieldAccess,
        read: secretReadAccess,
        update: platformAdminFieldAccess,
      },
      hooks: { afterRead: [maskStorageSecret()] },
      admin: {
        description:
          'AES-256-GCM در rest. خالی = «تغییر نده»؛ برای پاک کردن از گزینهٔ زیر استفاده کنید.',
      },
    },
    {
      name: 'clearCredentials',
      type: 'checkbox',
      label: 'پاک کردن Secret ذخیره‌شده',
      defaultValue: false,
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت کلید',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      type: 'collapsible',
      label: 'سلامت',
      admin: { initCollapsed: false },
      fields: [
        {
          name: 'healthStatus',
          type: 'select',
          label: 'وضعیت',
          defaultValue: 'unknown',
          options: [
            { label: 'نامشخص', value: 'unknown' },
            { label: 'در حال آزمون', value: 'testing' },
            { label: 'سالم', value: 'healthy' },
            { label: 'تضعیف‌شده', value: 'degraded' },
            { label: 'ناموفق', value: 'failed' },
            { label: 'نیاز به آزمون مجدد', value: 'retest_required' },
            { label: 'غیرفعال', value: 'disabled' },
          ],
          access: { create: () => false, update: healthWriteAccess },
          admin: { readOnly: true },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'lastCheckedAt',
              type: 'date',
              label: 'آخرین بررسی',
              access: { create: () => false, update: healthWriteAccess },
              admin: { readOnly: true, width: '33' },
            },
            {
              name: 'lastHealthyAt',
              type: 'date',
              label: 'آخرین موفق',
              access: { create: () => false, update: healthWriteAccess },
              admin: { readOnly: true, width: '33' },
            },
            {
              name: 'latencyMs',
              type: 'number',
              label: 'تأخیر (ms)',
              access: { create: () => false, update: healthWriteAccess },
              admin: { readOnly: true, width: '33' },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'endpointReachable', type: 'checkbox', label: 'Endpoint', access: { create: () => false, update: healthWriteAccess }, admin: { readOnly: true, width: '16' } },
            { name: 'authenticationOk', type: 'checkbox', label: 'Auth', access: { create: () => false, update: healthWriteAccess }, admin: { readOnly: true, width: '16' } },
            { name: 'bucketAccessible', type: 'checkbox', label: 'Bucket', access: { create: () => false, update: healthWriteAccess }, admin: { readOnly: true, width: '16' } },
            { name: 'writeAccessOk', type: 'checkbox', label: 'Write', access: { create: () => false, update: healthWriteAccess }, admin: { readOnly: true, width: '16' } },
            { name: 'readAccessOk', type: 'checkbox', label: 'Read', access: { create: () => false, update: healthWriteAccess }, admin: { readOnly: true, width: '16' } },
            { name: 'deleteAccessOk', type: 'checkbox', label: 'Delete', access: { create: () => false, update: healthWriteAccess }, admin: { readOnly: true, width: '16' } },
          ],
        },
        {
          name: 'lastErrorCode',
          type: 'text',
          label: 'کد خطا',
          access: { create: () => false, update: healthWriteAccess },
          admin: { readOnly: true, width: '33' },
        },
        {
          name: 'lastErrorCategory',
          type: 'select',
          label: 'دستهٔ خطا',
          options: [
            { label: 'NETWORK', value: 'NETWORK' },
            { label: 'TLS', value: 'TLS' },
            { label: 'TIMEOUT', value: 'TIMEOUT' },
            { label: 'AUTHENTICATION', value: 'AUTHENTICATION' },
            { label: 'BUCKET_NOT_FOUND', value: 'BUCKET_NOT_FOUND' },
            { label: 'PERMISSION', value: 'PERMISSION' },
            { label: 'READ_FAILED', value: 'READ_FAILED' },
            { label: 'WRITE_FAILED', value: 'WRITE_FAILED' },
            { label: 'DELETE_FAILED', value: 'DELETE_FAILED' },
            { label: 'PROVIDER', value: 'PROVIDER' },
            { label: 'CONFIGURATION', value: 'CONFIGURATION' },
            { label: 'UNKNOWN', value: 'UNKNOWN' },
          ],
          access: { create: () => false, update: healthWriteAccess },
          admin: { readOnly: true, width: '33' },
        },
        {
          name: 'lastErrorMessage',
          type: 'text',
          label: 'آخرین خطا (امن)',
          access: { create: () => false, update: healthWriteAccess },
          admin: { readOnly: true },
        },
        {
          name: 'lastSelfTestOk',
          type: 'checkbox',
          label: 'legacy: lastSelfTestOk',
          access: { create: () => false, update: healthWriteAccess },
          admin: { hidden: true, readOnly: true },
        },
        {
          name: 'lastSelfTestDetail',
          type: 'text',
          label: 'legacy: detail',
          access: { create: () => false, update: healthWriteAccess },
          admin: { hidden: true, readOnly: true },
        },
        {
          name: 'lastSelfTestAt',
          type: 'date',
          label: 'legacy: tested at',
          access: { create: () => false, update: healthWriteAccess },
          admin: { hidden: true, readOnly: true },
        },
      ],
    },
  ],
  endpoints: storageConnectionEndpoints,
  hooks: {
    afterChange: [clearStorageCacheAfterChange],
    afterDelete: [clearStorageCacheAfterDelete],
    beforeChange: [
      normaliseStorageConnection,
      encryptStorageCredentials,
      invalidateStorageHealthOnChange,
      deactivateOtherStorageConnections,
      assertConnectionUsable,
      mergeContextStorageHealth,
      requireFullHealthBeforeEnable,
    ],
    beforeDelete: [preventDeleteActiveStorageConnection],
  },
  labels: {
    plural: 'اتصالات ذخیره‌سازی',
    singular: 'اتصال ذخیره‌سازی',
  },
  timestamps: true,
}
