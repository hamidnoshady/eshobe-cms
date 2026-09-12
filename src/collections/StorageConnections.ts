import type { CollectionConfig, FieldAccess, Validate } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { storageConnectionEndpoints } from '@/endpoints/storageConnections'

import {
  STORAGE_SECRET_READ_CONTEXT_KEY,
  assertConnectionUsable,
  assertSingleEnabledConnection,
  encryptStorageCredentials,
  maskStorageSecret,
} from './hooks/storageConnectionSecrets'

/**
 * The platform's single object-storage connection — where every tenant's media lands.
 *
 * Deliberately a *platform-admin-only, platform-wide* collection and **not** in the
 * multi-tenant plugin's `collections` map: this is shared infrastructure, like `ApiKeys`,
 * not a site's own content. A superadmin enters the ArvanCloud Object Storage endpoint,
 * bucket and credentials once; every site transparently writes its media there, namespaced
 * by `sites/<id>/media` (`src/hooks/mediaPrefix.ts`). A tenant never sees or configures any
 * of it.
 *
 * The secret key is AES-256-GCM encrypted at rest and masked on every read (only the
 * resolver in `src/storage/connection.ts` may read the ciphertext), exactly like the CDN
 * zone and payment-gateway credentials.
 */

/** Only the resolver inside the storage module may temporarily read the ciphertext. */
const secretReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[STORAGE_SECRET_READ_CONTEXT_KEY] === true

const validateEndpoint: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? true
      : 'نشانی باید با https:// شروع شود.'
  } catch {
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
    defaultColumns: ['name', 'enabled', 'bucket', 'endpoint', 'credentialsSummary'],
    description:
      'اتصال ذخیره‌سازی ArvanCloud که همهٔ رسانه‌های سایت‌ها در آن ذخیره می‌شود. فقط یک اتصال می‌تواند فعال باشد؛ کلید رمزنگاری‌شده ذخیره می‌شود و هرگز از API برگردانده نمی‌شود.',
    group: PLATFORM_GROUPS.infrastructure,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام اتصال',
      required: true,
      admin: { description: 'برای خودتان؛ مثلاً «تولید — تهران» یا «باکت اصلی رسانه».' },
    },
    {
      name: 'enabled',
      type: 'checkbox',
      label: 'فعال (اتصال فعلی)',
      defaultValue: true,
      admin: {
        description:
          'اتصالی که آپلودها به آن می‌روند. فقط یکی می‌تواند فعال باشد؛ بدون اتصال فعال، فایل‌ها روی دیسک محلی می‌مانند.',
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
            description:
              'نشانی S3 آروان‌کلود؛ معمولاً https://s3.ir-thr-at1.arvanstorage.ir (بدون اسلش انتهایی).',
            placeholder: 'https://s3.ir-thr-at1.arvanstorage.ir',
            width: '60',
          },
        },
        {
          name: 'bucket',
          type: 'text',
          label: 'Bucket',
          required: true,
          admin: { width: '40', description: 'نام باکت در پنل Object Storage آروان‌کلود.' },
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
          admin: {
            width: '40',
            description: 'آروان‌کلود در نمونه‌های SDK مقدار «default» می‌پذیرد؛ تغییرش معمولاً لازم نیست.',
          },
        },
        {
          name: 'forcePathStyle',
          type: 'checkbox',
          label: 'Path-style endpoint',
          defaultValue: true,
          admin: {
            width: '60',
            description:
              'آروان‌کلود باکت را به‌صورت path-style آدرس‌دهی می‌کند (باکت در مسیر، نه زیردامنه). روشن بماند.',
          },
        },
      ],
    },
    {
      name: 'accessKeyId',
      type: 'text',
      label: 'Access key',
      required: true,
      admin: { description: 'شناسهٔ Access Key از پنل Object Storage آروان‌کلود.' },
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
          'کلید رمز در پنل Object Storage آروان‌کلود. هنگام ذخیره AES-256-GCM رمزنگاری می‌شود و بعد از آن هرگز برگردانده نمی‌شود؛ خالی گذاشتن یعنی «تغییر نده».',
      },
    },
    {
      name: 'clearCredentials',
      type: 'checkbox',
      label: 'پاک کردن کلید ذخیره‌شده',
      defaultValue: false,
      admin: {
        description: 'فقط همراه ذخیره‌سازی استفاده کنید؛ بدون تیک، فیلد خالی یعنی «همان مقدار قبلی».',
      },
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
      label: 'آخرین خودآزمایی',
      fields: [
        {
          name: 'lastSelfTestOk',
          type: 'checkbox',
          label: 'نتیجهٔ خودآزمایی',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'lastSelfTestDetail',
          type: 'text',
          label: 'جزئیات',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'lastSelfTestAt',
          type: 'date',
          label: 'زمان',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
      ],
    },
  ],
  /**
   * The self-test lives on the collection so `/api/storage-connections/self-test`
   * actually routes: an API path whose first segment is a collection slug is
   * dispatched against that collection's endpoints only, never the top-level
   * `endpoints` array — where this sat, unreachable, answering 404 to the POS
   * console. See `src/endpoints/storageConnections.ts` for the rule.
   */
  endpoints: storageConnectionEndpoints,
  hooks: {
    // Order matters: encryption first, so `assertConnectionUsable` inspects the same
    // ciphertext that is about to be written.
    beforeChange: [encryptStorageCredentials, assertSingleEnabledConnection, assertConnectionUsable],
  },
  labels: {
    plural: 'اتصالات ذخیره‌سازی',
    singular: 'اتصال ذخیره‌سازی',
  },
  timestamps: true,
}
