import type { GlobalConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

/**
 * How this SaaS behaves — the operator's own control panel, in one document.
 *
 * A Payload global, and the second one in this codebase after `payments`, for the
 * same test that one states: a global cannot be tenant-scoped, so the only things
 * that belong here are the ones where **one answer for the whole deployment is the
 * point**. "Is signup open", "what happens when a site passes its quota", "how many
 * failures disable a webhook" are the operator's questions, not any customer's.
 *
 * Anything per-site lives on `sites` or `site-entitlements`. Commercial invoices,
 * prices and renewal belong to cafe-restaurant-pos. The invoice fields below are a
 * frozen archive of values this deployment used to apply; nothing reads them to
 * create a bill.
 */
export const PlatformSettings: GlobalConfig = {
  slug: 'platform-settings',
  access: {
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    description:
      'رفتار کلی سکو: هویت، سیاست اعمال سقف‌ها، نگهداشت گزارش‌ها و حالت تعمیر. قیمت، اشتراک و صورتحساب مشتری در سکوی اشوبه است، نه اینجا.',
    group: PLATFORM_GROUPS.operations,
    // Platform-only (`access.read` is `platformAdmin`); keep it out of customer nav.
    hidden: hiddenFromCustomers,
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'هویت سکو',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'platformName',
                  type: 'text',
                  label: 'نام سکو',
                  defaultValue: 'اشوبه',
                  admin: { width: '50', description: 'در ایمیل‌ها و پاسخ API معرفی می‌شود.' },
                },
                {
                  name: 'supportEmail',
                  type: 'email',
                  label: 'ایمیل پشتیبانی',
                  admin: { width: '50' },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'supportUrl',
                  type: 'text',
                  label: 'نشانی پشتیبانی',
                  admin: { width: '50' },
                },
                {
                  name: 'billingEmail',
                  type: 'email',
                  label: 'ایمیل مالی',
                  admin: { width: '50', description: 'فرستندهٔ صورتحساب‌ها و یادآوری‌های پرداخت.' },
                },
              ],
            },
          ],
        },
        {
          label: 'ثبت‌نام و ساخت سایت',
          fields: [
            {
              name: 'signupsOpen',
              type: 'checkbox',
              label: 'ثبت‌نام باز است',
              defaultValue: false,
              admin: {
                description:
                  'خاموش یعنی فقط اپراتور می‌تواند سایت بسازد. این کلید فقط یک سیاست است؛ ساخت سایت از API همچنان کلید «پلتفرم» می‌خواهد.',
              },
            },
            {
              name: 'defaultPlan',
              type: 'relationship',
              relationTo: 'plans',
              label: 'طرح پیش‌فرض',
              admin: { description: 'سایتی که بدون تعیین طرح ساخته شود، روی این طرح اشتراک می‌گیرد.' },
            },
            {
              name: 'defaultSiteStatus',
              type: 'select',
              label: 'وضعیت اولیهٔ سایت',
              defaultValue: 'active',
              options: [
                { label: 'فعال', value: 'active' },
                { label: 'معلق (تا تأیید دستی)', value: 'suspended' },
              ],
            },
            {
              name: 'maxSitesPerUser',
              type: 'number',
              label: 'حداکثر سایت برای هر کاربر',
              min: 0,
              admin: { description: 'خالی یا صفر یعنی بی‌نهایت.' },
            },
          ],
        },
        {
          label: 'سقف‌ها',
          fields: [
            {
              name: 'quotaEnforcement',
              type: 'select',
              label: 'سیاست پیش‌فرض اعمال سقف',
              defaultValue: 'warn',
              required: true,
              options: [
                { label: 'فقط هشدار (ثبت می‌شود، جلوی کار را نمی‌گیرد)', value: 'warn' },
                { label: 'سخت‌گیرانه (ساخت مورد جدید رد می‌شود)', value: 'enforce' },
                { label: 'خاموش', value: 'off' },
              ],
              admin: {
                description:
                  'پیش‌فرض «هشدار» است، نه «سخت‌گیرانه»: یک سقفِ اشتباه تنظیم‌شده نباید بی‌صدا جلوی انتشار مشتریِ پرداخت‌کننده را بگیرد. هر سایت می‌تواند استثنا داشته باشد.',
              },
            },
            {
              name: 'quotaWarnPercent',
              type: 'number',
              label: 'آستانهٔ هشدار (درصد)',
              defaultValue: 80,
              min: 1,
              max: 100,
              admin: { description: 'از این درصد به بالا، سنجه در گزارش‌ها «هشدار» علامت می‌خورد.' },
            },
            {
              name: 'suspendOnQuotaExceeded',
              type: 'checkbox',
              label: 'تعلیق خودکار در صورت عبور از سقف',
              defaultValue: false,
              admin: {
                description:
                  'به‌شدت محافظه‌کارانه استفاده کنید: تعلیق خودکار یعنی سایت یک مشتری با یک شمارش اشتباه از دسترس خارج می‌شود.',
              },
            },
          ],
        },
        {
          label: 'بایگانی صورتحساب',
          description:
            'این مقدارها دیگر صورتحسابی نمی‌سازند. مهلت، مالیات و تمدید را سکوی اشوبه تعیین می‌کند. فیلدها فقط برای بایگانی خواندنی مانده‌اند.',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'invoiceDueDays',
                  type: 'number',
                  label: 'مهلت پرداخت (بایگانی)',
                  defaultValue: 7,
                  min: 0,
                  max: 120,
                  access: { update: () => false },
                  admin: { readOnly: true, width: '50' },
                },
                {
                  name: 'taxPercent',
                  type: 'number',
                  label: 'مالیات پیش‌فرض (بایگانی)',
                  defaultValue: 0,
                  min: 0,
                  max: 100,
                  access: { update: () => false },
                  admin: { readOnly: true, width: '50' },
                },
              ],
            },
            {
              name: 'autoRenewInvoices',
              type: 'checkbox',
              label: 'ساخت خودکار صورتحساب تمدید (بایگانی)',
              defaultValue: true,
              access: { update: () => false },
              admin: {
                readOnly: true,
                description: 'دیگر اجرا نمی‌شود. تمدید و صورتحساب در سکوی اشوبه است.',
              },
            },
            {
              name: 'invoiceFooter',
              type: 'textarea',
              label: 'پانویس صورتحساب (بایگانی)',
              access: { update: () => false },
              admin: { readOnly: true },
            },
          ],
        },
        {
          label: 'عملیات',
          fields: [
            {
              name: 'maintenanceMode',
              type: 'checkbox',
              label: 'حالت تعمیر',
              defaultValue: false,
              admin: {
                description:
                  'یک اعلام وضعیت است که در API گزارش می‌شود تا برنامه‌های متصل بدانند تغییرات را متوقف کنند. سایت‌های مشتری‌ها را خاموش نمی‌کند.',
              },
            },
            {
              name: 'maintenanceMessage',
              type: 'textarea',
              label: 'پیام حالت تعمیر',
              admin: { condition: (data) => data?.maintenanceMode === true },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'webhookMaxFailures',
                  type: 'number',
                  label: 'سقف خطای پیاپی وب‌هوک',
                  defaultValue: 10,
                  min: 1,
                  max: 100,
                  admin: { width: '50', description: 'پس از این تعداد، وب‌هوک خودکار خاموش می‌شود.' },
                },
                {
                  name: 'webhookTimeoutMs',
                  type: 'number',
                  label: 'تایم‌اوت وب‌هوک (میلی‌ثانیه)',
                  defaultValue: 5000,
                  min: 500,
                  max: 30_000,
                  admin: { width: '50' },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'auditRetentionDays',
                  type: 'number',
                  label: 'نگهداشت ردّ تغییرات (روز)',
                  defaultValue: 365,
                  min: 7,
                  max: 3650,
                  admin: { width: '50' },
                },
                {
                  name: 'deliveryRetentionDays',
                  type: 'number',
                  label: 'نگهداشت گزارش ارسال وب‌هوک (روز)',
                  defaultValue: 30,
                  min: 1,
                  max: 365,
                  admin: { width: '50' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}
