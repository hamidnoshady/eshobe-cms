import type { GlobalConfig } from 'payload'

import { platformAdmin } from '../access/platformAdmin'
import { gatewayOptions } from '@/payments/gateways/registry'

/**
 * The platform's switch for the whole payment-gateway module.
 *
 * A Payload global rather than a collection, and the only one in this codebase: it is
 * genuinely platform-wide. Every per-site setting on this platform is a collection marked
 * `isGlobal: true` in the multi-tenant plugin's map (`store`, `theme`, `header`, `footer`),
 * because Payload globals cannot be tenant-scoped — but "is the module on at all" is not a
 * tenant question. It is the operator's, and one answer for every site is the point.
 *
 * ## What the switch actually stops
 *
 * `paymentsModuleState()` (`src/payments/gateways/resolve.ts`) is consulted before any
 * gateway is listed to a storefront, resolved for a checkout, or allowed to be switched on
 * in a tenant's admin. Off means:
 *
 * - `GET /api/payments/methods` returns an empty list, so a headless renderer draws no
 *   online payment options;
 * - `POST /api/checkout` falls back to the site's `store.paymentProvider` — card-to-card or
 *   the generic HTTP adapter — so a shop keeps taking orders;
 * - `payment-gateways.enabled` cannot be set to `true` (`assertGatewayUsable` refuses);
 * - an order already `pending` with a gateway provider still *confirms*, because refusing to
 *   verify money that has moved would strand a paid order. Turning the module off stops new
 *   attempts, not in-flight ones.
 *
 * ## `allowedGateways`
 *
 * A second, narrower switch: which of the four the platform permits at all. A PSP the
 * operator has not contracted with, has dropped, or is having an outage with comes out of
 * this list and every tenant's row for it stops resolving — without anyone editing a
 * customer's configuration.
 *
 * Defaults are permissive *because the dangerous defaults are elsewhere*: a row's `enabled`
 * is `false` at creation, credentials can only be written by a platform admin, and a row
 * with none is refused. So a fresh deployment cannot transact by accident, and does not have
 * to visit this screen before the admin will offer the gateways.
 */
export const Payments: GlobalConfig = {
  slug: 'payments',
  access: {
    // Platform staff only, and not `apiKeyAware`: this document decides policy for every
    // tenant, so a single site's API key has no business reading it — the same reasoning
    // `platformApiKeyAware` documents for `provision-site`.
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    description:
      'کلید روشن/خاموشِ ماژول درگاه‌های پرداخت برای همهٔ سایت‌ها، و فهرست درگاه‌هایی که سکو اجازهٔ استفاده از آن‌ها را می‌دهد.',
    group: 'فروشگاه',
  },
  fields: [
    {
      name: 'moduleEnabled',
      type: 'checkbox',
      label: 'ماژول درگاه‌های پرداخت روشن است',
      defaultValue: true,
      admin: {
        description:
          'خاموش کردنِ این کلید، همهٔ درگاه‌های آنلاین را در همهٔ سایت‌ها متوقف می‌کند. سفارش‌ها از این پس با روش دریافت وجهِ خودِ سایت (کارت به کارت یا درگاه HTTP) ثبت می‌شوند؛ سفارش‌های در جریان، همان‌جا تأیید می‌شوند.',
      },
      required: true,
    },
    {
      name: 'allowedGateways',
      type: 'select',
      label: 'درگاه‌های مجاز',
      admin: {
        description:
          'درگاهی که اینجا نباشد، هیچ سایتی نمی‌تواند روشنش کند و هیچ خریداری نمی‌بیندش — بدون اینکه پیکربندی مشتری تغییر کند.',
      },
      defaultValue: () => gatewayOptions.map(({ value }) => value),
      hasMany: true,
      options: gatewayOptions,
      required: true,
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت عملیاتی',
      admin: {
        description:
          'برای اپراتورهای سکو: شمارهٔ قرارداد پذیرندگی، وضعیت محیط آزمایشی هر درگاه، یا دلیلِ خاموش بودنِ ماژول.',
      },
    },
  ],
  label: 'تنظیمات پرداخت',
}
