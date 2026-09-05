import type { CollectionConfig, Field, SelectField, TextField, Validate } from 'payload'

import type { GatewayId } from '@/payments/gateways/types'

import { authenticated } from '../access/authenticated'
import { apiKeyAware } from '../access/siteApiKey'
import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '../access/platformAdmin'
import { validatePriceMinor } from '../lib/money'

import {
  assertGatewayUsable,
  encryptGatewayCredentials,
  lockGatewayChoice,
  maskCredential,
  uniqueGatewayPerSite,
} from './hooks/paymentGatewaySecrets'
import { credentialFieldCatalogue, gatewayOptions } from '@/payments/gateways/registry'

/**
 * One tenant's configuration for one Iranian PSP — and the switch that turns it on.
 *
 * A row per `(site, gateway)` rather than a group of settings on the `store` singleton,
 * because the four providers need four disjoint credential sets and a site may enable
 * several at once: a `store` document with `zarinpalMerchantId`, `digipayUsername`,
 * `snappClientId` … beside each other is a form nobody can read and a schema that grows a
 * column per vendor.
 *
 * Tenant-scoped like `orders` and `products`, and registered in the multi-tenant plugin's
 * `collections` map for the reason `CLAUDE.md` states: an unregistered collection is shared
 * by every tenant, silently. Here that would mean one customer's merchant credentials
 * editable from another customer's admin.
 *
 * ## Who may do what
 *
 * The split is deliberate and is the whole security model of the module:
 *
 * - **Platform staff** create rows and are the only ones who can write a credential. A
 *   merchant's `client_secret` moves money out of a *customer's* account, so it is not a
 *   value a tenant's editor — or a compromised one — should hold.
 * - **A tenant's staff** (and that site's own API key) read their rows and flip `enabled`,
 *   `priority`, `displayName` and the amount window. That is the "manageable per tenant"
 *   half of the requirement, and it is everything a shop owner actually decides.
 * - **Nobody** reads a credential back. The fields are masked on every read, so the value
 *   that exists after a save is the ciphertext already in the row; `credentialsSummary` and
 *   its fingerprints are the answer to "did that save?".
 *
 * `read` is never public. The storefront gets its list from `GET /api/payments/methods`,
 * which publishes labels and amount windows and nothing else.
 */

/**
 * A base URL decides where this server sends a merchant's credentials, so it is validated
 * at the field and re-validated at fetch time (`net.ts`). Both, because the field check is
 * the one a platform admin sees immediately and the fetch check is the one that still holds
 * when a row was written by a seed, a migration or an older version of this file.
 */
const validateBaseUrl: Validate = (value) => {
  if (value === null || value === undefined || value === '') return true

  try {
    const url = new URL(String(value))

    return url.protocol === 'https:' || url.protocol === 'http:'
      ? true
      : 'نشانی باید با https:// شروع شود.'
  } catch {
    return 'نشانی معتبر نیست.'
  }
}

/**
 * The credential columns, generated from `credentialFieldCatalogue`.
 *
 * Generated rather than written out, because the catalogue is the same table the registry
 * uses to decide which keys are mandatory — writing these fields by hand would be a second
 * copy of it, and a copy is how a gateway ends up with a column nobody encrypts.
 *
 * Typed as two explicit branches instead of one object with a conditional `type`: Payload's
 * `Field` is a discriminated union, so `{ type: 'select' | 'text', options?: … }` is not a
 * member of it and TypeScript is right to refuse.
 */
