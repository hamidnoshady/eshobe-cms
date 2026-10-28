import type { CollectionConfig, FieldAccess } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

import {
  assertCdnAccountUsable,
  encryptCdnAccountCredentials,
  keepCdnAccountProvider,
  refuseDeleteReferencedCdnAccount,
  singleSelfServiceAccountPerProvider,
  validateOriginTarget,
} from './hooks/cdnAccountSecrets'
import { CDN_SECRET_READ_CONTEXT_KEY, maskCdnCredential } from './hooks/cdnZoneSecrets'

const secretReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[CDN_SECRET_READ_CONTEXT_KEY] === true

const fieldAccess = {
  create: platformAdminFieldAccess,
  read: platformAdminFieldAccess,
  update: platformAdminFieldAccess,
}

/**
 * The platform's own ArvanCloud / Cloudflare account, entered once and shared by
 * every zone that names it — the "global connection".
 *
 * Platform-wide on purpose, like `storage-connections`: the token belongs to the
 * operator, not to a site, and «which customer owns the platform's Cloudflare
 * account?» has no answer. A tenant never reads this row. With
 * `tenantSelfService` on, a site key may ask `POST /api/site/cdn/zone` to create a
 * zone for one of *its own* hostnames through this account; the token itself still
 * leaves the process only inside a provider request (`src/cdn/resolve.ts`).
 */
export const CdnAccounts: CollectionConfig<'cdn-accounts'> = {
  slug: 'cdn-accounts',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'provider', 'enabled', 'tenantSelfService', 'credentialsSummary'],
    description:
      'حساب CDN سراسری پلتفرم. zoneها می‌توانند به‌جای توکن جداگانه از این حساب استفاده کنند و با «سلف‌سرویس مشتری» سایت‌ها می‌توانند دامنهٔ خودشان را از طریق آن به CDN اضافه کنند. توکن هرگز به مشتری یا API برنمی‌گردد.',
    group: PLATFORM_GROUPS.infrastructure,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام حساب',
          required: true,
          admin: { width: '50', description: 'برای خودتان؛ مثلاً «آروان — تولید».' },
        },
        {
          name: 'provider',
          type: 'select',
          label: 'ارائه‌دهندهٔ CDN',
          required: true,
          options: [
            { label: 'ArvanCloud', value: 'arvancloud' },
            { label: 'Cloudflare', value: 'cloudflare' },
          ],
          admin: {
            width: '50',
            description: 'پس از ساخت قابل تغییر نیست؛ توکن هر ارائه‌دهنده فقط برای همان معتبر است.',
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'enabled',
          type: 'checkbox',
          label: 'فعال',
          defaultValue: true,
          admin: {
            width: '50',
            description: 'خاموش کردن، همهٔ zoneهای وابسته را از همگام‌سازی و purge بازمی‌دارد.',
          },
        },
        {
          name: 'tenantSelfService',
          type: 'checkbox',
          label: 'سلف‌سرویس مشتری',
          defaultValue: false,
          admin: {
            width: '50',
            description:
              'مشتری با کلید API سایت خود می‌تواند دامنهٔ همان سایت را از طریق این حساب به CDN اضافه کند. برای هر ارائه‌دهنده فقط یک حساب.',
          },
        },
      ],
    },
    {
      name: 'credentials',
      type: 'group',
      label: 'اعتبارنامهٔ ارائه‌دهنده',
      admin: {
        description:
          'Cloudflare: توکن سطح حساب با Zone:Edit، DNS:Edit، Zone Settings:Edit و Cache Purge. Arvan: API Key حساب. هنگام ذخیره AES-256-GCM رمزنگاری می‌شود و دوباره خوانده نمی‌شود.',
      },
      fields: [
        {
          name: 'apiToken',
          type: 'text',
          label: 'API token / API key',
          access: { ...fieldAccess, read: secretReadAccess },
          hooks: { afterRead: [maskCdnCredential()] },
          admin: {
            description:
              'خالی گذاشتن در ویرایش یعنی نگه داشتن توکن قبلی؛ برای حذف، تیک پاک‌سازی را بزنید.',
          },
        },
      ],
    },
    {
      name: 'clearCredentials',
      type: 'checkbox',
      label: 'پاک کردن توکن ذخیره‌شده',
      defaultValue: false,
      access: fieldAccess,
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت توکن',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'cloudflareAccountId',
      type: 'text',
      label: 'Cloudflare Account ID',
      admin: {
        condition: (data) => data?.provider === 'cloudflare',
        description: 'برای ساخت zone جدید (از جمله سلف‌سرویس مشتری) لازم است.',
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'arvanDomainMode',
          type: 'select',
          label: 'نوع دامنه در آروان',
          defaultValue: 'full',
          options: [
            { label: 'Full DNS / nameserver', value: 'full' },
            { label: 'Partial / CNAME', value: 'partial' },
          ],
          admin: { condition: (data) => data?.provider === 'arvancloud', width: '50' },
        },
        {
          name: 'arvanPlanLevel',
          type: 'text',
          label: 'Plan level آروان',
          admin: {
            condition: (data) =>
              data?.provider === 'arvancloud' && data?.arvanDomainMode === 'partial',
            width: '50',
          },
        },
      ],
    },
    {
      name: 'originTarget',
      type: 'text',
      label: 'مقصد origin برای zoneهای مشتری',
      validate: validateOriginTarget,
      admin: {
        description:
          'IP سرور پلتفرم (یا برای Cloudflare یک hostname). رکوردهای پراکسی‌شدهٔ دامنهٔ مشتری فقط به همین مقصد اشاره می‌کنند و مشتری نمی‌تواند آن را عوض کند.',
      },
    },
  ],
  hooks: {
    beforeChange: [
      keepCdnAccountProvider,
      encryptCdnAccountCredentials,
      assertCdnAccountUsable,
      singleSelfServiceAccountPerProvider,
    ],
    beforeDelete: [refuseDeleteReferencedCdnAccount],
  },
  labels: { singular: 'حساب CDN', plural: 'حساب‌های CDN' },
  timestamps: true,
}
