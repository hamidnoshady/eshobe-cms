import type { Access, CollectionConfig } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { apiKeyAware } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import { migrationSourceField } from './fields/migrationSource'
import { MENU_TARGET_COLLECTIONS, validateMenu } from './hooks/validateMenu'

const activeOrStaff: Access = ({ req: { user } }) =>
  user ? true : { isActive: { equals: true } }

const referenceCondition = (_data: unknown, siblingData: { type?: string }) =>
  siblingData?.type === 'reference'
const customCondition = (_data: unknown, siblingData: { type?: string }) =>
  siblingData?.type !== 'reference'

/**
 * A site's named navigation tree (issue #166) — the destination WordPress
 * `nav_menu` + `nav_menu_item` data was missing.
 *
 * `header`/`footer` remain the built-in theme's two small link lists; they
 * cannot faithfully hold an arbitrary WP menu (multiple locations, nested
 * items, product/CPT/taxonomy targets, more than a handful of rows). A menu
 * is therefore real content in its own right: one tenant-scoped document per
 * named menu, with its items stored flat and ordered and parented by `key`.
 * A renderer reads the active menu for a location and stitches the tree;
 * moving a menu into Header/Footer stays an explicit editorial choice, not
 * something an importer does by overwriting the site's chrome.
 */
export const Menus: CollectionConfig = {
  slug: 'menus',
  access: {
    create: authenticated,
    delete: authenticated,
    read: apiKeyAware(scopedPublicRead(activeOrStaff)),
    update: authenticated,
  },
  admin: {
    defaultColumns: ['name', 'slug', 'location', 'isActive', 'updatedAt'],
    description:
      'درخت‌های ناوبری نام‌دار سایت، از جمله منوهای واردشده از وردپرس. آیتم‌ها با کلید و والدشان در یک فهرست مرتب نگه داشته می‌شوند.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'name',
  },
  labels: {
    plural: 'منوها',
    singular: 'منو',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام منو',
      localized: true,
      required: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'slug',
          type: 'text',
          label: 'کلید منو',
          admin: {
            description: 'کلید پایدار منو برای قالب و مهاجرت؛ در هر سایت یکتا است.',
            width: '50',
          },
          index: true,
          required: true,
        },
        {
          name: 'isActive',
          type: 'checkbox',
          label: 'فعال و عمومی',
          admin: { width: '50' },
          defaultValue: true,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'location',
          type: 'text',
          label: 'جایگاه اصلی',
          admin: {
            description: 'جایگاهی که قالب با آن منو را پیدا می‌کند؛ مثل primary یا footer.',
            width: '50',
          },
          index: true,
        },
        {
          name: 'locations',
          type: 'json',
          label: 'همهٔ جایگاه‌های مبدأ',
          admin: {
            description: 'فهرست JSON نام جایگاه‌هایی که این منو در مبدأ به آن‌ها وصل بوده است.',
            width: '50',
          },
        },
      ],
    },
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
      localized: true,
    },
    {
      name: 'items',
      type: 'array',
      label: 'آیتم‌های منو',
      admin: {
        description:
          'آیتم‌ها به ترتیب نمایش‌اند. «کلید والد» باید کلید یکی از آیتم‌های همین منو باشد؛ عمق از همان رابطه ساخته می‌شود.',
      },
      labels: { plural: 'آیتم‌ها', singular: 'آیتم' },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'key',
              type: 'text',
              label: 'کلید آیتم',
              admin: { width: '50' },
              required: true,
            },
            {
              name: 'parentKey',
              type: 'text',
              label: 'کلید والد',
              admin: { width: '50' },
            },
          ],
        },
        {
          name: 'label',
          type: 'text',
          label: 'عنوان نمایشی',
          localized: true,
          required: true,
        },
        {
          name: 'description',
          type: 'textarea',
          label: 'توضیح آیتم',
          localized: true,
        },
        {
          type: 'row',
          fields: [
            {
              name: 'type',
              type: 'radio',
              label: 'گونهٔ پیوند',
              admin: { layout: 'horizontal', width: '50' },
              defaultValue: 'custom',
              options: [
                { label: 'سند همین سایت', value: 'reference' },
                { label: 'نشانی دلخواه', value: 'custom' },
              ],
              required: true,
            },
            {
              name: 'newTab',
              type: 'checkbox',
              label: 'گشودن در زبانهٔ تازه',
              admin: { width: '50' },
              defaultValue: false,
            },
          ],
        },
        {
          name: 'reference',
          type: 'relationship',
          label: 'سند مقصد',
          admin: { condition: referenceCondition },
          relationTo: [...MENU_TARGET_COLLECTIONS],
        },
        {
          name: 'url',
          type: 'text',
          label: 'نشانی',
          admin: { condition: customCondition },
          localized: true,
        },
        {
          type: 'row',
          fields: [
            {
              name: 'menuOrder',
              type: 'number',
              label: 'ترتیب',
              admin: { width: '50' },
              defaultValue: 0,
            },
            {
              name: 'depth',
              type: 'number',
              label: 'عمق',
              admin: { readOnly: true, width: '50' },
              defaultValue: 0,
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'status',
              type: 'select',
              label: 'وضعیت آیتم',
              admin: { width: '50' },
              defaultValue: 'published',
              options: [
                { label: 'منتشرشده', value: 'published' },
                { label: 'پیش‌نویس', value: 'draft' },
                { label: 'در انتظار بررسی', value: 'pending' },
                { label: 'خصوصی', value: 'private' },
                { label: 'زمان‌بندی‌شده', value: 'scheduled' },
                { label: 'زباله‌دان', value: 'trash' },
              ],
              required: true,
            },
            {
              name: 'cssClasses',
              type: 'text',
              label: 'کلاس‌های CSS مبدأ',
              admin: { width: '50' },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'sourceObjectType',
              type: 'text',
              label: 'گونهٔ شیء در مبدأ',
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'sourceObjectId',
              type: 'text',
              label: 'شناسهٔ شیء در مبدأ',
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
        {
          name: 'sourceUrl',
          type: 'text',
          label: 'نشانی در مبدأ',
          admin: { readOnly: true },
        },
      ],
    },
    migrationSourceField({ optional: true }),
  ],
  hooks: {
    beforeValidate: [validateMenu],
  },
}
