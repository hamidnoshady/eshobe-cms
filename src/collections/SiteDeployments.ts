import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import {
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_STATUS_LABELS,
  DOMAIN_MODES,
  DOMAIN_MODE_LABELS,
} from '@/lib/deploy/status'

/**
 * One running instance of a theme: (site × package × target) on a Coolify
 * application.
 *
 * This is the row that makes the feature debuggable. Without it "why is acme.ir
 * showing the old theme?" is answered by opening Coolify and reading container
 * names; with it the answer is a status, a commit sha, a domain mode and a log tail
 * on one screen.
 *
 * ## In the multi-tenant plugin's map, unlike its two siblings
 *
 * `theme-packages` and `deploy-targets` are catalogues — one list, offered to every
 * customer, platform-owned. A deployment row carries **exactly one site**, so it is
 * registered (`src/plugins/index.ts`), which is the rule CLAUDE.md states and the
 * same call `subscriptions` and `site-entitlements` make. Read access is still
 * platform-admin: a customer does not administer their own container.
 *
 * ## `status` has one writer
 *
 * The deploy job. Nothing else may set it, and `canTransition` in
 * `src/lib/deploy/status.ts` is what says which moves are legal. A status field two
 * writers can touch is a status field nobody can trust — and the specific accident
 * it prevents is a retry overwriting a `failed` with a stale `live`.
 *
 * ## History is kept
 *
 * A site has at most one `live` row and any number of `stopped`/`failed` ones.
 * Rolling back is redeploying the previous row's `commitSha`, which is exactly why
 * that column exists and why nothing here is deleted on supersede.
 */
export const SiteDeployments: CollectionConfig<'site-deployments'> = {
  slug: 'site-deployments',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['site', 'themePackage', 'status', 'domain', 'commitSha', 'deployedAt'],
    description:
      'هر ردیف، یک اجرای واقعی از یک پوسته روی یک سایت است. وضعیت را فقط کار استقرار می‌نویسد؛ ردیف‌های قدیمی برای بازگشت به نسخهٔ قبل نگه داشته می‌شوند.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'domain',
  },
  labels: { plural: 'استقرارهای سایت', singular: 'استقرار سایت' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'themePackage',
          type: 'relationship',
          relationTo: 'theme-packages',
          label: 'پوسته',
          required: true,
          index: true,
          admin: { width: '50' },
        },
        {
          name: 'target',
          type: 'relationship',
          relationTo: 'deploy-targets',
          label: 'سرور',
          required: true,
          admin: { width: '50' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          label: 'وضعیت',
          defaultValue: 'queued',
          required: true,
          index: true,
          options: DEPLOYMENT_STATUSES.map((value) => ({
            label: DEPLOYMENT_STATUS_LABELS[value],
            value,
          })),
          admin: {
            width: '50',
            readOnly: true,
            description: 'فقط کار استقرار این را می‌نویسد.',
          },
        },
        {
          name: 'domainMode',
          type: 'select',
          label: 'حالت دامنه',
          defaultValue: 'preview',
          required: true,
          options: DOMAIN_MODES.map((value) => ({ label: DOMAIN_MODE_LABELS[value], value })),
          admin: {
            width: '50',
            description:
              'پیش‌نمایش: بدون دست زدن به DNS مشتری. Caddy: دامنه سر جایش می‌ماند و فقط صفحات به پوسته می‌روند. مستقیم: DNS مشتری به Coolify اشاره می‌کند و پوسته باید /api را پراکسی کند.',
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'domain',
          type: 'text',
          label: 'میزبان',
          index: true,
          admin: { width: '50', readOnly: true, description: 'نشانی‌ای که این اجرا روی آن پاسخ می‌دهد.' },
        },
        {
          name: 'previewDomain',
          type: 'text',
          label: 'زیردامنهٔ پیش‌نمایش',
          admin: { width: '50', readOnly: true },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'آنچه در حال اجراست',
      admin: { initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'ref',
              type: 'text',
              label: 'شاخه یا تگ',
              admin: { width: '50', readOnly: true },
            },
            {
              name: 'commitSha',
              type: 'text',
              label: 'کامیت',
              index: true,
              admin: {
                width: '50',
                readOnly: true,
                description: 'دقیقاً همان چیزی که ساخته شد — ورودی بازگشت به نسخهٔ قبل.',
              },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'appUuid',
              type: 'text',
              label: 'شناسهٔ اپلیکیشن در Coolify',
              index: true,
              admin: {
                width: '50',
                readOnly: true,
                description: 'پیش از هر کار دیگری ذخیره می‌شود؛ یک اپلیکیشن بی‌صاحب گران‌ترین حالت ممکن است.',
              },
            },
            {
              name: 'lastDeploymentUuid',
              type: 'text',
              label: 'شناسهٔ آخرین بیلد',
              admin: { width: '50', readOnly: true },
            },
          ],
        },
      ],
    },
    {
      name: 'apiKey',
      type: 'relationship',
      relationTo: 'api-keys',
      label: 'کلید سایت',
      admin: {
        readOnly: true,
        description:
          'کلید role: "site" که این اجرا با آن محتوا می‌خواند. با توقف این استقرار باطل می‌شود.',
      },
    },
    {
      name: 'revalidateSecret',
      type: 'text',
      label: 'کلید امضای بازسازی',
      // Encrypted by the job before it is written; never rendered, never returned.
      access: { create: () => false, read: () => false, update: () => false },
      admin: { hidden: true },
    },
    {
      type: 'collapsible',
      label: 'آخرین نتیجه',
      fields: [
        {
          name: 'lastError',
          type: 'textarea',
          label: 'خطا',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'logTail',
          type: 'textarea',
          label: 'گزارش',
          access: { create: () => false, update: () => false },
          admin: {
            readOnly: true,
            description: 'کوتاه‌شده و پاک‌سازی‌شده — هیچ توکنی در آن نیست.',
          },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'deployedAt',
              type: 'date',
              label: 'زمان آخرین اجرای موفق',
              access: { create: () => false, update: () => false },
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'healthCheckedAt',
              type: 'date',
              label: 'آخرین بررسی سلامت',
              access: { create: () => false, update: () => false },
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
