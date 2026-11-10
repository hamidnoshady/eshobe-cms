import type { CollectionConfig } from 'payload'

import { authenticated } from '../access/authenticated'
import { platformAdmin } from '../access/platformAdmin'
import { hiddenFromOperators } from '@/admin/visibility'
import { apiKeyAware } from '../access/siteApiKey'
import { currencyCodes, validatePriceMinor } from '../lib/money'
import { isMigrationWrite } from '../lib/migration-context'
import { idOf } from '../lib/ids'
import { isGatewayProvider, paymentProviderOptions } from '../payments'
import { restrictApiKeyOrderWrite } from './hooks/restrictApiKeyOrderWrite'
import { snapshotOrder } from './hooks/snapshotOrder'
import { emitOrderPaid } from './hooks/emitOrderPaid'
import { emitOrderReversal } from './hooks/emitOrderReversal'
import { settleStock } from './hooks/settleStock'
import { migrationSourceField } from './fields/migrationSource'
import { validateOrderCommerce } from './hooks/validateOrderCommerce'

/**
 * An order. The storefront's buy button still creates the original
 * one-product order, but the row is now genuinely multi-line (`items`) so a
 * WooCommerce order is never flattened into its first product (issue #166).
 * The historic `product`/`quantity`/`unitPrice` fields remain as a mirror of
 * the first line: checkout, receipts, the theme API and pre-existing rows
 * keep the shape they have always read, while totals, coupons, shipping,
 * tax, refunds and payment history live in the expanded fields below.
 *
 * Prices are **snapshots**, in the site's minor currency unit: a product's price
 * changes next season, the order must still say what was paid. Same for `currency`
 * — a site that later switches Rial→Toman must not rewrite history by a factor of ten.
 *
 * `read` is `authenticated`, never public: an order id is a uuid, not a capability.
 * The buyer-facing confirmation page reaches this row through a signed receipt in
 * `src/lib/order-receipt.ts`, which is the only front-end path to it.
 */
