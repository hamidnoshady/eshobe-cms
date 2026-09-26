import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { PLATFORM_GROUPS } from '@/admin/visibility'
import { currencyCodes, currencies } from '@/lib/money'
import { freezeCommercialWrites } from './hooks/freezeCommercialWrites'
import { computeInvoiceTotals, stampInvoiceNumber } from './hooks/invoiceTotals'

/**
 * Legacy archive of invoices this CMS used to issue. Customer billing, payment
 * and dunning belong to cafe-restaurant-pos. Rows are readable for audit and
 * are not a ledger the CMS still writes.
 *
 * Money is stored exactly as `orders` stores it and for the same reasons
 * (`src/lib/money.ts`): **integer minor units**, with the currency snapshotted onto
 * the row. An invoice is a historical fact — the plan's price changing next quarter
 * must not rewrite what a customer was charged last one, which is why `lines` hold
 * their own amounts rather than pointing at the plan's current `price`.
 *
 * Totals are derived in a hook, never typed (`computeInvoiceTotals`). An invoice
 * whose `total` disagrees with the sum of its lines is the single worst row this
 * collection could hold, and the only way to guarantee it cannot exist is to refuse
 * to accept the number at all.
 *
 * ## What this is not
 *
 * Not a payment gateway integration. The platform's own PSP relationship is out of
 * scope here on purpose — `payment-gateways` holds *customers'* merchant accounts
 * for *their* shoppers. An invoice records `paidAt` and a free-text reference,
 * which is what an operator reconciling a bank transfer actually needs. A future
 * hosted-checkout flow writes the same two fields.
 */
export const Invoices: CollectionConfig<'invoices'> = {
  slug: 'invoices',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['number', 'site', 'total', 'status', 'issuedAt', 'dueAt'],
    description:
      'بایگانی فقط‌خواندنیِ صورتحساب‌های قدیمی. مبلغ مشتری اینجا محاسبه نمی‌شود.',
    group: PLATFORM_GROUPS.billing,
    hidden: true,
    useAsTitle: 'number',
  },
  labels: { plural: 'صورتحساب‌ها', singular: 'صورتحساب' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'number',
          type: 'text',
          label: 'شمارهٔ صورتحساب',
          unique: true,
          index: true,
          access: { create: () => false, update: () => false },
          admin: {
            width: '50',
            readOnly: true,
            description: 'خودکار: INV-<سال>-<شمارهٔ ترتیبی>. میلادی است چون یک کلید است، نه یک تاریخ برای خواندن.',
          },
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
            { label: 'صادر شده', value: 'issued' },
            { label: 'پرداخت‌شده', value: 'paid' },
            { label: 'باطل', value: 'void' },
            { label: 'مشکوک‌الوصول', value: 'uncollectible' },
          ],
          admin: { width: '50' },
        },
      ],
    },
    {
      name: 'subscription',
      type: 'relationship',
      relationTo: 'subscriptions',
      index: true,
      label: 'اشتراک',
      admin: { description: 'اختیاری: یک صورتحساب دستی (مثلاً کار سفارشی) به هیچ اشتراکی وصل نیست.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'issuedAt',
          type: 'date',
          label: 'تاریخ صدور',
          admin: { width: '33' },
        },
        {
          name: 'dueAt',
          type: 'date',
          label: 'مهلت پرداخت',
          index: true,
          admin: { width: '33' },
        },
        {
          name: 'paidAt',
          type: 'date',
          label: 'تاریخ پرداخت',
          admin: { width: '34', description: 'با ثبت این تاریخ، وضعیت خودکار «پرداخت‌شده» می‌شود.' },
        },
      ],
    },
    {
      name: 'currency',
      type: 'select',
      label: 'ارز',
      defaultValue: 'IRT',
      required: true,
      options: currencyCodes.map((code) => ({
        label: code === 'IRT' ? 'تومان' : `${currencies[code].unit.fa} (${code})`,
        value: code,
      })),
      admin: {
        description: 'روی خود صورتحساب ثبت می‌شود؛ تغییر ارز سکو، صورتحساب‌های گذشته را بازنویسی نمی‌کند.',
        position: 'sidebar',
      },
    },
    {
      name: 'lines',
      type: 'array',
      label: 'ردیف‌ها',
      labels: { plural: 'ردیف‌ها', singular: 'ردیف' },
      minRows: 1,
      admin: { initCollapsed: false },
      fields: [
        {
          name: 'description',
          type: 'text',
          label: 'شرح',
          required: true,
          admin: { description: 'مثلاً «اشتراک حرفه‌ای، مهر ۱۴۰۵» یا «۵۰ گیگابایت فضای اضافه».' },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'quantity',
              type: 'number',
              label: 'تعداد',
              defaultValue: 1,
              min: 0,
              required: true,
              admin: { step: 1, width: '33' },
            },
            {
              name: 'unitAmount',
              type: 'number',
              label: 'مبلغ واحد (واحد خرد)',
              defaultValue: 0,
              min: 0,
              required: true,
              admin: { step: 1, width: '33' },
            },
            {
              name: 'amount',
              type: 'number',
              label: 'جمع ردیف',
              access: { create: () => false, update: () => false },
              admin: { readOnly: true, step: 1, width: '34' },
            },
          ],
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'discount',
          type: 'number',
          label: 'تخفیف (واحد خرد)',
          defaultValue: 0,
          min: 0,
          admin: { step: 1, width: '50', description: 'قبل از مالیات کسر می‌شود و هرگز بیشتر از جمع ردیف‌ها نیست.' },
        },
        {
          name: 'taxPercent',
          type: 'number',
          label: 'مالیات (درصد)',
          defaultValue: 0,
          min: 0,
          max: 100,
          admin: { width: '50', description: 'روی جمعِ پس از تخفیف اعمال می‌شود.' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'subtotal',
          type: 'number',
          label: 'جمع ردیف‌ها',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true, width: '33' },
        },
        {
          name: 'tax',
          type: 'number',
          label: 'مالیات',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true, width: '33' },
        },
        {
          name: 'total',
          type: 'number',
          label: 'مبلغ نهایی',
          index: true,
          access: { create: () => false, update: () => false },
          admin: { readOnly: true, width: '34' },
        },
      ],
    },
    {
      name: 'paymentReference',
      type: 'text',
      label: 'مرجع پرداخت',
      admin: { description: 'شمارهٔ پیگیری واریز، شمارهٔ چک، یا شناسهٔ تراکنش درگاه.' },
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت',
      admin: { description: 'روی نسخهٔ چاپی صورتحساب نمایش داده می‌شود.' },
    },
  ],
  hooks: {
    beforeChange: [computeInvoiceTotals],
    beforeValidate: [freezeCommercialWrites, stampInvoiceNumber],
  },
  timestamps: true,
}
