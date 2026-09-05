import type { CollectionConfig, FieldAccess } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { platformApiKeyAware } from '@/access/siteApiKey'
import { isValidDomain, normalizeDomain } from '@/lib/domains'

import {
  CDN_SECRET_READ_CONTEXT_KEY,
  encryptCdnCredentials,
  maskCdnCredential,
  uniqueCdnProviderZone,
} from './hooks/cdnZoneSecrets'

/** Only the resolver inside the staff-only endpoint may temporarily read a ciphertext.
 * `overrideAccess` alone is intentionally insufficient: it is used by many ordinary
 * internal reads that should remain write-only. */
const secretReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[CDN_SECRET_READ_CONTEXT_KEY] === true

const hostname = (value: unknown): true | string =>
  typeof value === 'string' && isValidDomain(normalizeDomain(value))
    ? true
    : 'دامنه را بدون پروتکل، پورت و مسیر وارد کنید.'

const fieldAccess = {
  create: platformAdminFieldAccess,
  read: platformAdminFieldAccess,
  update: platformAdminFieldAccess,
}

/**
 * Built-in control plane for the DNS zone that fronts one site. This remains a
 * separate, tenant-scoped collection instead of fields on `sites`: a zone holds
 * encrypted provider credentials, an independently reconciled desired state and
 * operational audit state. Keeping those apart makes it impossible for a normal
 * site editor or a tenant API key to turn DNS, TLS or a WAF into an attack surface.
 *
 * A hostname can only have one active reverse proxy. Therefore each row selects
 * exactly one provider; Cloudflare and ArvanCloud are both available choices, not
 * chained layers for the same hostname.
 */
