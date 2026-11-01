import type { CollectionConfig } from 'payload'

import { slugField } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import {
  authenticatedOrEntryPublished,
  writeUnlessEntryPublishing,
} from '../access/entryPublished'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import { revalidateContentEntry, revalidateContentEntryDelete } from '../hooks/revalidateContentEntry'
import { ENTRY_STATUSES } from '@/lib/entry-status'
import { slugifyField } from '@/lib/slug'
import { migrationSourceField } from './fields/migrationSource'
import { uniqueEntrySlugPerContentType } from './hooks/uniqueContentKeys'
import { validateContentEntry } from './hooks/validateContentEntry'

const ENTRY_STATUS_OPTIONS = [
  { label: 'پیش‌نویس', value: 'draft' },
  { label: 'در انتظار بررسی', value: 'pending' },
  { label: 'منتشرشده', value: 'published' },
  { label: 'خصوصی', value: 'private' },
  { label: 'زمان‌بندی‌شده', value: 'scheduled' },
  { label: 'زباله‌دان', value: 'trash' },
] as const

// Keep the admin options and the shared status list one list in two shapes.
void ENTRY_STATUSES

/**
 * One record of any site-defined content type (issue #166 §2) — a migrated
 * WP CPT entry, or content created natively against the same definition.
 *
 * Deliberate model choices:
 *
 * - **Status is the WordPress-shaped field, not Payload drafts.** Only
 *   `published` is public (`authenticatedOrEntryPublished`); private,
 *   scheduled and trashed source rows keep their meaning instead of
 *   collapsing into "draft". Scheduled rows stay unpublished in v1 — no job
 *   flips them yet, and that is stated in the migration matrix.
 * - **Two bodies, one rule.** `body` is the Lexical document editors work
 *   in; `preservedHtml` is the source HTML archived verbatim when fidelity
 *   conversion is not possible (page builders, shortcodes). The theme
 *   renders the archive as *text* (`src/lib/html-text.ts`), never as markup.
 * - **`fieldValues` is typed JSON under the type's schema; `unmappedMeta` is
 *   where unmapped source keys survive** (`validateContentEntry`), readable
 *   by staff only, so nothing is silently dropped and nothing unreviewed is
 *   published either.
 */
