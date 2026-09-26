import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

import { maskBillingSecret } from '@/billing/auth/credentials'

/**
 * The credential CMS uses to talk to central Billing, and that central Billing
 * uses to push entitlement projections back.
 *
 * Scope is `billing.usage.write` and `billing.entitlement.write` only. It is
 * not a platform key: it cannot change plans, wallets, invoices or settings.
 * The secret is returned once, by the issue endpoint, and blanked on every read.
 */
export const BillingServiceCredentials: CollectionConfig = {
  slug: 'billing-service-credentials',
  access: {
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['label', 'keyId', 'status', 'updatedAt'],
    description:
      'اعتبارنامهٔ سرویس صورت‌حساب. راز فقط یک‌بار هنگام صدور نشان داده می‌شود و بعد از آن خالی برمی‌گردد.',
    group: PLATFORM_GROUPS.integrations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'label',
  },
  labels: { plural: 'اعتبارنامه‌های صورت‌حساب', singular: 'اعتبارنامهٔ صورت‌حساب' },
  hooks: {
    afterRead: [maskBillingSecret],
  },
  fields: [
    { name: 'label', type: 'text', required: true, label: 'عنوان' },
    { name: 'keyId', type: 'text', required: true, unique: true, index: true, label: 'شناسهٔ کلید' },
    {
      name: 'secret',
      type: 'text',
      required: true,
      label: 'راز',
      admin: { readOnly: true, description: 'ذخیرهٔ رمزشده. در خواندن خالی است.' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      label: 'وضعیت',
      options: [
        { label: 'فعال', value: 'active' },
        { label: 'باطل', value: 'revoked' },
      ],
    },
    { name: 'scopes', type: 'json', label: 'دامنه‌ها' },
    { name: 'lastUsedAt', type: 'date', label: 'آخرین استفاده' },
  ],
  timestamps: true,
}
