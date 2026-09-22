import type { CollectionConfig, FieldAccess, Validate } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { deployTargetEndpoints } from '@/endpoints/deployTargets'
import { normalizeBaseUrl } from '@/deploy/coolify'
import { isValidDomain } from '@/lib/domains'
import { slugKey } from '@/lib/saas/plans'

import {
  DEPLOY_SECRET_READ_CONTEXT_KEY,
  encryptDeployTargetToken,
  maskDeploySecret,
} from './hooks/deploySecrets'

/**
 * Where the platform is allowed to run a customer's theme.
 *
 * One row per (Coolify instance, server, project). Platform-admin only and **not**
 * in the multi-tenant plugin's `collections` map — the legitimate exception CLAUDE.md
 * describes: this is the operator's own infrastructure, one list offered to every
 * customer, and "which customer owns the Tehran server?" has no answer. A tenant
 * never reads a row here, never names one, and could not act on one if it did.
 *
 * ## Why a collection and not environment variables
 *
 * A deployment grows a second server the week after the first one fills up, and an
 * env var cannot be picked from a dropdown while provisioning a site. The credential
 * is the same shape as `storage-connections` — one encrypted token an operator types
 * once — and it gets the same three layers: AES-256-GCM at rest, field access locked
 * to platform staff, and an `afterRead` hook that blanks it for everyone except the
 * deploy job's own flagged read.
 *
 * ## The self-test is not optional decoration
 *
 * `POST /api/deploy-targets/self-test` asks Coolify for its server list and checks
 * that `serverUuid` is in it. A token that authenticates but belongs to a different
 * team is the failure this catches — otherwise it surfaces as a customer's first
 * deploy failing with an opaque 404 from an API nobody in the room can read.
 */

const tokenReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[DEPLOY_SECRET_READ_CONTEXT_KEY] === true

const validateBaseUrl: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  return normalizeBaseUrl(value)
    ? true
    : 'نشانی باید https باشد (یا http روی localhost) — مثل https://coolify.example.com.'
}

/**
 * `*.sites.example.com`. A preview hostname is how a theme is proven on the
 * customer's real content *before* their DNS moves, which is the difference between
 * a reversible change and an outage on a live domain.
 */
const validateWildcard: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  const raw = String(value).replace(/^\*\./, '')
  return isValidDomain(raw) ? true : 'دامنهٔ عام باید مثل *.sites.example.com باشد.'
}