export const Orders: CollectionConfig<'orders'> = {
  slug: 'orders',
  access: {
    // Not `() => true`: this row is created by our checkout endpoint, with the site
    // resolved from the `Host` header. Left open, it would be the same hole the form
    // builder's submissions had — an anonymous POST choosing which site the document
    // belongs to — with money on the other end of it.
    create: authenticated,
    delete: platformAdmin,
    // A site API key (WAVE-9 §9.4) reads and moves the status of its own site's
    // orders — never creates or deletes one, and `restrictApiKeyOrderWrite` (below)
    // is what keeps an update to *just* the status.
    read: apiKeyAware(authenticated),
    update: apiKeyAware(authenticated),
  },
  admin: {
    defaultColumns: ['reference', 'productTitle', 'total', 'status', 'createdAt'],
    description: 'فقط کارکنان سایت می‌توانند سفارش را ببینند. نشانی تأیید خرید با امضای یک‌بارمصرف باز می‌شود.',
    group: 'فروشگاه',
    hidden: hiddenFromOperators,
    useAsTitle: 'reference',
  },
  labels: {
    singular: 'سفارش',
    plural: 'سفارش‌ها',
  },
  fields: [
    {
      // What the buyer reads out on the phone. Random rather than sequential on
      // purpose: a per-site counter needs a table of its own and would leak "we sold
      // ۴۰ things this week" to anyone who guesses the next one.
      name: 'reference',
      type: 'text',
      label: 'کد پیگیری',
      admin: {
        readOnly: true,
      },
      index: true,
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'pending',
      index: true,
      options: [
        { label: 'در انتظار پرداخت', value: 'pending' },
        { label: 'پرداخت‌شده', value: 'paid' },
        { label: 'لغو شده', value: 'cancelled' },
        { label: 'بازگشت خورده', value: 'refunded' },
      ],
      required: true,
    },
    {
      name: 'product',
      type: 'relationship',
      label: 'محصول',
      maxDepth: 1,
      relationTo: 'products',
      required: true,
    },
    {
      // Snapshot, not a join: the product row stays editable and an order's history
      // does not. Renaming or unpublishing a product must not rewrite a receipt.
      name: 'productTitle',
      type: 'text',
      label: 'عنوان محصول',
      admin: {
        description: 'کپیِ عنوان لحظهٔ ثبت سفارش.',
        readOnly: true,
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'quantity',
          type: 'number',
          label: 'تعداد',
          defaultValue: 1,
          // The storefront still caps a fresh purchase at `MAX_ORDER_QUANTITY`
          // in the checkout endpoint. The stored row must also be able to say
          // what a historical Woo order actually contained, so the schema
          // ceiling is a sanity bound, not the purchasable limit.
          max: 1000000,
          min: 1,
          required: true,
          admin: { width: '50' },
        },
        {
          name: 'unitPrice',
          type: 'number',
          label: 'قیمت هر عدد',
          min: 0,
          required: true,
          admin: {
            description: 'کپیِ قیمت لحظهٔ خرید، نه خودِ قیمت.',
            readOnly: true,
            width: '50',
          },
          validate: validatePriceMinor,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'total',
          type: 'number',
          label: 'مبلغ کل',
          min: 0,
          required: true,
          admin: {
            readOnly: true,
            width: '50',
          },
          validate: validatePriceMinor,
        },
        {
          name: 'currency',
          type: 'select',
          label: 'واحد پول',
          options: currencyCodes,
          required: true,
          admin: {
            readOnly: true,
            width: '50',
          },
        },
      ],
    },
    {
      name: 'buyer',
      type: 'group',
      label: 'خریدار',
      // Not localized: a name and a phone number are the same in every language the
      // site serves, and two copies would be two chances to disagree.
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام و نام خانوادگی',
          required: true,
        },
        {
          name: 'phone',
          type: 'text',
          label: 'تلفن همراه',
          required: true,
          admin: {
            description: 'برای هماهنگی ارسال. فقط رقم.',
          },
          validate: (value: string | null | undefined, options?: unknown) => {
            if (!value) return true

            // A historical import preserves the phone the source order
            // actually carried (landline, foreign, legacy formatting). That
            // is archived business data under an audited migration context,
            // not a new buyer typing at checkout — checkout keeps the
            // Iranian-mobile rule below.
            const root = options as
              | undefined
              | { data?: { site?: unknown }; req?: Parameters<typeof isMigrationWrite>[0] }
            if (root?.req && isMigrationWrite(root.req, idOf(root.data?.site) ?? undefined)) {
              return true
            }

            const digits = String(value).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

            return /^0?9\d{9}$/.test(digits)
              ? true
              : 'شمارهٔ موبایل ایرانی معتبر وارد کنید (۱۱ رقم، با ۰ یا بدون آن).'
          },
        },
        {
          name: 'email',
          type: 'email',
          label: 'ایمیل',
        },
        {
          name: 'note',
          type: 'textarea',
          label: 'یادداشت',
        },
      ],
    },
    {
      name: 'payment',
      type: 'group',
      label: 'پرداخت',
      admin: {
        description: 'پر کردنش کارِ درگاه است، نه کاربر.',
      },
      fields: [
        {
          name: 'provider',
          type: 'select',
          label: 'درگاه',
          options: paymentProviderOptions,
          required: true,
        },
        {
          name: 'reference',
          type: 'text',
          label: 'کد رهگیری درگاه',
        },
        {
          name: 'paidAt',
          type: 'date',
          label: 'زمان پرداخت',
        },
        {
          name: 'mode',
          type: 'select',
          label: 'محیط پرداخت',
          admin: {
            /**
             * Only shown when the provider is one of the four PSPs; `bank` and `http` have no
             * sandbox. It is a snapshot of the gateway row's `mode` at checkout time, because
             * that row can be flipped to `live` afterwards and an order that was *taken* in
             * sandbox must still say so — a support conversation about an unpaid order starts
             * from this field.
             */
            condition: (_data, siblingData) => isGatewayProvider(siblingData?.provider as string),
            description: '«آزمایشی» یعنی پولی جابه‌جا نشده است.',
          },
          options: [
            { label: 'عملیاتی', value: 'live' },
            { label: 'آزمایشی', value: 'sandbox' },
          ],
        },
        {
          name: 'gatewayData',
          type: 'json',
          label: 'دادهٔ درگاه',
          access: {
            // Not writable by any caller. `applyPayment` (`src/endpoints/checkout.ts`) writes
            // it under `overrideAccess`, which is the only path that should: it is the
            // adapter's account of what the PSP said, and a tenant able to set it could
            // manufacture a `settled: true` for an order nobody paid.
            create: () => false,
            update: () => false,
          },
          admin: {
            description:
              'آنچه درگاه برگرداند: شناسهٔ توکن، مبلغ تأییدشده، وضعیت تسویه، کد خطا. برای تطبیق با پنل پذیرنده. این مقدار هیچ‌وقت دلیلِ «پرداخت‌شده» شدن سفارش نیست — آن را خودِ سرور از درگاه می‌پرسد.',
            readOnly: true,
          },
        },
      ],
    },
    {
      name: 'items',
      type: 'array',
      label: 'سطرهای سفارش',
      admin: {
        description: 'سطر اول در فیلدهای قدیمی «محصول/تعداد/قیمت» هم بازتاب می‌یابد تا API و رسیدهای قبلی همان بمانند.',
      },
      labels: { plural: 'سطرها', singular: 'سطر' },
      fields: [
        { name: 'product', type: 'relationship', label: 'محصول', relationTo: 'products', required: true },
        { name: 'productTitle', type: 'text', label: 'عنوان هنگام خرید', required: true },
        { name: 'variationKey', type: 'text', label: 'کلید تنوع', index: true },
        { name: 'variationLabel', type: 'text', label: 'برچسب تنوع هنگام خرید' },
        { name: 'sku', type: 'text', label: 'کد کالا هنگام خرید' },
        {
          name: 'externalInventory',
          type: 'checkbox',
          label: 'موجودی متعلق به سامانهٔ مبدأ هنگام سفارش',
          defaultValue: false,
          admin: { readOnly: true },
        },
        {
          name: 'modifiers',
          type: 'array',
          label: 'افزودنی‌های انتخاب‌شده هنگام سفارش',
          admin: { readOnly: true },
          fields: [
            { name: 'groupSourceId', type: 'text', label: 'شناسهٔ گروه', required: true },
            { name: 'groupLabel', type: 'text', label: 'عنوان گروه', required: true },
            { name: 'optionSourceId', type: 'text', label: 'شناسهٔ گزینه', required: true },
            { name: 'optionLabel', type: 'text', label: 'عنوان گزینه', required: true },
            { name: 'quantity', type: 'number', label: 'تعداد', defaultValue: 1, min: 1, required: true },
            {
              name: 'priceDelta',
              type: 'number',
              label: 'تغییر قیمت در واحد خرد',
              required: true,
              validate: (value: unknown) => Number.isSafeInteger(value) ? true : 'مبلغ باید عدد صحیح باشد.',
            },
          ],
        },
        { name: 'quantity', type: 'number', label: 'تعداد', max: 1000000, min: 1, required: true },
        { name: 'unitPrice', type: 'number', label: 'قیمت واحد', min: 0, required: true, validate: validatePriceMinor },
        { name: 'subtotal', type: 'number', label: 'جمع پیش از تخفیف', min: 0, required: true, validate: validatePriceMinor },
        { name: 'taxTotal', type: 'number', label: 'مالیات سطر', defaultValue: 0, min: 0, validate: validatePriceMinor },
        { name: 'total', type: 'number', label: 'جمع سطر پس از تخفیف', min: 0, required: true, validate: validatePriceMinor },
        { name: 'sourceLineId', type: 'text', label: 'شناسه سطر در مبدأ', index: true },
      ],
    },
    {
      name: 'customer',
      type: 'relationship',
      label: 'مشتری فروشگاه',
      relationTo: 'customers',
    },
    { name: 'customerNote', type: 'textarea', label: 'یادداشت مشتری' },
    {
      name: 'billingAddress',
      type: 'group',
      label: 'نشانی صورت‌حساب',
      fields: [
        { name: 'firstName', type: 'text', label: 'نام' },
        { name: 'lastName', type: 'text', label: 'نام خانوادگی' },
        { name: 'company', type: 'text', label: 'شرکت' },
        { name: 'address1', type: 'text', label: 'نشانی ۱' },
        { name: 'address2', type: 'text', label: 'نشانی ۲' },
        { name: 'city', type: 'text', label: 'شهر' },
        { name: 'state', type: 'text', label: 'استان' },
        { name: 'postcode', type: 'text', label: 'کد پستی' },
        { name: 'country', type: 'text', label: 'کشور' },
        { name: 'phone', type: 'text', label: 'تلفن' },
        { name: 'email', type: 'email', label: 'ایمیل' },
      ],
    },
    {
      name: 'shippingAddress',
      type: 'group',
      label: 'نشانی ارسال',
      fields: [
        { name: 'firstName', type: 'text', label: 'نام' },
        { name: 'lastName', type: 'text', label: 'نام خانوادگی' },
        { name: 'company', type: 'text', label: 'شرکت' },
        { name: 'address1', type: 'text', label: 'نشانی ۱' },
        { name: 'address2', type: 'text', label: 'نشانی ۲' },
        { name: 'city', type: 'text', label: 'شهر' },
        { name: 'state', type: 'text', label: 'استان' },
        { name: 'postcode', type: 'text', label: 'کد پستی' },
        { name: 'country', type: 'text', label: 'کشور' },
        { name: 'phone', type: 'text', label: 'تلفن' },
        { name: 'email', type: 'email', label: 'ایمیل' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'subtotal', type: 'number', label: 'جمع سطرها', admin: { width: '25' }, min: 0, validate: validatePriceMinor },
        { name: 'discountTotal', type: 'number', label: 'تخفیف', admin: { width: '25' }, defaultValue: 0, min: 0, validate: validatePriceMinor },
        { name: 'shippingTotal', type: 'number', label: 'هزینه ارسال', admin: { width: '25' }, defaultValue: 0, min: 0, validate: validatePriceMinor },
        { name: 'taxTotal', type: 'number', label: 'مالیات', admin: { width: '25' }, defaultValue: 0, min: 0, validate: validatePriceMinor },
      ],
    },
    {
      name: 'coupons',
      type: 'array',
      label: 'کوپن‌های اعمال‌شده',
      labels: { plural: 'کوپن‌ها', singular: 'کوپن' },
      fields: [
        { name: 'coupon', type: 'relationship', label: 'کوپن', relationTo: 'coupons' },
        { name: 'code', type: 'text', label: 'کد هنگام خرید', required: true },
        { name: 'discount', type: 'number', label: 'مبلغ تخفیف', defaultValue: 0, min: 0, validate: validatePriceMinor },
      ],
    },
    {
      name: 'shippingLines',
      type: 'array',
      label: 'سطرهای ارسال',
      labels: { plural: 'سطرهای ارسال', singular: 'سطر ارسال' },
      fields: [
        { name: 'methodId', type: 'text', label: 'شناسه روش' },
        { name: 'methodTitle', type: 'text', label: 'عنوان روش', required: true },
        { name: 'total', type: 'number', label: 'هزینه', defaultValue: 0, min: 0, validate: validatePriceMinor },
        { name: 'taxTotal', type: 'number', label: 'مالیات ارسال', defaultValue: 0, min: 0, validate: validatePriceMinor },
      ],
    },
    {
      name: 'taxLines',
      type: 'array',
      label: 'سطرهای مالیات',
      labels: { plural: 'سطرهای مالیات', singular: 'سطر مالیات' },
      fields: [
        { name: 'label', type: 'text', label: 'عنوان', required: true },
        { name: 'rateCode', type: 'text', label: 'کد نرخ' },
        { name: 'ratePercent', type: 'number', label: 'درصد', min: 0 },
        { name: 'taxTotal', type: 'number', label: 'مالیات کالا', defaultValue: 0, min: 0, validate: validatePriceMinor },
        { name: 'shippingTaxTotal', type: 'number', label: 'مالیات ارسال', defaultValue: 0, min: 0, validate: validatePriceMinor },
      ],
    },
    {
      name: 'fees',
      type: 'array',
      label: 'هزینه‌های دیگر',
      labels: { plural: 'هزینه‌ها', singular: 'هزینه' },
      fields: [
        { name: 'name', type: 'text', label: 'عنوان', required: true },
        {
          name: 'total',
          type: 'number',
          label: 'مبلغ (منفی یعنی کسر از سفارش)',
          required: true,
          validate: (value: number | null | undefined) =>
            value === null || value === undefined || Number.isInteger(value)
              ? true
              : 'مبلغ هزینه باید عدد صحیح در واحد خرد باشد.',
        },
        { name: 'taxTotal', type: 'number', label: 'مالیات', defaultValue: 0, min: 0, validate: validatePriceMinor },
      ],
    },
    {
      name: 'refunds',
      type: 'array',
      label: 'بازپرداخت‌ها',
      labels: { plural: 'بازپرداخت‌ها', singular: 'بازپرداخت' },
      fields: [
        { name: 'sourceId', type: 'text', label: 'شناسه در مبدأ', index: true },
        { name: 'amount', type: 'number', label: 'مبلغ', min: 0, required: true, validate: validatePriceMinor },
        { name: 'reason', type: 'textarea', label: 'دلیل' },
        { name: 'refundedAt', type: 'date', label: 'زمان بازپرداخت' },
        { name: 'transactionId', type: 'text', label: 'شناسه تراکنش' },
      ],
    },
    {
      name: 'paymentHistory',
      type: 'array',
      label: 'تاریخچه پرداخت',
      labels: { plural: 'رویدادهای پرداخت', singular: 'رویداد پرداخت' },
      fields: [
        { name: 'methodId', type: 'text', label: 'شناسه روش مبدأ' },
        { name: 'methodTitle', type: 'text', label: 'عنوان روش' },
        { name: 'transactionId', type: 'text', label: 'شناسه تراکنش' },
        { name: 'status', type: 'text', label: 'وضعیت' },
        { name: 'amount', type: 'number', label: 'مبلغ', min: 0, validate: validatePriceMinor },
        { name: 'paidAt', type: 'date', label: 'زمان' },
        { name: 'note', type: 'textarea', label: 'یادداشت' },
      ],
    },
    migrationSourceField({ optional: true }),
  ],
  hooks: {
    afterChange: [settleStock, emitOrderPaid, emitOrderReversal],
    beforeChange: [restrictApiKeyOrderWrite],
    beforeValidate: [validateOrderCommerce, snapshotOrder],
  },
  timestamps: true,
}
