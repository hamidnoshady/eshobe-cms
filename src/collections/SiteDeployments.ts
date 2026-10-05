import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import {
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_STATUS_LABELS,
  DOMAIN_MODES,
  DOMAIN_MODE_LABELS,
} from '@/lib/deploy/status'
import { DEPLOYMENT_LANES, DEPLOYMENT_LANE_LABELS } from '@/lib/deploy/lane'

/**
 * Historical deployment attempt for one theme on one site.
 *
 * `ThemeBinding` owns persistent runtime identity (Coolify app UUID, project/server
 * placement, lane). `SiteDeployment` owns immutable attempt/history data: commit,
 * artifact, target snapshot, logs, health and rollback inputs. Without it "why is
 * acme.ir showing the old theme?" is answered by opening Coolify and reading
 * container names; with it the answer is a status, a commit sha, a domain mode and a
 * log tail on one screen.
 *
 * ## In the multi-tenant plugin's map, unlike its two siblings
 *
 * `theme-packages` and `deploy-targets` are catalogues — one list, offered to every
 * customer, platform-owned. A deployment row carries **exactly one site**, so it is
 * registered (`src/plugins/index.ts`), which is the rule CLAUDE.md states and the
 * same call `subscriptions` and `site-entitlements` make. Read access is still
 * platform-admin: a customer does not administer their own container. Create is
 * closed even to platform admins — see `access.create` below for why a hand-made
 * row is a row that can only fail.
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
    /**
     * Rows are born in exactly one place: `createDeployment`, which has already
     * validated the package, resolved the immutable artifact for a registry
     * package, derived the preview hostname, and written `queued`. It runs with
     * `overrideAccess`, so closing `create` to everybody — platform admins
     * included — takes away nothing the deploy flow needs.
     *
     * What it takes away is the «انتشارها» create form, which was the source of a
     * whole class of broken rows: a hand-made row lands here with no linked
     * artifact and no preview hostname, and then fails at run time with
     * «برای این کامیت هنوز تصویر آماده و تأییدشده‌ای وجود ندارد» while GHCR is
     * perfectly ready. `runDeployment` now repairs such rows, but the honest fix
     * is that they cannot be created.
     *
     * Like `status` below: one writer, and it is the job.
     */
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['site', 'themePackage', 'status', 'domain', 'commitSha', 'deployedAt'],
    description:
      'هر ردیف، یک اجرای واقعی از یک پوسته روی یک سایت است. ردیف تازه فقط از مسیر استقرار ساخته می‌شود (پیش‌نمایش یا انتشار روی دامنه، در تب «استقرار پوسته» سایت)؛ وضعیت را هم فقط کار استقرار می‌نویسد. ردیف‌های قدیمی برای بازگشت به نسخهٔ قبل نگه داشته می‌شوند.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'domain',
  },
  labels: { plural: 'انتشارها', singular: 'انتشار' },
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
          label: 'حالت دامنه (قدیمی)',
          defaultValue: 'preview',
          required: true,
          options: DOMAIN_MODES.map((value) => ({ label: DOMAIN_MODE_LABELS[value], value })),
          admin: {
            width: '50',
            description: 'فقط برای تاریخچه و سازگاری. استقرار جدید از فیلد «مسیر» استفاده می‌کند.',
          },
        },
        {
          name: 'lane',
          type: 'select',
          label: 'مسیر',
          defaultValue: 'preview',
          index: true,
          options: DEPLOYMENT_LANES.map((value) => ({
            label: DEPLOYMENT_LANE_LABELS[value],
            value,
          })),
          admin: { width: '50' },
        },
      ],
    },
    {
      name: 'themeBinding',
      type: 'relationship',
      relationTo: 'theme-bindings',
      label: 'اتصال پوسته',
      index: true,
      admin: { readOnly: true },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'domain',
          type: 'text',
          label: 'میزبان',
          index: true,
          admin: {
            width: '50',
            readOnly: true,
            description: 'نشانی‌ای که این اجرا روی آن پاسخ می‌دهد.',
          },
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
          name: 'artifactSource',
          type: 'select',
          defaultValue: 'source_build',
          options: [
            { label: 'ساخت از سورس', value: 'source_build' },
            { label: 'تصویر رجیستری', value: 'registry_image' },
          ],
          admin: { readOnly: true },
        },
        {
          name: 'themeArtifact',
          type: 'relationship',
          relationTo: 'theme-artifacts',
          index: true,
          admin: { readOnly: true },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'imageRepository',
              type: 'text',
              label: 'مخزن تصویر',
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'imageTag',
              type: 'text',
              label: 'tag نمایشی',
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
        {
          name: 'imageDigest',
          type: 'text',
          label: 'digest immutable',
          index: true,
          admin: { readOnly: true },
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
                description:
                  'پیش از هر کار دیگری ذخیره می‌شود؛ یک اپلیکیشن بی‌صاحب گران‌ترین حالت ممکن است.',
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
        {
          name: 'platformEnvFingerprint',
          type: 'text',
          label: 'اثر انگشت متغیرهای سکو',
          // Written by the deploy job only (overrideAccess); compared on read with what a
          // deploy would write now (`platformEnvOutdated`).
          access: { create: () => false, update: () => false },
          admin: {
            readOnly: true,
            description:
              'خلاصهٔ غیرمحرمانهٔ متغیرهایی که سکو هنگام این استقرار به اپلیکیشن داد (مانند نشانی CMS).',
          },
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
  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (!data?.lane && data?.domainMode) {
          data.lane = data.domainMode === 'preview' ? 'preview' : 'production'
        }
      },
    ],
  },
}