export const ContentEntries: CollectionConfig = {
  slug: 'content-entries',
  access: {
    create: apiKeyCreateAware(writeUnlessEntryPublishing('content-entries')),
    delete: apiKeyAware(authenticated),
    read: apiKeyAware(scopedPublicRead(authenticatedOrEntryPublished)),
    update: apiKeyUpdateAware(writeUnlessEntryPublishing('content-entries')),
  },
  admin: {
    defaultColumns: ['title', 'slug', 'contentType', 'status', 'updatedAt'],
    description:
      'رکوردهای گونه‌های محتوای سفارشی. فقط وضعیت «منتشرشده» برای بازدیدکننده دیده می‌شود؛ وضعیت‌های دیگر درون‌سامانه‌ای‌اند.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'title',
  },
  labels: {
    plural: 'محتوای سفارشی',
    singular: 'رکورد محتوا',
  },
  defaultPopulate: {
    slug: true,
    status: true,
    title: true,
  },
  fields: [
    {
      name: 'contentType',
      type: 'relationship',
      label: 'گونه محتوا',
      index: true,
      relationTo: 'content-type-definitions',
      required: true,
    },
    {
      name: 'title',
      type: 'text',
      label: 'عنوان',
      localized: true,
      required: true,
    },
    slugField({ disableUnique: true, localized: true, slugify: slugifyField }),
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          label: 'وضعیت',
          admin: { width: '50' },
          defaultValue: 'draft',
          index: true,
          options: [...ENTRY_STATUS_OPTIONS],
          required: true,
        },
        {
          name: 'publishedAt',
          type: 'date',
          label: 'زمان انتشار',
          admin: {
            date: { pickerAppearance: 'dayAndTime' },
            description: 'با نخستین انتشار خودکار پر می‌شود؛ برای رکورد مهاجر تاریخ مبدأ است.',
            width: '50',
          },
        },
      ],
    },
    {
      name: 'excerpt',
      type: 'textarea',
      label: 'گزیده',
      localized: true,
    },
    {
      name: 'body',
      type: 'richText',
      label: 'متن',
      localized: true,
    },
    {
      name: 'preservedHtml',
      type: 'textarea',
      label: 'HTML بایگانی‌شده مبدأ',
      admin: {
        description:
          'خروجی خام مبدأ (صفحه‌ساز/شورت‌کد) که تبدیل وفادارانه‌اش ممکن نبوده است. در سایت به‌صورت متن امن نمایش داده می‌شود، هرگز به‌صورت HTML خام.',
      },
      localized: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'heroImage',
          type: 'upload',
          label: 'تصویر شاخص',
          admin: { width: '50' },
          relationTo: 'media',
        },
        {
          name: 'ogImage',
          type: 'upload',
          label: 'تصویر اشتراک‌گذاری',
          admin: { width: '50' },
          relationTo: 'media',
        },
      ],
    },
    {
      name: 'gallery',
      type: 'upload',
      label: 'نگارخانه',
      hasMany: true,
      relationTo: 'media',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'parent',
          type: 'relationship',
          label: 'رکورد والد',
          admin: {
            description: 'فقط در گونه سلسله‌مراتبی، و از همان گونه.',
            width: '50',
          },
          index: true,
          relationTo: 'content-entries',
        },
        {
          name: 'menuOrder',
          type: 'number',
          label: 'ترتیب نمایش',
          admin: { width: '50' },
          defaultValue: 0,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'author',
          type: 'relationship',
          label: 'نویسنده (کاربر ای‌شوب)',
          admin: { width: '50' },
          relationTo: 'users',
        },
        {
          name: 'authorName',
          type: 'text',
          label: 'نام نویسنده (نمایش)',
          admin: {
            description: 'نام نمایشی مبدأ، وقتی نویسنده حساب ای‌شوب ندارد.',
            width: '50',
          },
        },
      ],
    },
    {
      name: 'fieldValues',
      type: 'json',
      label: 'مقادیر فیلدهای سفارشی',
      admin: {
        description:
          'شیء JSON کلیدبه‌کلیدِ طرح گونه محتوا. کلیدِ بیرون از طرح دور ریخته نمی‌شود و به «فراداده نگاشت‌نشده» می‌رود.',
      },
    },
    {
      name: 'unmappedMeta',
      type: 'json',
      label: 'فراداده نگاشت‌نشده',
      access: {
        read: ({ req: { user } }) => Boolean(user),
      },
      admin: {
        description:
          'داده مبدأ که هنوز به فیلدی نگاشته نشده؛ حفظ شده تا بعداً نگاشت شود و در API عمومی منتشر نمی‌شود.',
        readOnly: true,
      },
    },
    {
      name: 'searchText',
      type: 'text',
      label: 'متن جست‌وجو',
      admin: {
        description: 'خودکار از فیلدهای «قابل جست‌وجو» ساخته می‌شود.',
        hidden: true,
        readOnly: true,
      },
      index: true,
    },
    {
      name: 'metaTitle',
      type: 'text',
      label: 'عنوان سئو',
      localized: true,
    },
    {
      name: 'metaDescription',
      type: 'textarea',
      label: 'توضیح سئو',
      localized: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'canonicalUrl',
          type: 'text',
          label: 'نشانی کانونیکال',
          admin: { width: '50' },
        },
        {
          name: 'noindex',
          type: 'checkbox',
          label: 'از موتور جست‌وجو پنهان شود (noindex)',
          admin: { width: '50' },
          defaultValue: false,
        },
      ],
    },
    {
      name: 'termRelations',
      type: 'join',
      collection: 'entry-term-relations',
      label: 'واژه‌های پیوسته',
      on: 'entry',
    },
    {
      name: 'outgoingRelations',
      type: 'join',
      collection: 'content-relations',
      label: 'رابطه‌های این رکورد',
      on: 'fromEntry',
    },
    migrationSourceField(),
  ],
  hooks: {
    afterChange: [revalidateContentEntry],
    afterDelete: [revalidateContentEntryDelete],
    beforeChange: [forceApiKeySite],
    beforeValidate: [validateContentEntry, uniqueEntrySlugPerContentType],
  },
}
