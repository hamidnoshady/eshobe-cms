import type { CollectionBeforeChangeHook, CollectionConfig, Validate } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { BUILD_PACKS, parseRepository, isSafeGitRef } from '@/lib/deploy/manifest'
import { slugKey } from '@/lib/saas/plans'
import { DESIGN_RADIUS } from '@/lib/theme-design'
import { isHexColor } from '@/lib/theme'

/**
 * A **deployable** theme: a GitHub repository built against `docs/THEME_API.md`,
 * registered here so a site can be pointed at it.
 *
 * It is the canonical Theme catalogue: a repo, a ref, a build pack, a port, an env
 * contract, a lifecycle, and optional defaults copied only when a site adopts it.
 *
 * ## The manifest is the source of truth, not this form
 *
 * `build*`, `envSchema`, `siteTypes`, `contractVersion` and `capabilities` are all
 * projected out of `eshobe.theme.json` by `POST /api/platform/theme-packages/:id/sync`
 * and are read-only here. An operator typing a build command into a form is an
 * operator typing it differently from the repo's own README, and the repo is the one
 * that has to build. `manifest` keeps the raw document so a diff is possible.
 *
 * ## A tenant never names a repository
 *
 * Customers pick from *published* rows a platform admin created. A field where a
 * customer types a Git URL is a "build and run arbitrary code on our server" field
 * wearing a text input. That is why `access` is `platformAdmin` on all four
 * operations and why this collection is one of the legitimate exceptions to the
 * multi-tenant registration rule (CLAUDE.md): one catalogue, offered to everyone.
 */

const validateRepository: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  return parseRepository(value)
    ? true
    : 'مخزن باید به شکل owner/name باشد — مثل hamidnoshady/bazaar-store.'
}

const validateRef: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  return isSafeGitRef(value) ? true : 'نام شاخه یا تگ نامعتبر است.'
}

const validateSha: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  return /^[0-9a-f]{40}$/i.test(String(value)) ? true : 'شناسهٔ کامیت باید ۴۰ رقم هگز باشد.'
}

const validateGhcrRepository: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true
  return /^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i.test(String(value))
    ? true
    : 'مخزن تصویر باید به شکل ghcr.io/owner/image باشد.'
}

/** Everything the sync writes. Grouped so the form reads as "what the repo said", not "what you may type". */
const readOnly = { create: () => false as const, update: () => false as const }

/** Set by the sync endpoint on its own write, so the hook below can tell it apart from an edit. */
export const THEME_PACKAGE_SYNC_CONTEXT_KEY = 'eshobeThemePackageSync'

/**
 * `syncedCommitSha` answers "which commit does `defaultRef` point at?" — true only for
 * the `defaultRef` the sync resolved. An operator who edits the ref by hand afterwards
 * makes that answer wrong, and a wrong answer here is a false "new version available"
 * (or a missing one) on every site running the package. Cleared rather than kept;
 * the next sync fills it in again.
 */
const forgetSyncedCommitOnRefEdit: CollectionBeforeChangeHook = ({
  context,
  data,
  operation,
  originalDoc,
}) => {
  if (operation !== 'update' || context?.[THEME_PACKAGE_SYNC_CONTEXT_KEY] === true || !originalDoc)
    return data
  if (typeof data.defaultRef === 'string' && data.defaultRef !== originalDoc.defaultRef) {
    data.syncedCommitSha = null
  }
  return data
}

