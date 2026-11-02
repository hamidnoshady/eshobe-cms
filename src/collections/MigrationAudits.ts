import type { CollectionConfig } from 'payload'

import { hiddenFromCustomers } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { validateMigrationLinks } from './hooks/validateMigrationLinks'

const noDirectWrite = () => false

/**
 * Who authorized what: source creation, queued operations, the write-fence
 * confirmation, cutover and rollback. The migration context that suppresses
 * commerce side effects is privileged by design, so every act that arms it
 * leaves an audit row (`src/lib/migration-context.ts`).
 */
export const MigrationAudits: CollectionConfig = {
  slug: 'migration-audits',
  access: { create: noDirectWrite, delete: noDirectWrite, read: authenticated, update: noDirectWrite },
  admin: { group: 'مهاجرت', hidden: hiddenFromCustomers, useAsTitle: 'action' },
  labels: { plural: 'ممیزی‌های مهاجرت', singular: 'ممیزی مهاجرت' },
  fields: [
    { name: 'job', type: 'relationship', label: 'کار', relationTo: 'migration-jobs' },
    { name: 'source', type: 'relationship', label: 'مبدأ', relationTo: 'migration-sources' },
    { name: 'actor', type: 'relationship', label: 'کاربر', relationTo: 'users' },
    { name: 'action', type: 'text', label: 'اقدام', index: true, required: true },
    { name: 'summary', type: 'textarea', label: 'خلاصه', required: true },
    { name: 'details', type: 'json', label: 'جزئیات' },
  ],
  hooks: { beforeValidate: [validateMigrationLinks] },
}
