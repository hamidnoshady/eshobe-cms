import type { CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { apiKeyAware } from '@/access/siteApiKey'
import { platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { validatePriceMinor } from '@/lib/money'

/** Immutable price/payment/progress snapshot for every billable registrar command.
 * Payment is intentionally modelled as pending integration: choosing immediate provider
 * submission does not turn an unintegrated payment flow into a fabricated paid invoice. */
export const ResellerDomainOperations: CollectionConfig<'reseller-domain-operations'> = {
  slug: 'reseller-domain-operations',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: apiKeyAware(authenticated),
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['createdAt', 'domain', 'operation', 'status', 'quoteAmount', 'currency'],
    description:
      'ردّ هر درخواست قابل‌صورتحساب. مبلغ و درصد سود در زمان درخواست snapshot می‌شوند. تا اتصال پلتفرم پرداخت، وضعیت پرداخت عمداً «در انتظار اتصال» باقی می‌ماند.',
    group: 'زیرساخت',
    useAsTitle: 'operation',
  },
  fields: [
    {
      name: 'domain',
      type: 'relationship',
      relationTo: 'reseller-domains',
      required: true,
      index: true,
      label: 'دامنه',
    },
    {
      name: 'operation',
      type: 'select',
      required: true,
      index: true,
      label: 'عملیات',
      options: [
        { label: 'ثبت جدید', value: 'register' },
        { label: 'انتقال', value: 'transfer' },
        { label: 'تمدید', value: 'renew' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      index: true,
      defaultValue: 'submitting',
      label: 'پیشرفت registrar',
      options: [
        { label: 'در حال ارسال', value: 'submitting' },
        { label: 'پذیرفته‌شده توسط registrar', value: 'providerAccepted' },
        { label: 'ناموفق', value: 'failed' },
        { label: 'لغوشده', value: 'cancelled' },
      ],
      access: { create: platformAdminFieldAccess, update: platformAdminFieldAccess },
    },
    {
      name: 'period',
      type: 'number',
      required: true,
      min: 1,
      max: 5,
      label: 'مدت (سال)',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'catalogueCost',
          type: 'number',
          required: true,
          min: 0,
          validate: validatePriceMinor,
          label: 'قیمت پایهٔ snapshot',
          admin: { readOnly: true, width: '33' },
        },
        {
          name: 'marginPercentage',
          type: 'number',
          required: true,
          min: 0,
          max: 1000,
          label: 'سود snapshot (%)',
          admin: { readOnly: true, width: '33' },
        },
        {
          name: 'quoteAmount',
          type: 'number',
          required: true,
          min: 0,
          validate: validatePriceMinor,
          label: 'قیمت فروش snapshot',
          admin: { readOnly: true, width: '33' },
        },
      ],
    },
    {
      name: 'currency',
      type: 'select',
      required: true,
      label: 'واحد قیمت',
      options: [
        { label: 'تومان', value: 'IRT' },
        { label: 'ریال', value: 'IRR' },
        { label: 'دلار', value: 'USD' },
        { label: 'یورو', value: 'EUR' },
      ],
    },
    {
      name: 'paymentState',
      type: 'select',
      required: true,
      defaultValue: 'pendingIntegration',
      label: 'پرداخت',
      options: [{ label: 'در انتظار اتصال پلتفرم پرداخت', value: 'pendingIntegration' }],
      access: { create: () => false, update: () => false },
      admin: {
        readOnly: true,
        description:
          'این CMS هنوز درگاه پرداخت/تأیید وجه این عملیات را ندارد. پاسخ registrar نیز پرداخت را تأیید نمی‌کند.',
      },
    },
    {
      name: 'providerSubmittedAt',
      type: 'date',
      label: 'زمان ارسال به registrar',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'providerRespondedAt',
      type: 'date',
      label: 'زمان پاسخ registrar',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'safeDetail',
      type: 'textarea',
      label: 'جزئیات امن',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
  ],
  labels: { singular: 'درخواست نمایندگی دامنه', plural: 'درخواست‌های نمایندگی دامنه' },
  timestamps: true,
}
