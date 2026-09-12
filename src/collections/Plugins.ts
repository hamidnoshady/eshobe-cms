import type { CollectionConfig, FieldAccess } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { slugKey } from '@/lib/saas/plans'
import {
  PLATFORM_SECRET_READ_CONTEXT_KEY,
  encryptPluginSettings,
  maskPlatformSecret,
} from './hooks/platformSecrets'

/**
 * The plugin registry — what an operator has installed on this deployment, which
 * sites it applies to, and the credentials it needs.
 *
 * ## What a "plugin" is here, precisely
 *
 * Not a Payload plugin. Those are code, they are in `src/plugins/index.ts`, and
 * installing one is a deploy — a CMS that could load arbitrary server code from a
 * database row would be a remote-code-execution feature with a nice form on it.
 *
 * A row here is a **registration**: an integration this deployment knows how to
 * talk to (an analytics script, a chat widget, a webhook-driven service, a build
 * hook), turned on per site, configured with settings and a credential. The runtime
 * half is `type` — a closed list this codebase implements — and everything else is
 * data. That split is the whole design: `type` is what the code branches on, and it
 * cannot be invented by an operator, so a row can never name a behaviour that does
 * not exist.
 *
 * ## Scope
 *
 * `scope: 'global'` applies to every site; `scope: 'sites'` to the named ones. A
 * plugin is *platform* infrastructure — it is not in the multi-tenant plugin's map
 * and carries no `site` field, because "which sites is this on" is a list the
 * operator draws, not a tenant boundary. The credential is what makes that
 * necessary: one analytics account, twenty sites reporting into it.
 *
 * ## The credential
 *
 * AES-256-GCM at rest (`src/lib/saas/crypto.ts`), masked on every read, and
 * readable only by the resolver — the same shape as `storage-connections` and
 * `cdn-zones`. Encryption protects a database dump; the field access protects the
 * API. Neither alone is enough.
 */

const secretReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[PLATFORM_SECRET_READ_CONTEXT_KEY] === true

export const Plugins: CollectionConfig<'plugins'> = {
  slug: 'plugins',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'type', 'enabled', 'scope', 'credentialsSummary'],
    description:
      'افزونه‌های نصب‌شده روی این نصب: نوع از فهرست بستهٔ پشتیبانی‌شده انتخاب می‌شود، تنظیمات و کلید هر افزونه رمزنگاری‌شده ذخیره می‌شود. افزونه کد اجرا نمی‌کند؛ یک ثبت پیکربندی است.',
    group: PLATFORM_GROUPS.extensions,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  labels: { plural: 'افزونه‌ها', singular: 'افزونه' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام',
          required: true,
          admin: { width: '50', description: 'برای خودتان — مثلاً «گوگل آنالیتیکس، مشتری‌های فروشگاهی».' },
        },
        {
          name: 'key',
          type: 'text',
          label: 'کلید',
          required: true,
          unique: true,
          index: true,
          hooks: { beforeValidate: [({ value, data }) => slugKey(value || data?.name)] },
          admin: {
            width: '50',
            description: 'شناسهٔ ماشینی؛ در API و در پاسخ توصیفگر سایت با همین نام برگردانده می‌شود.',
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'type',
          type: 'select',
          label: 'نوع',
          required: true,
          index: true,
          options: [
            { label: 'اسکریپت تحلیل ترافیک', value: 'analytics' },
            { label: 'ابزارک گفت‌وگو', value: 'chat' },
            { label: 'کد سفارشی در <head>', value: 'headScript' },
            { label: 'وب‌هوک خروجی', value: 'webhook' },
            { label: 'هوک بازسازی سایت', value: 'buildHook' },
            { label: 'ارسال ایمیل انبوه', value: 'email' },
            { label: 'نقشهٔ سایت و ابزار سئو', value: 'seo' },
            { label: 'سرویس ترجمه', value: 'translation' },
            { label: 'ذخیره‌ساز پشتیبان', value: 'backup' },
            { label: 'سایر (فقط پیکربندی)', value: 'custom' },
          ],
          admin: {
            width: '50',
            description:
              'فهرست بسته است: کد هر نوع در همین مخزن پیاده‌سازی شده. نوعی که اینجا نیست، رفتاری هم ندارد.',
          },
        },
        {
          name: 'enabled',
          type: 'checkbox',
          label: 'فعال',
          defaultValue: false,
          index: true,
          admin: { width: '50', description: 'خاموش یعنی در هیچ سایتی بارگذاری و فراخوانی نمی‌شود.' },
        },
      ],
    },
    {
      name: 'version',
      type: 'text',
      label: 'نسخه',
      admin: { description: 'نسخهٔ سرویس بیرونی یا قرارداد، برای پیگیری تغییرات ناسازگار.', position: 'sidebar' },
    },
    {
      name: 'scope',
      type: 'select',
      label: 'دامنهٔ اعمال',
      defaultValue: 'global',
      required: true,
      options: [
        { label: 'همهٔ سایت‌ها', value: 'global' },
        { label: 'فقط سایت‌های انتخاب‌شده', value: 'sites' },
      ],
    },
    {
      name: 'sites',
      type: 'relationship',
      relationTo: 'sites',
      hasMany: true,
      label: 'سایت‌ها',
      admin: {
        condition: (_, siblingData) => siblingData?.scope === 'sites',
        description: 'فقط روی این سایت‌ها اعمال می‌شود.',
      },
    },
    {
      name: 'settings',
      type: 'json',
      label: 'تنظیمات',
      admin: {
        description:
          'پیکربندی غیرمحرمانهٔ افزونه، به‌صورت JSON — مثلاً {"measurementId": "G-XXXX"}. هرگز کلید محرمانه اینجا نگذارید؛ برای آن فیلد پایین هست.',
      },
    },
    {
      name: 'credential',
      type: 'text',
      label: 'کلید محرمانه',
      access: {
        create: platformAdminFieldAccess,
        read: secretReadAccess,
        update: platformAdminFieldAccess,
      },
      hooks: { afterRead: [maskPlatformSecret()] },
      admin: {
        description:
          'توکن یا کلید API این افزونه. هنگام ذخیره AES-256-GCM رمزنگاری می‌شود و بعد از آن هرگز برگردانده نمی‌شود؛ خالی گذاشتن یعنی «تغییر نده».',
      },
    },
    {
      name: 'clearCredential',
      type: 'checkbox',
      label: 'پاک کردن کلید ذخیره‌شده',
      defaultValue: false,
      admin: { description: 'بدون تیک، فیلد خالی یعنی «همان مقدار قبلی».' },
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت کلید',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت',
    },
  ],
  hooks: {
    beforeChange: [encryptPluginSettings],
  },
  timestamps: true,
}
