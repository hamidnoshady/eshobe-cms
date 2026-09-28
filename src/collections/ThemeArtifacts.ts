import type { CollectionConfig, Validate } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

export const THEME_ARTIFACT_STATUSES = [
  'queued',
  'building',
  'pushing',
  'verifying',
  'ready',
  'failed',
  'deprecated',
] as const

const validateSha: Validate = (value) =>
  !value || /^[0-9a-f]{40}$/i.test(String(value)) || 'کامیت باید ۴۰ رقم هگز باشد.'
const validateDigest: Validate = (value) =>
  !value || /^sha256:[0-9a-f]{64}$/i.test(String(value)) || 'digest باید sha256 و ۶۴ رقم هگز باشد.'

/** Immutable, platform-owned output of one theme build. Never tenant writable. */
export const ThemeArtifacts: CollectionConfig<'theme-artifacts'> = {
  slug: 'theme-artifacts',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['themePackage', 'commitSha', 'imageDigest', 'status', 'buildFinishedAt'],
    description:
      'خروجی‌های immutable ساخت پوسته؛ استقرار رجیستری همیشه با digest انجام می‌شود، نه tag.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'immutableKey',
  },
  labels: { plural: 'ساخت‌های پوسته', singular: 'ساخت پوسته' },
  fields: [
    {
      name: 'immutableKey',
      type: 'text',
      unique: true,
      index: true,
      required: true,
      admin: { readOnly: true },
    },
    {
      name: 'themePackage',
      type: 'relationship',
      relationTo: 'theme-packages',
      required: true,
      index: true,
    },
    {
      name: 'source',
      type: 'select',
      required: true,
      options: [
        { label: 'GitHub Actions', value: 'github_actions' },
        { label: 'Coolify build', value: 'coolify_build' },
        { label: 'Manual registry', value: 'manual_registry' },
      ],
    },
    { name: 'repository', type: 'text', required: true },
    { name: 'ref', type: 'text', required: true },
    { name: 'commitSha', type: 'text', required: true, index: true, validate: validateSha },
    { name: 'registryProvider', type: 'select', options: [{ label: 'GHCR', value: 'ghcr' }] },
    { name: 'imageRepository', type: 'text' },
    {
      name: 'imageTag',
      type: 'text',
      admin: { description: 'فقط برای نمایش؛ هرگز هویت استقرار نیست.' },
    },
    { name: 'imageDigest', type: 'text', index: true, validate: validateDigest },
    { name: 'immutableImage', type: 'text', admin: { readOnly: true } },
    { name: 'platform', type: 'text' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'queued',
      index: true,
      options: THEME_ARTIFACT_STATUSES.map((value) => ({ label: value, value })),
    },
    { name: 'workflowRunId', type: 'text' },
    { name: 'workflowRunUrl', type: 'text' },
    { name: 'provenanceAvailable', type: 'checkbox', defaultValue: false },
    { name: 'sbomAvailable', type: 'checkbox', defaultValue: false },
    { name: 'buildStartedAt', type: 'date' },
    { name: 'buildFinishedAt', type: 'date' },
    { name: 'lastError', type: 'textarea', admin: { readOnly: true } },
  ],
  hooks: {
    beforeValidate: [
      ({ data, operation, originalDoc }) => {
        if (!data) return data
        const previous = operation === 'update' ? String(originalDoc?.status ?? '') : ''
        const next = String((data.status ?? previous) || 'queued')
        if ((previous === 'failed' || previous === 'deprecated') && next === 'ready') {
          throw new Error(
            'آرتیفکت failed/deprecated نمی‌تواند ready شود؛ یک آرتیفکت تازه ثبت کنید.',
          )
        }
        if (next === 'ready') {
          const requiredIdentity = [
            'themePackage',
            'repository',
            'commitSha',
            'imageRepository',
            'imageDigest',
          ]
          for (const field of requiredIdentity) {
            if (!(data[field] ?? originalDoc?.[field])) {
              throw new Error('آرتیفکت ready باید مخزن، کامیت، تصویر و digest کامل داشته باشد.')
            }
          }
        }
        if (previous === 'ready') {
          for (const field of ['themePackage', 'commitSha', 'imageRepository', 'imageDigest']) {
            const before = originalDoc?.[field]
            const after = data[field]
            if (
              after !== undefined &&
              String(after) !== String(typeof before === 'object' ? before?.id : before)
            ) {
              throw new Error('هویت آرتیفکت ready تغییرناپذیر است.')
            }
          }
        }
        const digest = String(data.imageDigest ?? '').toLowerCase()
        const image = String(data.imageRepository ?? '').toLowerCase()
        if (digest && image) {
          data.imageDigest = digest
          data.imageRepository = image
          data.immutableImage = `${image}@${digest}`
        }
        if (data.themePackage && data.commitSha && digest) {
          const packageId =
            typeof data.themePackage === 'object' ? data.themePackage.id : data.themePackage
          data.immutableKey = `${String(packageId)}:${String(data.commitSha).toLowerCase()}:${digest}`
        }
        return data
      },
    ],
  },
  timestamps: true,
}
