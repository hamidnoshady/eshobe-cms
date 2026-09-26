import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { PLATFORM_GROUPS } from '@/admin/visibility'

/** One row per signed request body. A second insert of the same fingerprint is a replay. */
export const BillingReplayNonces: CollectionConfig = {
  slug: 'billing-replay-nonces',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    hidden: true,
    group: PLATFORM_GROUPS.operations,
  },
  labels: { plural: 'اثرانگشت درخواست صورت‌حساب', singular: 'اثرانگشت درخواست صورت‌حساب' },
  fields: [
    { name: 'keyId', type: 'text', required: true, index: true, label: 'کلید' },
    { name: 'bodyHash', type: 'text', required: true, unique: true, label: 'اثرانگشت' },
    { name: 'seenAt', type: 'date', required: true, label: 'دیده شده' },
  ],
  timestamps: true,
}
