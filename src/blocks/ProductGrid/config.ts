import type { Block } from 'payload'

import { columnsField, sectionIntro } from '../fields'

/**
 * The store's catalogue — `store` sites only, which is what `src/blocks/index.ts`
 * decides by table, not by a `custom` key a typo could break.
 *
 * The original catalog/one-product checkout remains the default. Café mode
 * projects the site's POS categories and products into a client-side cart.
 */
export const ProductGrid: Block = {
  slug: 'productGrid',
  interfaceName: 'ProductGridBlock',
  fields: [
    ...sectionIntro,
    {
      name: 'mode',
      type: 'select',
      label: 'نمایش فروشگاه',
      defaultValue: 'catalog',
      options: [
        { label: 'فهرست معمول محصولات', value: 'catalog' },
        { label: 'منوی کافه و سبد خرید', value: 'cafe' },
      ],
      admin: { description: 'منوی کافه کالاها و دسته‌های همگام‌شدهٔ همین سایت را به ترتیب مبدأ نمایش می‌دهد.' },
    },
    {
      name: 'populateBy',
      type: 'select',
      label: 'نحوهٔ پر کردن',
      defaultValue: 'collection',
      options: [
        { label: 'همهٔ محصولات', value: 'collection' },
        { label: 'انتخاب دستی', value: 'selection' },
      ],
    },
    {
      name: 'limit',
      type: 'number',
      label: 'بیشترین تعداد',
      defaultValue: 6,
      max: 24,
      min: 1,
      admin: {
        condition: (_, siblingData) => siblingData?.populateBy === 'collection',
        description: 'تازه‌ترین‌ها اول.',
        step: 1,
      },
    },
    {
      name: 'products',
      type: 'relationship',
      label: 'محصولات',
      hasMany: true,
      relationTo: 'products',
      admin: {
        condition: (_, siblingData) => siblingData?.populateBy === 'selection',
        description: 'فقط محصولات همین سایت در فهرست انتخاب دیده می‌شود.',
      },
    },
    columnsField,
    {
      name: 'showBuyButton',
      type: 'checkbox',
      label: 'دکمهٔ خرید',
      defaultValue: true,
      admin: {
        description: 'خاموش یعنی «فقط کاتالوگ» — قیمت می‌ماند، فرم خرید برداشته می‌شود.',
      },
    },
  ],
  labels: {
    singular: 'محصولات',
    plural: 'محصولات',
  },
}
