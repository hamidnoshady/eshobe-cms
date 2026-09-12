import type { CollectionAfterReadHook, CollectionBeforeValidateHook, CollectionConfig } from 'payload'

import { generateApiKey } from '@/lib/api-keys'
import { platformAdmin } from '../access/platformAdmin'
import { issueApiKeyEndpoint, listApiKeysEndpoint, revokeApiKeyEndpoint } from '@/endpoints/apiKeys'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

/**
 * WAVE-9 §9.4 — a bearer credential a headless client authenticates with, from a
 * non-customer origin where `Host` cannot name the tenant (`src/access/siteApiKey.ts`
 * is what a request resolves one against).
 *
 * Deliberately **not** in the multi-tenant plugin's `collections` map
 * (`src/plugins/index.ts`): a key is platform-issued credential material, the same
 * shape as `users`, not a site's own content. A customer's own staff never sees this
 * collection at all — only platform-admin, through `/admin/collections/api-keys`
 * (list, issue, revoke) or `POST /api/api-keys/issue` and friends.
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

/**
 * `false`, on purpose: the collection's own create route — REST `POST /api/api-keys`,
 * GraphQL, the admin form — mints a key whose raw value **nobody can ever see** (the
 * mint happens in `mintOnCreate`; only the issuing endpoint hands the secret back,
 * once, in its own response). A row created that way is a credential that was dead on
 * arrival, which is exactly the trap the admin form was before this. So the door is
 * closed, not labelled: `access.create` returning `false` also hides Payload's
 * "Create New" button, and `/admin/collections/api-keys/issue` (the view below) plus
 * `POST /api/api-keys/issue` are the only issuers. Both mint through
 * `overrideAccess: true`, so closing this changes nothing for them.
 */
const noDirectCreate = (): false => false

/**
 * `keyHash` never leaves the server: `admin.hidden` only governs the admin *form*,
 * and REST/GraphQL reads return hidden fields just the same — without this hook the
 * sha256 was in every response to a platform admin, while the field's own comment
 * claimed otherwise. Stripping it on read breaks nothing that matters: bearer
 * lookups (`requestApiKey`) match `keyHash` in their `where`, at the database, and
 * read only `role`/`site`/`disabledAt` off the result rows. It is the same
 * read-time masking shape `PaymentGateways` and `StorageConnections` use for their
 * ciphertext.
 */
const stripKeyHash: CollectionAfterReadHook = ({ doc }) => {
  if (!('keyHash' in doc)) return doc
  const { keyHash: _keyHash, ...rest } = doc as typeof doc & { keyHash?: unknown }
  return rest
}

export const ApiKeys: CollectionConfig<'api-keys'> = {
  slug: 'api-keys',
  access: {
    create: noDirectCreate,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'role', 'site', 'keyPrefix', 'disabledAt'],
    group: PLATFORM_GROUPS.fleet,
    hidden: hiddenFromCustomers,
    description:
      'کلیدهای دسترسی برنامه‌نویسی — برای اتصال یک برنامهٔ بیرونی (مثل سامانهٔ صندوق فروش) به یک سایت یا به کل پلتفرم. کلید جدید را از «صدور کلید جدید» بسازید؛ کلید کامل فقط یک بار، در لحظهٔ صدور، نمایش داده می‌شود.',
    useAsTitle: 'name',
    components: {
      views: {
        /**
         * The issuing surface for platform staff: `/admin/collections/api-keys/issue`.
         * A form (name, role, site) that posts to `/api/api-keys/issue` and shows the
         * raw key exactly once, with a copy button — the same shape as the `sites`
         * collection's `/provision` view. The endpoint re-checks the role, so this
         * view is UX, not the security boundary.
         */
        issue: {
          Component: '@/api-keys/IssueKeyView',
          meta: {
            title: 'صدور کلید جدید',
          },
          path: '/issue',
        },
        // The list header action that opens it, next to where "Create New" used to be.
        list: {
          actions: ['@/api-keys/IssueKeyButton'],
        },
      },
    },
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
        // Never rendered — a lookup field, not a display one. `hidden` only
        // governs the admin form; keeping it out of every *response* is
        // `stripKeyHash` below.
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
  /**
   * The key-lifecycle endpoints, registered on the collection so they actually
   * route: Payload dispatches `/api/<first-segment>/…` against *that collection's*
   * endpoints when the first segment is a collection slug, and never falls back to
   * the top-level `endpoints` array — where these used to sit, unreachable, answering
   * 404 to the POS. See `src/endpoints/apiKeys.ts` for the full rule.
   */
  endpoints: [issueApiKeyEndpoint, listApiKeysEndpoint, revokeApiKeyEndpoint],
  hooks: {
    afterRead: [stripKeyHash],
    beforeValidate: [mintOnCreate],
  },
  timestamps: true,
}
