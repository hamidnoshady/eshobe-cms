import type { CollectionBeforeValidateHook, CollectionConfig } from 'payload'

import { generateApiKey } from '@/lib/api-keys'
import { platformAdmin } from '../access/platformAdmin'

/**
 * WAVE-9 §9.4 — a bearer credential a headless client authenticates with, from a
 * non-customer origin where `Host` cannot name the tenant (`src/access/siteApiKey.ts`
 * is what a request resolves one against).
 *
 * Deliberately **not** in the multi-tenant plugin's `collections` map
 * (`src/plugins/index.ts`): a key is platform-issued credential material, the same
 * shape as `users`, not a site's own content. A customer's own staff never sees this
 * collection at all — only platform-admin, and only through `src/endpoints/apiKeys.ts`.
 *
 * The raw key is never stored. `keyHash` (sha256) is what a lookup compares against;
 * `keyPrefix` is enough to tell two keys apart in a list without being enough to
 * guess the rest.
 */
const mintOnCreate: CollectionBeforeValidateHook = ({ data, operation, req }) => {
  if (operation !== 'create') return data

  // Ignore anything a caller tried to set directly — a key is minted here, always,
  // never accepted as input. `req.context` hands the one-time raw value to the
  // issuing endpoint; nothing else ever sees it.
  const { raw, hash, prefix } = generateApiKey()
  req.context.eshobeIssuedApiKey = raw

  return { ...data, keyHash: hash, keyPrefix: prefix }
}

export const ApiKeys: CollectionConfig<'api-keys'> = {
  slug: 'api-keys',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'role', 'site', 'keyPrefix', 'disabledAt'],
    description: 'کلیدهای دسترسی برنامه‌نویسی — برای اتصال یک برنامهٔ بیرونی (مثل سامانهٔ صندوق فروش) به یک سایت یا به کل پلتفرم.',
    useAsTitle: 'name',
  },
  labels: {
    singular: 'کلید API',
    plural: 'کلیدهای API',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام',
      required: true,
      admin: {
        description: 'برای خودتان — مثلاً «سامانهٔ صندوق فروش، شعبهٔ مرکزی».',
      },
    },
    {
      name: 'role',
      type: 'select',
      label: 'نوع',
      required: true,
      defaultValue: 'site',
      options: [
        { label: 'سایت — خواندن/نوشتن یک سایت', value: 'site' },
        { label: 'پلتفرم — فقط ساخت سایت و مدیریت کلیدها', value: 'platform' },
      ],
      admin: {
        description: 'کلید «سایت» فقط به همان سایت دسترسی دارد. کلید «پلتفرم» هیچ محتوایی نمی‌خواند؛ فقط می‌تواند سایت بسازد یا کلید صادر/باطل کند.',
      },
    },
    {
      name: 'site',
      type: 'relationship',
      label: 'سایت',
      relationTo: 'sites',
      // Not schema-`required`: a platform key names no site at all (the whole
      // point is that it cannot read one) — `validate` below is what actually
      // requires it, conditionally, and keeps the Local API's create/update data
      // type from demanding a `site` on a platform-role row.
      admin: {
        condition: (_, siblingData) => siblingData?.role === 'site',
      },
      validate: (value: unknown, { siblingData }: { siblingData?: { role?: string } }) => {
        if (siblingData?.role === 'platform') return true
        return value ? true : 'کلید «سایت» باید به یک سایت وصل باشد.'
      },
    },
    {
      name: 'keyHash',
      type: 'text',
      label: 'هش کلید',
      // Not schema-`required`: always set by `mintOnCreate` below, before
      // Payload's own required-field check runs — never something a caller
      // supplies, so the create/update data type must not demand it either.
      unique: true,
      index: true,
      admin: {
        // Never rendered, never sent to the client — a lookup field, not a display one.
        hidden: true,
      },
    },
    {
      name: 'keyPrefix',
      type: 'text',
      label: 'پیشوند کلید',
      admin: {
        description: 'برای شناختن کلید در فهرست — کلید کامل فقط یک بار، در لحظهٔ صدور، نمایش داده می‌شود.',
        readOnly: true,
      },
    },
    {
      name: 'disabledAt',
      type: 'date',
      label: 'باطل‌شده در',
      admin: {
        description: 'پر کردن این فیلد، کلید را فوراً از کار می‌اندازد — سطر برای پیگیری باقی می‌ماند.',
      },
    },
    {
      name: 'lastUsedAt',
      type: 'date',
      label: 'آخرین استفاده',
      admin: {
        description: 'هر بار که این کلید یک درخواست را احراز هویت می‌کند به‌روز می‌شود؛ برای اطلاع، نه برای احراز هویت.',
        readOnly: true,
      },
    },
  ],
  hooks: {
    beforeValidate: [mintOnCreate],
  },
  timestamps: true,
}
