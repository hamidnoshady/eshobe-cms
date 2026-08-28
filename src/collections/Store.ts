import type { CollectionConfig } from 'payload'

import { authenticated } from '../access/authenticated'
import { currencyCodes, currencies } from '../lib/money'
import { paymentProviderOptions } from '../payments'
import { scopedPublicRead } from '../access/siteRead'

/**
 * A store site's commerce settings — one document per site, edited like a global.
 *
 * Per-site, not per-product and not platform-wide, because both of those get the
 * answer wrong: a currency is a property of who is being paid, and a single global
 * setting would make "sell in Toman" the platform's opinion instead of the
 * customer's.
 *
 * Registered `isGlobal: true` in the multi-tenant plugin's `collections` map, like
 * `theme`, `header` and `footer` — Payload globals cannot be tenant-scoped.
 */
export const Store: CollectionConfig<'store'> = {
  slug: 'store',
  access: {
    create: authenticated,
    delete: authenticated,
    // Public, and only because everything public is a rendering input: the
    // storefront needs the currency to draw a price at all. The one field a visitor
    // must never see — the card number to transfer to — locks its own read below.
    read: scopedPublicRead(),
    update: authenticated,
  },
  labels: {
    singular: 'فروشگاه',
    plural: 'فروشگاه',
  },
  fields: [
    {
      name: 'currency',
      type: 'select',
      label: 'واحد پول',
      defaultValue: 'IRT',
      options: currencyCodes.map((code) => ({
        label:
          code === 'IRT'
            ? 'تومان (پیش‌فرض)'
            : code === 'IRR'
              ? 'ریال (واحد رسمی — ۱۰ ریال = ۱ تومان)'
              : `${currencies[code].unit.en} (${code})`,
        value: code,
      })),
      required: true,
      admin: {
        description:
          'همهٔ قیمت‌های همین سایت بر حسب همین واحد نوشته و محاسبه می‌شوند. تبدیل تومان به ریال در کد انجام نمی‌شود: واحد را یک‌بار انتخاب کنید.',
      },
    },
    {
      name: 'paymentProvider',
      type: 'select',
      label: 'روش دریافت وجه',
      admin: {
        description:
          '«کارت به کارت» به شمارهٔ کارت پایین نیاز دارد؛ «درگاه HTTP» به متغیرهای محیطی PAYMENT_HTTP_* — بدون آن‌ها، پرداخت با خطای «پیکربندی نشده» رد می‌شود.',
      },
      defaultValue: 'bank',
      options: paymentProviderOptions,
      required: true,
    },
    {
      name: 'paymentInstructions',
      type: 'textarea',
      label: 'دستور پرداخت',
      admin: {
        description:
          'شمارهٔ کارت یا هر متنی که خریدار باید ببیند تا پول را بفرستد. در API عمومی و در جست‌وجو نمایش داده نمی‌شود.',
      },
      // Field-level, not just a render-time choice: `store` is publicly readable so
      // the storefront can format prices, and a card number must not ride along in
      // that response. `src/lib/order-receipt.ts` is the only reader that gets it,
      // for one order, behind a signed link.
      access: {
        read: ({ req: { user } }) => Boolean(user),
      },
      localized: true,
    },
  ],
}
