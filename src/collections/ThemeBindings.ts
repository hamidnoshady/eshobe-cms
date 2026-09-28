import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { DEPLOYMENT_LANES, DEPLOYMENT_LANE_LABELS } from '@/lib/deploy/lane'

const BINDING_STATES = ['active', 'provisioning', 'stopped', 'conflict'] as const

/**
 * Persistent Coolify identity for (site × theme package × lane).
 *
 * Individual `site-deployments` rows are history; the binding owns `appUuid` and the
 * project/server where that application lives. Editing a deploy-target row must not
 * relocate an existing binding — those fields are copied here at first provision.
 */
export const ThemeBindings: CollectionConfig<'theme-bindings'> = {
  slug: 'theme-bindings',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['site', 'themePackage', 'lane', 'state', 'appUuid', 'updatedAt'],
    description:
      'زیرساخت داخلی: هویت ثابت اپلیکیشن Coolify برای هر سایت، پوسته و مسیر (پیش‌نمایش یا انتشار). ردیف‌های انتشار به این ردیف ارجاع می‌دهند و این جدول در نمای سایت/انتشار نمایش داده می‌شود.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'bindingKey',
  },
  labels: { plural: 'اتصال‌های پوسته', singular: 'اتصال پوسته' },
  fields: [
    {
      name: 'bindingKey',
      type: 'text',
      label: 'کلید',
      unique: true,
      index: true,
      admin: { readOnly: true },
    },
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
          name: 'lane',
          type: 'select',
          label: 'مسیر',
          required: true,
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
      name: 'target',
      type: 'relationship',
      relationTo: 'deploy-targets',
      label: 'سرور (ثابت)',
      required: true,
      admin: {
        description:
          'سروری که این اپلیکیشن روی آن ساخته شده. تغییر پیش‌فرض سرور روی استقرارهای بعدی اثر ندارد.',
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'appUuid',
          type: 'text',
          label: 'شناسهٔ اپلیکیشن',
          index: true,
          admin: { width: '50', readOnly: true },
        },
        {
          name: 'appName',
          type: 'text',
          label: 'نام اپلیکیشن',
          admin: { width: '50', readOnly: true },
        },
      ],
    },
    {
      name: 'applicationHostname',
      type: 'text',
      label: 'میزبان اپلیکیشن (پیش‌نمایش)',
      admin: {
        readOnly: true,
        description: 'برای بررسی سلامت؛ در انتشار روی دامنه لزوماً همان دامنهٔ مشتری نیست.',
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'coolifyProjectUuid',
          type: 'text',
          label: 'پروژهٔ Coolify',
          required: true,
          admin: { width: '50', readOnly: true },
        },
        {
          name: 'serverUuid',
          type: 'text',
          label: 'سرور Coolify',
          required: true,
          admin: { width: '50', readOnly: true },
        },
      ],
    },
    {
      name: 'environmentName',
      type: 'text',
      label: 'نام محیط',
      defaultValue: 'production',
      required: true,
      admin: { readOnly: true },
    },
    {
      name: 'state',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'active',
      required: true,
      index: true,
      options: [
        { label: 'فعال', value: 'active' },
        { label: 'در حال ایجاد', value: 'provisioning' },
        { label: 'متوقف', value: 'stopped' },
        { label: 'تعارض — نیاز به مداخله', value: 'conflict' },
      ],
    },
    {
      name: 'conflictDetail',
      type: 'textarea',
      label: 'جزئیات تعارض',
      admin: { readOnly: true, condition: (_, s) => s?.state === 'conflict' },
    },
    {
      name: 'provisioningDeployment',
      type: 'relationship',
      relationTo: 'site-deployments',
      label: 'استقرار در حال ایجاد',
      admin: { readOnly: true, condition: (_, s) => s?.state === 'provisioning' },
    },
  ],
  timestamps: true,
}