const credentialFields = (): Field[] =>
  credentialFieldCatalogue.map((field): Field => {
    const shared = {
      name: field.key,
      label: field.label,
      access: {
        create: platformAdminFieldAccess,
        read: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      admin: {
        /**
         * Shown for the gateways that use this key. Not `required`, ever: Payload validates
         * required fields even when the condition hides them, so a ZarinPal row would fail
         * to save for missing a Snapp!Pay client id. `assertGatewayUsable` is what enforces
         * "complete", and it knows which gateway the row is.
         */
        condition: (data: unknown) =>
          field.gateways.includes((data as { gateway?: GatewayId })?.gateway as GatewayId),
        description: field.help,
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      },
      hooks: { afterRead: [maskCredential()] },
    }

    if (field.kind === 'select') {
      return { ...shared, options: field.options ?? [], type: 'select' } satisfies SelectField
    }

    // No `url` field type in Payload; a validated `text` is the same widget with the check
    // we actually want (https, or http where a deployment allows it).
    return {
      ...shared,
      type: 'text',
      ...(field.kind === 'url' ? { validate: validateBaseUrl } : {}),
    } satisfies TextField
  })

export const PaymentGateways: CollectionConfig<'payment-gateways'> = {
  slug: 'payment-gateways',
  access: {
    // Only platform staff create rows: creating one is meaningless without credentials, and
    // credentials are theirs to hold.
    create: platformAdmin,
    delete: platformAdmin,
    // A tenant's staff and that site's own API key. The plugin narrows both to one site;
    // the field-level access below is what keeps the credential columns out of reach of
    // everyone, including them.
    read: apiKeyAware(authenticated),
    update: apiKeyAware(authenticated),
  },
  admin: {
    defaultColumns: ['title', 'enabled', 'mode', 'priority', 'credentialsSummary'],
    description:
      'هر ردیف، پیکربندی یک درگاه برای یک سایت است. اعتبارنامه‌ها را فقط کارکنان سکو وارد می‌کنند و هیچ API آن‌ها را برنمی‌گرداند؛ صاحب سایت فقط روشن/خاموش بودن و ترتیب نمایش را تعیین می‌کند.',
    group: 'فروشگاه',
    useAsTitle: 'title',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      label: 'عنوان',
      access: { create: () => false, update: () => false },
      admin: {
        description: 'خودکار از روی درگاه و نام نمایشی ساخته می‌شود.',
        readOnly: true,
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'gateway',
          type: 'select',
          label: 'درگاه',
          admin: {
            description:
              'پس از ساخت ردیف قابل تغییر نیست: اعتبارنامهٔ رمزنگاری‌شدهٔ هر درگاه در ستون‌های همان درگاه معنا دارد.',
            width: '50',
          },
          options: gatewayOptions,
          required: true,
        },
        {
          name: 'mode',
          type: 'select',
          label: 'محیط',
          admin: {
            description:
              '«آزمایشی» درخواست‌ها را به محیط تست همان درگاه می‌فرستد. روی سایت فعال، این وضعیت به خریدار هم نشان داده می‌شود.',
            width: '50',
          },
          defaultValue: 'live',
          options: [
            { label: 'عملیاتی (live)', value: 'live' },
            { label: 'آزمایشی (sandbox)', value: 'sandbox' },
          ],
          required: true,
        },
      ],
    },
    {
      name: 'enabled',
      type: 'checkbox',
      label: 'فعال برای خریداران',
      defaultValue: false,
      admin: {
        description:
          'خاموش یعنی این درگاه نه در فروشگاه نمایش داده می‌شود و نه در API. روشن کردنش نیاز دارد اعتبارنامه‌ها کامل باشند و واحد پول سایت با درگاه بخواند.',
      },
    },
    {
      name: 'displayName',
      type: 'text',
      label: 'نام نمایشی',
      admin: {
        description:
          'اختیاری. خالی بماند، نام رسمی درگاه نمایش داده می‌شود. برای سایت‌های دوزبانه در هر زبان جداگانه نوشته می‌شود.',
      },
      localized: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'priority',
          type: 'number',
          label: 'ترتیب نمایش',
          admin: {
            description: 'عدد کمتر یعنی بالاتر در فهرست. درگاه اول، انتخاب پیش‌فرض خرید است.',
            width: '50',
          },
          defaultValue: 100,
          max: 9999,
          min: 0,
          required: true,
        },
        {
          name: 'minAmount',
          type: 'number',
          label: 'حداقل مبلغ',
          admin: {
            description: 'به واحد پول سایت. خالی یعنی بدون حداقل (حداقل خودِ درگاه اعمال می‌شود).',
            width: '50',
          },
          min: 0,
          validate: validatePriceMinor,
        },
      ],
    },
    {
      name: 'maxAmount',
      type: 'number',
      label: 'حداکثر مبلغ',
      admin: {
        description:
          'به واحد پول سایت. برای سقف شاپرک یا سقفی که فروشگاه روی پرداخت اقساطی می‌خواهد.',
      },
      min: 0,
      validate: validatePriceMinor,
    },
    {
      name: 'credentials',
      type: 'group',
      label: 'اعتبارنامه‌ها و تنظیمات فنی',
      admin: {
        description:
          'فقط کارکنان سکو. هر مقدار رمزنگاری‌شده (AES-256-GCM) ذخیره می‌شود و بعد از ذخیره، خالی نمایش داده می‌شود — خالی گذاشتن یعنی «تغییر نده». ' +
          'پلت‌فرم ویجت رمزِ عبور ندارد، پس مقدار هنگام تایپ دیده می‌شود؛ محافظت، در ذخیره‌سازی و در خواندن است.',
      },
      fields: credentialFields(),
    },
    {
      name: 'clearCredentials',
      type: 'checkbox',
      label: 'پاک کردن همهٔ اعتبارنامه‌ها',
      admin: {
        condition: (_data, _siblingData, { user }) => isPlatformAdmin(user),
        description:
          'تیک بزنید و ذخیره کنید تا هر چه در این ردیف ذخیره شده پاک شود. بدون تیک، فیلدهای خالی یعنی «همان مقدار قبلی».',
      },
      defaultValue: false,
      access: {
        create: platformAdminFieldAccess,
        read: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت اعتبارنامه‌ها',
      access: { create: () => false, update: () => false },
      admin: {
        description:
          'چون مقدار رمزها هرگز برگردانده نمی‌شود، این خلاصه و انگشت‌های هشِ کنارش تنها راهِ فهمیدنِ «ذخیره شد یا نه» است.',
        readOnly: true,
      },
    },
    {
      name: 'credentialsUpdatedAt',
      type: 'date',
      label: 'آخرین تغییر اعتبارنامه‌ها',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      type: 'collapsible',
      label: 'آخرین خودآزمایی',
      fields: [
        {
          name: 'selfTestOk',
          type: 'checkbox',
          label: 'نتیجهٔ خودآزمایی',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'selfTestDetail',
          type: 'text',
          label: 'جزئیات',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'selfTestAt',
          type: 'date',
          label: 'زمان',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
      ],
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت داخلی',
      admin: {
        description: 'برای خودتان: شمارهٔ قرارداد، نام کارشناس درگاه، تاریخ انقضای اعتبارنامه.',
      },
    },
  ],
  hooks: {
    beforeChange: [
      // Order matters: encryption first, so `assertGatewayUsable` inspects the ciphertext
      // that is actually about to be written.
      encryptGatewayCredentials,
      lockGatewayChoice,
      uniqueGatewayPerSite,
      assertGatewayUsable,
    ],
  },
  labels: {
    singular: 'درگاه پرداخت',
    plural: 'درگاه‌های پرداخت',
  },
  timestamps: true,
}