export const ThemePackages: CollectionConfig<'theme-packages'> = {
  slug: 'theme-packages',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'key', 'status', 'repository', 'defaultRef', 'contractVersion'],
    description:
      'پوسته‌هایی که روی سرور مستقر و اجرا می‌شوند. مخزن و شاخه را وارد کنید، «همگام‌سازی از گیت‌هاب» را بزنید تا eshobe.theme.json خوانده شود، و بعد منتشر کنید. فقط پوستهٔ «منتشرشده» در ساخت سایت پیشنهاد می‌شود.',
    group: PLATFORM_GROUPS.product,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  labels: { plural: 'پوسته‌های نصب‌شدنی', singular: 'پوستهٔ نصب‌شدنی' },
  fields: [
    {
      name: 'actions',
      type: 'ui',
      admin: {
        components: {
          Field: '@/deploy/admin/ThemePackageActions',
        },
      },
      label: 'عملیات',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام',
          required: true,
          admin: { width: '50' },
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
            description: 'شناسهٔ ماشینی؛ در API استقرار با همین نام ارسال می‌شود.',
          },
        },
      ],
    },
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'draft',
      required: true,
      index: true,
      options: [
        { label: 'پیش‌نویس', value: 'draft' },
        { label: 'منتشرشده', value: 'published' },
        { label: 'منسوخ', value: 'deprecated' },
      ],
      admin: {
        description:
          'فقط «منتشرشده» برای سایت جدید پیشنهاد می‌شود. «منسوخ» سایت‌های در حال اجرا را متوقف نمی‌کند؛ فقط از فهرست انتخاب حذف می‌شود.',
      },
    },
    {
      type: 'collapsible',
      label: 'مخزن',
      admin: { initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'provider',
              type: 'select',
              label: 'میزبان کد',
              defaultValue: 'github',
              required: true,
              options: [{ label: 'GitHub', value: 'github' }],
              admin: { width: '33' },
            },
            {
              name: 'repository',
              type: 'text',
              label: 'مخزن',
              required: true,
              validate: validateRepository,
              admin: { width: '34', description: 'owner/name' },
            },
            {
              name: 'visibility',
              type: 'select',
              label: 'دسترسی',
              defaultValue: 'public',
              required: true,
              options: [
                { label: 'عمومی', value: 'public' },
                { label: 'خصوصی', value: 'private' },
              ],
              admin: {
                width: '33',
                description: 'خصوصی به GITHUB_THEME_TOKEN و منبع خصوصی در Coolify نیاز دارد.',
              },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'defaultRef',
              type: 'text',
              label: 'شاخه یا تگ',
              defaultValue: 'main',
              required: true,
              validate: validateRef,
              admin: { width: '50' },
            },
            {
              name: 'pinnedCommit',
              type: 'text',
              label: 'کامیت ثابت',
              validate: validateSha,
              admin: {
                width: '50',
                description: 'اختیاری — اگر پر باشد، هر استقرار جدید دقیقاً همین کامیت را می‌گیرد.',
              },
            },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'روش استقرار و GHCR',
      admin: { initCollapsed: false },
      fields: [
        {
          name: 'deploymentStrategy',
          type: 'select',
          defaultValue: 'coolify_build',
          label: 'روش استقرار',
          options: [
            { label: 'ساخت مستقیم در Coolify', value: 'coolify_build' },
            { label: 'تصویر از پیش ساخته‌شده (پیشنهادی)', value: 'registry_image' },
          ],
          admin: {
            description:
              'تصویر آماده یک بار ساخته می‌شود و preview و production همان digest را اجرا می‌کنند.',
          },
        },
        {
          name: 'allowedDeploymentStrategies',
          type: 'select',
          hasMany: true,
          defaultValue: ['coolify_build'],
          options: [
            { label: 'Coolify build', value: 'coolify_build' },
            { label: 'Registry image', value: 'registry_image' },
          ],
        },
        {
          name: 'registryProvider',
          type: 'select',
          options: [{ label: 'GitHub Container Registry', value: 'ghcr' }],
          admin: { condition: (_, sibling) => sibling?.deploymentStrategy === 'registry_image' },
        },
        {
          name: 'registryImageRepository',
          type: 'text',
          label: 'مخزن تصویر',
          validate: validateGhcrRepository,
          admin: {
            condition: (_, sibling) => sibling?.deploymentStrategy === 'registry_image',
            description: 'فقط ghcr.io/owner/image؛ نام callback باید دقیقاً همین باشد.',
          },
        },
        {
          name: 'registryVisibility',
          type: 'select',
          defaultValue: 'public',
          label: 'دسترسی تصویر',
          options: [
            { label: 'عمومی', value: 'public' },
            { label: 'خصوصی', value: 'private' },
          ],
          admin: { condition: (_, sibling) => sibling?.deploymentStrategy === 'registry_image' },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'آنچه مانیفست گفته است',
      admin: {
        initCollapsed: false,
        description: 'این مقادیر از eshobe.theme.json خوانده می‌شوند و دستی قابل تغییر نیستند.',
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'contractVersion',
              type: 'number',
              label: 'نسخهٔ قرارداد',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'manifestSyncedAt',
              type: 'date',
              label: 'آخرین همگام‌سازی',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
        {
          name: 'syncedCommitSha',
          type: 'text',
          label: 'کامیت همگام‌شده',
          access: readOnly,
          admin: {
            readOnly: true,
            description:
              'کامیتی که «شاخه یا تگ» هنگام آخرین همگام‌سازی به آن اشاره می‌کرد. سایت‌هایی که کامیت دیگری اجرا می‌کنند «نسخهٔ جدید موجود است» می‌بینند.',
          },
        },
        {
          name: 'siteTypes',
          type: 'select',
          label: 'برای نوع سایت',
          hasMany: true,
          access: readOnly,
          options: [
            { label: 'کسب‌وکار', value: 'business' },
            { label: 'نمونه‌کار', value: 'portfolio' },
            { label: 'فروشگاه', value: 'store' },
          ],
          admin: { readOnly: true },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'buildPack',
              type: 'select',
              label: 'روش ساخت',
              access: readOnly,
              options: BUILD_PACKS.map((value) => ({ label: value, value })),
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'port',
              type: 'number',
              label: 'پورت',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'healthCheckPath',
              type: 'text',
              label: 'مسیر سلامت',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'proxiesApi',
              type: 'checkbox',
              label: 'مسیرهای /api را پراکسی می‌کند',
              access: readOnly,
              admin: {
                readOnly: true,
                width: '50',
                description:
                  'لازمهٔ حالت «دامنه روی Coolify». بدون آن، فرم تماس و پرداخت کار نمی‌کنند.',
              },
            },
          ],
        },
        {
          name: 'manifest',
          type: 'json',
          label: 'مانیفست خام',
          access: readOnly,
          admin: { readOnly: true, description: 'محتوای eshobe.theme.json همان‌طور که خوانده شد.' },
        },
        {
          name: 'envSchema',
          type: 'json',
          label: 'متغیرهای محیطی',
          access: readOnly,
          admin: {
            readOnly: true,
            description:
              'متغیرهای source: "platform" را سکو می‌نویسد؛ متغیرهای source: "tenant" به‌صورت فرم به مشتری نشان داده می‌شوند.',
          },
        },
        {
          name: 'runtimeSettingsSchema',
          type: 'json',
          label: 'گزینه‌های زمان اجرا',
          access: readOnly,
          admin: {
            readOnly: true,
            description: 'گزینه‌های نمایشی امن که بدون استقرار مجدد قابل ویرایش‌اند.',
          },
        },
        {
          name: 'contentSlotsSchema',
          type: 'json',
          label: 'جایگاه‌های محتوا',
          access: readOnly,
          admin: {
            readOnly: true,
            description: 'نگاشت‌های محتوایی که پوسته از سایت درخواست می‌کند.',
          },
        },
        {
          name: 'syncError',
          type: 'textarea',
          label: 'خطای آخرین همگام‌سازی',
          access: readOnly,
          admin: { readOnly: true },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'githubLastDeliveryId',
              type: 'text',
              label: 'آخرین رویداد گیت‌هاب',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'githubWebhookReceivedAt',
              type: 'date',
              label: 'آخرین دریافت وب‌هوک',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'githubLastAutoSyncAt',
              type: 'date',
              label: 'آخرین همگام‌سازی خودکار',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'githubLastAutoSyncError',
              type: 'textarea',
              label: 'خطای همگام‌سازی خودکار',
              access: readOnly,
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'عرضه',
      fields: [
        {
          name: 'designDefaults',
          type: 'group',
          label: 'پیش‌فرض‌های طراحی',
          access: readOnly,
          admin: { readOnly: true, description: 'از مانیفست خوانده می‌شود و فقط هنگام پذیرش پوسته در سایت کپی می‌شود.' },
          fields: [
            { name: 'primary', type: 'text', validate: (value: unknown) => isHexColor(value) || value == null ? true : 'رنگ hex نامعتبر است.' },
            { name: 'accent', type: 'text', validate: (value: unknown) => isHexColor(value) || value == null ? true : 'رنگ hex نامعتبر است.' },
            { name: 'background', type: 'text', validate: (value: unknown) => isHexColor(value) || value == null ? true : 'رنگ hex نامعتبر است.' },
            { name: 'foreground', type: 'text', validate: (value: unknown) => isHexColor(value) || value == null ? true : 'رنگ hex نامعتبر است.' },
            { name: 'radius', type: 'select', options: DESIGN_RADIUS.map((value) => ({ label: value, value })) },
            { name: 'lineHeight', type: 'number', min: 1.4, max: 2.4 },
          ],
        },
        {
          name: 'defaultTarget',
          type: 'relationship',
          relationTo: 'deploy-targets',
          label: 'سرور پیش‌فرض',
          admin: { description: 'اگر هنگام استقرار سروری انتخاب نشود، همین استفاده می‌شود.' },
        },
        {
          name: 'requiredFeature',
          type: 'text',
          label: 'قابلیت لازم در پلن',
          admin: {
            description:
              'اختیاری — کلید یک feature-flag. اگر پر باشد، فقط سایتی که پلنش این قابلیت را دارد می‌تواند این پوسته را بگیرد.',
          },
        },
        {
          name: 'preview',
          type: 'upload',
          relationTo: 'media',
          label: 'تصویر پیش‌نمایش',
        },
      ],
    },
  ],
  hooks: {
    beforeChange: [forgetSyncedCommitOnRefEdit],
  },
  timestamps: true,
}