export const DeployTargets: CollectionConfig<'deploy-targets'> = {
  slug: 'deploy-targets',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'provider', 'active', 'baseUrl', 'tokenSummary', 'lastSelfTestOk'],
    description:
      'سرورهایی که پوستهٔ سایت‌ها روی آن‌ها اجرا می‌شود. توکن Coolify رمزنگاری‌شده ذخیره می‌شود و هرگز برگردانده نمی‌شود؛ پیش از استفاده حتماً «خودآزمایی» را اجرا کنید.',
    group: PLATFORM_GROUPS.infrastructure,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  labels: { plural: 'سرورهای استقرار', singular: 'سرور استقرار' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام',
          required: true,
          admin: { width: '50', description: 'برای خودتان — مثلاً «سرور اصلی — تهران».' },
        },
        {
          name: 'key',
          type: 'text',
          label: 'کلید',
          required: true,
          unique: true,
          index: true,
          hooks: { beforeValidate: [({ value, data }) => slugKey(value || data?.name)] },
          admin: { width: '50', description: 'شناسهٔ ماشینی؛ در API با همین نام ارسال می‌شود.' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'provider',
          type: 'select',
          label: 'سرویس',
          defaultValue: 'coolify',
          required: true,
          // One value today. The field exists so a second provider is an enum entry
          // plus a module implementing `CoolifyClient`'s interface, not a schema change
          // to every deployment row that already exists.
          options: [{ label: 'Coolify', value: 'coolify' }],
          admin: { width: '50' },
        },
        {
          name: 'active',
          type: 'checkbox',
          label: 'در دسترس',
          defaultValue: true,
          index: true,
          admin: {
            width: '50',
            description:
              'خاموش یعنی استقرار جدیدی روی آن ساخته نمی‌شود؛ سایت‌های در حال اجرا دست‌نخورده می‌مانند.',
          },
        },
      ],
    },
    {
      name: 'baseUrl',
      type: 'text',
      label: 'نشانی Coolify',
      required: true,
      validate: validateBaseUrl,
      admin: { description: 'بدون / پایانی — مثل https://coolify.example.com.' },
    },
    {
      name: 'apiToken',
      type: 'text',
      label: 'توکن API',
      access: {
        create: platformAdminFieldAccess,
        read: tokenReadAccess,
        update: platformAdminFieldAccess,
      },
      hooks: { afterRead: [maskDeploySecret()] },
      admin: {
        description:
          'از بخش Keys & Tokens در Coolify. هنگام ذخیره AES-256-GCM رمزنگاری می‌شود و هرگز برگردانده نمی‌شود؛ خالی گذاشتن یعنی «تغییر نده». این توکن می‌تواند هر سایتی را روشن و خاموش کند.',
      },
    },
    {
      name: 'clearApiToken',
      type: 'checkbox',
      label: 'پاک کردن توکن ذخیره‌شده',
      defaultValue: false,
      admin: { description: 'بدون تیک، فیلد خالی یعنی «همان مقدار قبلی».' },
    },
    {
      name: 'tokenSummary',
      type: 'text',
      label: 'وضعیت توکن',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      type: 'collapsible',
      label: 'جایگاه در Coolify',
      admin: { initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'serverUuid',
              type: 'text',
              label: 'شناسهٔ سرور',
              required: true,
              admin: { width: '50', description: 'UUID سرور در Coolify.' },
            },
            {
              name: 'projectUuid',
              type: 'text',
              label: 'شناسهٔ پروژه',
              required: true,
              admin: { width: '50', description: 'UUID پروژه‌ای که سایت‌های مشتریان در آن ساخته می‌شوند.' },
            },
          ],
        },
        {
          name: 'environmentName',
          type: 'text',
          label: 'نام محیط',
          defaultValue: 'production',
          required: true,
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'دسترسی به مخزن',
      admin: { initCollapsed: false },
      fields: [
        {
          name: 'gitSource',
          type: 'select',
          label: 'نوع دسترسی',
          defaultValue: 'public',
          required: true,
          options: [
            { label: 'مخزن عمومی', value: 'public' },
            { label: 'GitHub App (مخزن خصوصی)', value: 'githubApp' },
            { label: 'کلید استقرار (مخزن خصوصی)', value: 'deployKey' },
          ],
          admin: {
            description: 'برای پوسته‌های خصوصی باید در Coolify از قبل یک منبع ساخته باشید.',
          },
        },
        {
          name: 'githubAppUuid',
          type: 'text',
          label: 'شناسهٔ GitHub App',
          // Not schema-`required`: Payload validates required fields even when
          // `admin.condition` hides them, so requiring this would make every
          // `public` target unsavable. `assertTargetUsable` enforces it per variant.
          admin: { condition: (_, sibling) => sibling?.gitSource === 'githubApp' },
        },
        {
          name: 'privateKeyUuid',
          type: 'text',
          label: 'شناسهٔ کلید خصوصی',
          admin: { condition: (_, sibling) => sibling?.gitSource === 'deployKey' },
        },
      ],
    },
    {
      name: 'wildcardDomain',
      type: 'text',
      label: 'دامنهٔ عام پیش‌نمایش',
      validate: validateWildcard,
      admin: {
        description:
          'مثل *.sites.example.com — پیش از انتقال DNS مشتری، پوسته روی یک زیردامنه از این نام اجرا و بررسی می‌شود.',
      },
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت',
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
   * A **collection endpoint**, for the routing rule `src/endpoints/apiKeys.ts`
   * records: Payload dispatches `/api/<first-segment>/…` against that collection's
   * own endpoints whenever the first segment is a collection slug, and never falls
   * back to the top-level array. `/api/deploy-targets/self-test` registered at the
   * top level would answer 404 to every caller.
   */
  endpoints: deployTargetEndpoints,
  hooks: {
    beforeChange: [encryptDeployTargetToken],
  },
  timestamps: true,
}
