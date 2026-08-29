import type { CollectionConfig } from 'payload'

import { authenticated } from '../access/authenticated'
import { platformAdmin } from '../access/platformAdmin'
import { MAX_ORDER_QUANTITY } from '../lib/checkout'
import { currencyCodes, validatePriceMinor } from '../lib/money'
import { paymentProviderOptions } from '../payments'
import { snapshotOrder } from './hooks/snapshotOrder'
import { settleStock } from './hooks/settleStock'

/**
 * One line-item order: a buyer asked to buy a product, and the money either arrived
 * or it did not.
 *
 * No cart. The catalogue's buy button turns one product and a quantity into this
 * row, which is the whole of what PLAN §6 decision #5 asked for ("catalog + checkout
 * first, cart later") and the shape the Wave 7 spike landed on. A `cart` document
 * would only be worth its keep once a store can hold more than one line.
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
    read: authenticated,
    update: authenticated,
  },
  admin: {
    defaultColumns: ['reference', 'productTitle', 'total', 'status', 'createdAt'],
    description: 'فقط کارکنان سایت می‌توانند سفارش را ببینند. نشانی تأیید خرید با امضای یک‌بارمصرف باز می‌شود.',
    group: 'فروشگاه',
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
          max: MAX_ORDER_QUANTITY,
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
          validate: (value: string | null | undefined) => {
            if (!value) return true
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
      ],
    },
  ],
  hooks: {
    afterChange: [settleStock],
    beforeValidate: [snapshotOrder],
  },
  timestamps: true,
}