export const CdnZones: CollectionConfig<'cdn-zones'> = {
  slug: 'cdn-zones',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformApiKeyAware(platformAdmin),
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['zoneName', 'provider', 'active', 'lastSyncOk', 'lastSyncAt'],
    description:
      'کنترل داخلی DNS، پراکسی CDN، TLS، کش و امنیت دامنه‌ها. هر zone فقط با یک CDN فعال می‌شود؛ توکن هرگز از API یا فرم دوباره خوانده نمی‌شود.',
    group: 'زیرساخت',
    useAsTitle: 'zoneName',
  },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'provider',
          type: 'select',
          label: 'ارائه‌دهندهٔ CDN',
          required: true,
          options: [
            { label: 'ArvanCloud', value: 'arvancloud' },
            { label: 'Cloudflare', value: 'cloudflare' },
          ],
          admin: { width: '50' },
        },
        {
          name: 'zoneName',
          type: 'text',
          label: 'نام DNS zone',
          required: true,
          unique: true,
          index: true,
          validate: hostname,
          admin: {
            width: '50',
            description:
              'ریشهٔ zone نزد ارائه‌دهنده، مثل example.com. برای زیردامنهٔ سایت نیز همین zone را وارد کنید؛ رکوردها پایین‌تر تعریف می‌شوند.',
          },
        },
      ],
    },
    {
      name: 'providerZoneKey',
      type: 'text',
      unique: true,
      index: true,
      access: { create: () => false, update: () => false },
      admin: { hidden: true },
    },
    {
      name: 'active',
      type: 'checkbox',
      label: 'اعمال تنظیمات در همگام‌سازی',
      defaultValue: false,
      admin: {
        description:
          'تا وقتی خاموش است، «همگام‌سازی» فقط اتصال/zone را بررسی می‌کند و DNS، کش، TLS یا قوانین امنیتی را تغییر نمی‌دهد.',
      },
    },
    {
      name: 'provisionIfMissing',
      type: 'checkbox',
      label: 'ساخت خودکار zone اگر وجود ندارد',
      defaultValue: false,
      admin: {
        description:
          'یک اقدام اثرگذار است: Cloudflare ممکن است nameserverهای جدید بدهد و ArvanCloud نیز zone می‌سازد. بدون این تیک، سامانه فقط zone موجود را پیدا می‌کند.',
      },
    },
    {
      name: 'cloudflareAccountId',
      type: 'text',
      label: 'Cloudflare Account ID',
      admin: {
        condition: (data) => data?.provider === 'cloudflare',
        description: 'فقط برای ساخت zone جدید لازم است؛ برای zone از قبل موجود لازم نیست.',
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
            description:
              'برای ساخت دامنهٔ partial فقط اگر حساب شما چنین مقدار plan level می‌خواهد وارد کنید.',
            width: '50',
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
          'توکن دارای کمترین سطح دسترسی ممکن وارد کنید. هنگام ذخیره AES-256-GCM رمزنگاری می‌شود؛ بعد از آن در پنل، REST و GraphQL برگردانده نمی‌شود. Cloudflare: Zone/DNS/Cache Purge/Zone Settings Edit. Arvan: API Key مربوط به CDN.',
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
      admin: {
        description: 'فقط همراه ذخیره‌سازی استفاده کنید. zone و DNS سمت ارائه‌دهنده حذف نمی‌شوند.',
      },
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت توکن',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'dnsRecords',
      type: 'array',
      label: 'رکوردهای DNS مدیریت‌شده توسط CMS',
      labels: { plural: 'رکوردها', singular: 'رکورد' },
      admin: {
        description:
          'فقط این رکوردها در sync نوشته می‌شوند. حذف یک ردیف از این فهرست، رکورد را از ارائه‌دهنده حذف نمی‌کند؛ برای جلوگیری از حذف ناخواسته، ابتدا آن را در ارائه‌دهنده بررسی کنید.',
        initCollapsed: true,
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'type',
              type: 'select',
              label: 'نوع',
              required: true,
              defaultValue: 'A',
              options: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'].map((value) => ({
                label: value,
                value,
              })),
              admin: { width: '20' },
            },
            {
              name: 'name',
              type: 'text',
              label: 'نام',
              required: true,
              admin: { width: '25', description: '@ برای ریشهٔ zone یا نام نسبی مثل www.' },
            },
            {
              name: 'content',
              type: 'text',
              label: 'مقدار / مقصد',
              required: true,
              admin: { width: '55' },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'ttl',
              type: 'number',
              label: 'TTL (ثانیه)',
              defaultValue: 1,
              min: 1,
              max: 86400,
              admin: { width: '25', description: '۱ برای automatic نزد Cloudflare.' },
            },
            {
              name: 'priority',
              type: 'number',
              label: 'اولویت MX',
              min: 0,
              max: 65535,
              admin: { width: '25', condition: (_data, sibling) => sibling?.type === 'MX' },
            },
            {
              name: 'proxied',
              type: 'checkbox',
              label: 'عبور از CDN (proxy/cloud)',
              defaultValue: false,
              admin: {
                width: '50',
                description:
                  'فقط A/AAAA/CNAME مربوط به HTTP/HTTPS را پراکسی کنید. MX/TXT/CAA هرگز نباید پراکسی شوند.',
              },
            },
          ],
        },
        {
          name: 'providerRecordId',
          type: 'text',
          access: { create: () => false, update: () => false },
          admin: { hidden: true },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'SSL / TLS و HSTS',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'ssl',
          type: 'group',
          fields: [
            {
              name: 'mode',
              type: 'select',
              label: 'حالت TLS تا origin',
              defaultValue: 'strict',
              options: [
                { label: 'Flexible (ناامن برای origin؛ توصیه نمی‌شود)', value: 'flexible' },
                { label: 'Full', value: 'full' },
                { label: 'Full (strict) — توصیه‌شده', value: 'strict' },
              ],
              admin: {
                description:
                  'strict فقط وقتی origin گواهی معتبر دارد. Caddy این پلتفرم باید برای hostname گواهی معتبر داشته باشد.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'minimumTls',
                  type: 'select',
                  label: 'حداقل TLS بازدیدکننده',
                  defaultValue: '1.2',
                  options: ['1.0', '1.1', '1.2', '1.3'].map((value) => ({
                    label: `TLS ${value}`,
                    value,
                  })),
                  admin: { width: '50' },
                },
                {
                  name: 'tls13',
                  type: 'checkbox',
                  label: 'TLS 1.3 فعال',
                  defaultValue: true,
                  admin: { width: '50' },
                },
              ],
            },
            {
              name: 'alwaysUseHttps',
              type: 'checkbox',
              label: 'تغییر مسیر HTTP به HTTPS',
              defaultValue: true,
            },
          ],
        },
        {
          name: 'hsts',
          type: 'group',
          fields: [
            { name: 'enabled', type: 'checkbox', label: 'HSTS فعال', defaultValue: false },
            {
              name: 'maxAge',
              type: 'number',
              label: 'HSTS max-age (ثانیه)',
              defaultValue: 15552000,
              min: 0,
              max: 63072000,
              admin: { condition: (_data, sibling) => sibling?.enabled },
            },
            {
              name: 'includeSubdomains',
              type: 'checkbox',
              label: 'شامل زیردامنه‌ها',
              defaultValue: false,
              admin: { condition: (_data, sibling) => sibling?.enabled },
            },
            {
              name: 'preload',
              type: 'checkbox',
              label: 'درخواست HSTS preload',
              defaultValue: false,
              admin: {
                condition: (_data, sibling) => sibling?.enabled,
                description: 'تنها پس از HTTPS شدن همهٔ زیردامنه‌ها. حذف preload فوری نیست.',
              },
            },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'کش و purge',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'cache',
          type: 'group',
          fields: [
            {
              name: 'mode',
              type: 'select',
              label: 'سیاست cache CMS',
              defaultValue: 'respect-origin',
              options: [
                {
                  label: 'احترام به Cache-Control origin — امن و پیش‌فرض',
                  value: 'respect-origin',
                },
                { label: 'فقط دارایی‌های ثابت (_next/static و media)', value: 'static-assets' },
              ],
              admin: {
                description:
                  'CMS هیچ‌وقت به‌طور پیش‌فرض HTML، /admin، /api یا پاسخ دارای cookie را cache-everything نمی‌کند.',
              },
            },
            {
              name: 'edgeTtl',
              type: 'number',
              label: 'TTL لبه (ثانیه)',
              min: 60,
              max: 31536000,
              admin: { condition: (_data, sibling) => sibling?.mode === 'static-assets' },
            },
            {
              name: 'browserTtl',
              type: 'number',
              label: 'TTL مرورگر (ثانیه)',
              min: 0,
              max: 31536000,
            },
            {
              name: 'ignoreSetCookie',
              type: 'checkbox',
              label: 'نادیده‌گرفتن Set-Cookie در کش',
              defaultValue: false,
              admin: { description: 'پرخطر؛ فقط با قابلیت Premium تأییدشده اعمال می‌شود.' },
            },
            {
              name: 'developmentMode',
              type: 'checkbox',
              label: 'حالت توسعه (bypass cache)',
              defaultValue: false,
            },
            { name: 'alwaysOnline', type: 'checkbox', label: 'Always Online', defaultValue: false },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'امنیت، WAF و DDoS',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'security',
          type: 'group',
          fields: [
            {
              name: 'securityLevel',
              type: 'select',
              label: 'سطح امنیت عمومی',
              defaultValue: 'medium',
              options: ['off', 'low', 'medium', 'high', 'under_attack'].map((value) => ({
                label: value,
                value,
              })),
            },
            {
              name: 'wafMode',
              type: 'select',
              label: 'حالت WAF آروان',
              defaultValue: 'detect',
              options: ['off', 'detect', 'protect'].map((value) => ({ label: value, value })),
              admin: { condition: (data) => data?.provider === 'arvancloud' },
            },
            {
              name: 'ddosMode',
              type: 'select',
              label: 'حالت چالش DDoS آروان',
              defaultValue: 'off',
              options: ['off', 'cookie', 'javascript', 'recaptcha'].map((value) => ({
                label: value,
                value,
              })),
              admin: { condition: (data) => data?.provider === 'arvancloud' },
            },
          ],
        },
        {
          name: 'securityRules',
          type: 'array',
          label: 'قوانین سفارشیِ مدیریت‌شده',
          labels: { plural: 'قوانین', singular: 'قانون' },
          admin: {
            description:
              'عبارت‌ها syntax خود ارائه‌دهنده دارند. قوانین دست‌ساز دیگر در Cloudflare/Arvan تغییر یا حذف نمی‌شوند.',
          },
          fields: [
            {
              name: 'kind',
              type: 'select',
              required: true,
              defaultValue: 'firewall',
              options: [
                { label: 'Firewall / Custom rule', value: 'firewall' },
                { label: 'WAF path/IP rule', value: 'waf' },
              ],
            },
            { name: 'description', type: 'text', label: 'نام/توضیح' },
            { name: 'expression', type: 'textarea', label: 'Expression', required: true },
            {
              name: 'action',
              type: 'select',
              required: true,
              defaultValue: 'block',
              options: ['block', 'challenge', 'log', 'skip'].map((value) => ({
                label: value,
                value,
              })),
            },
            { name: 'enabled', type: 'checkbox', label: 'فعال', defaultValue: true },
            {
              name: 'providerRuleId',
              type: 'text',
              access: { create: () => false, update: () => false },
              admin: { hidden: true },
            },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'قابلیت‌ها و entitlement پلن',
      admin: {
        initCollapsed: true,
        description:
          'تنها انتخاب یک گزینه API آن را نمی‌خرد. قبل از اعمال قابلیت پولی، قرارداد/پلن ارائه‌دهنده را تأیید کنید.',
      },
      fields: [
        {
          name: 'capabilities',
          type: 'group',
          fields: [
            {
              name: 'advancedCache',
              type: 'checkbox',
              label: 'کش پیشرفته / cache rule',
              defaultValue: false,
            },
            {
              name: 'wafCustomRules',
              type: 'checkbox',
              label: 'قوانین سفارشی WAF / Firewall',
              defaultValue: false,
            },
            {
              name: 'rateLimiting',
              type: 'checkbox',
              label: 'Rate limiting / امکانات anti-bot پولی',
              defaultValue: false,
            },
          ],
        },
        {
          name: 'providerPlan',
          type: 'text',
          label: 'نام پلن تأییدشده',
          admin: { description: 'برای ثبت عملیاتی؛ CMS ادعای تشخیص پلن از روی token نمی‌کند.' },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'وضعیت عملیاتی (فقط خواندنی)',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'providerZoneId',
          type: 'text',
          label: 'شناسهٔ zone ارائه‌دهنده',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'providerStatus',
          type: 'text',
          label: 'وضعیت provider',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'providerNameservers',
          type: 'array',
          label: 'Nameserverهای واگذارشده',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
          fields: [{ name: 'hostname', type: 'text' }],
        },
        {
          name: 'lastSyncOk',
          type: 'checkbox',
          label: 'آخرین sync موفق بود',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'lastSyncAt',
          type: 'date',
          label: 'آخرین sync',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'lastSyncDetail',
          type: 'textarea',
          label: 'گزارش آخرین sync',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'lastPurgeAt',
          type: 'date',
          label: 'آخرین purge',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
      ],
    },
  ],
  hooks: {
    beforeChange: [encryptCdnCredentials, uniqueCdnProviderZone],
  },
  labels: { singular: 'zone CDN', plural: 'zoneهای CDN' },
  timestamps: true,
}
