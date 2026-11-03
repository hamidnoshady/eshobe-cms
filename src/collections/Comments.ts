import type { Access, CollectionConfig, FieldAccess } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { apiKeyAware } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import { migrationSourceField } from './fields/migrationSource'
import { validateComment } from './hooks/validateComment'

const staffOnlyField: FieldAccess = ({ req: { user } }) => Boolean(user)

const targetCondition =
  (collection: string) => (_data: unknown, siblingData: { targetCollection?: string }) =>
    siblingData?.targetCollection === collection

/**
 * Public half of a comment read: approved, and attached to a document that
 * is itself public. A comment on a draft post is still a draft-post leak if
 * its body quotes the draft, so the target's own publication state is part
 * of the clause — per target collection, because entries carry `status`
 * while versioned collections carry `_status`.
 */
const approvedOnPublicTarget: Access = ({ req: { user } }) => {
  if (user) return true

  return {
    and: [
      { status: { equals: 'approved' } },
      {
        or: [
          { 'targetPost._status': { equals: 'published' } },
          { 'targetPage._status': { equals: 'published' } },
          { 'targetProduct._status': { equals: 'published' } },
          { 'targetEntry.status': { equals: 'published' } },
        ],
      },
    ],
  } as ReturnType<Access>
}

/**
 * Reader discussion and product reviews (issue #166) — the native
 * destination WordPress comments were missing.
 *
 * Moderation state is WordPress-shaped (`approved` / `pending` / `spam` /
 * `trash`) rather than Payload drafts, for the same reason content entries
 * carry `status`: an imported held or spam comment must keep its meaning,
 * and anonymous reads are the exact `Where` above, never a boolean.
 *
 * Writes are staff-only. There is deliberately no public submission surface
 * here yet: accepting anonymous comments is an anti-spam/rate-limit product
 * of its own, and importing history must not quietly open one. The author
 * email is staff-only at the field level — a public comment shows a name,
 * never the address it was left from.
 */
export const Comments: CollectionConfig = {
  slug: 'comments',
  access: {
    create: authenticated,
    delete: authenticated,
    read: apiKeyAware(scopedPublicRead(approvedOnPublicTarget)),
    update: authenticated,
  },
  admin: {
    defaultColumns: ['authorName', 'status', 'targetCollection', 'submittedAt', 'updatedAt'],
    description:
      'دیدگاه‌ها و بازخوردهای خوانندگان و مشتریان. فقط دیدگاه تأییدشده روی سند منتشرشده برای بازدیدکننده دیده می‌شود؛ رایانامهٔ نویسنده هرگز عمومی نیست.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'authorName',
  },
  labels: {
    plural: 'دیدگاه‌ها',
    singular: 'دیدگاه',
  },
  fields: [
    {
      name: 'body',
      type: 'richText',
      label: 'متن دیدگاه',
      localized: true,
      required: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          label: 'وضعیت بررسی',
          admin: { width: '50' },
          defaultValue: 'pending',
          index: true,
          options: [
            { label: 'تأییدشده', value: 'approved' },
            { label: 'در انتظار بررسی', value: 'pending' },
            { label: 'هرزنامه', value: 'spam' },
            { label: 'زباله‌دان', value: 'trash' },
          ],
          required: true,
        },
        {
          name: 'submittedAt',
          type: 'date',
          label: 'زمان ثبت',
          admin: {
            date: { pickerAppearance: 'dayAndTime' },
            description: 'برای دیدگاه مهاجر، زمان ثبت در وردپرس است.',
            width: '50',
          },
          index: true,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'commentType',
          type: 'text',
          label: 'گونهٔ دیدگاه',
          admin: {
            description: 'comment برای دیدگاه عادی و review برای بازخورد محصول ووکامرس.',
            width: '50',
          },
          defaultValue: 'comment',
          index: true,
        },
        {
          name: 'rating',
          type: 'number',
          label: 'امتیاز',
          admin: { description: 'فقط برای بازخورد محصول؛ میان ۰ تا ۵.', width: '50' },
          max: 5,
          min: 0,
        },
      ],
    },
    {
      name: 'targetCollection',
      type: 'select',
      label: 'مجموعهٔ مقصد',
      defaultValue: 'posts',
      options: [
        { label: 'نوشته', value: 'posts' },
        { label: 'برگه', value: 'pages' },
        { label: 'محصول', value: 'products' },
        { label: 'محتوای سفارشی', value: 'content-entries' },
      ],
      required: true,
    },
    {
      name: 'targetPost',
      type: 'relationship',
      label: 'نوشتهٔ مقصد',
      admin: { condition: targetCondition('posts') },
      index: true,
      relationTo: 'posts',
    },
    {
      name: 'targetPage',
      type: 'relationship',
      label: 'برگهٔ مقصد',
      admin: { condition: targetCondition('pages') },
      index: true,
      relationTo: 'pages',
    },
    {
      name: 'targetProduct',
      type: 'relationship',
      label: 'محصول مقصد',
      admin: { condition: targetCondition('products') },
      index: true,
      relationTo: 'products',
    },
    {
      name: 'targetEntry',
      type: 'relationship',
      label: 'رکورد مقصد',
      admin: { condition: targetCondition('content-entries') },
      index: true,
      relationTo: 'content-entries',
    },
    {
      name: 'parent',
      type: 'relationship',
      label: 'دیدگاه والد',
      admin: { description: 'پاسخ، فقط زیر دیدگاهی روی همان سند مقصد می‌نشیند.' },
      index: true,
      relationTo: 'comments',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'authorName',
          type: 'text',
          label: 'نام نمایشی نویسنده',
          admin: { width: '50' },
        },
        {
          name: 'authorUrl',
          type: 'text',
          label: 'نشانی نویسنده',
          admin: { width: '50' },
        },
      ],
    },
    {
      name: 'authorEmail',
      type: 'email',
      label: 'رایانامهٔ نویسنده',
      access: {
        create: staffOnlyField,
        read: staffOnlyField,
        update: staffOnlyField,
      },
      admin: { description: 'دادهٔ شخصی است و در API عمومی یا با کلید سایت برنمی‌گردد.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'authorUser',
          type: 'relationship',
          label: 'کاربر ای‌شوب نویسنده',
          admin: { width: '50' },
          relationTo: 'users',
        },
        {
          name: 'authorCustomer',
          type: 'relationship',
          label: 'مشتری نویسنده',
          admin: { width: '50' },
          relationTo: 'customers',
        },
      ],
    },
    migrationSourceField({ optional: true }),
  ],
  hooks: {
    beforeValidate: [validateComment],
  },
}
