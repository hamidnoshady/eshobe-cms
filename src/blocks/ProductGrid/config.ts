import type { Block } from 'payload'

import { columnsField, sectionIntro } from '../fields'

/**
 * The store's catalogue — `store` sites only, which is what `src/blocks/index.ts`
 * decides by table, not by a `custom` key a typo could break.
 *
 * Deliberately *not* a cart: PLAN decision #5 is "catalog + checkout first, cart
 * later", and the Wave 7 spike kept it there. This block goes on any page, the card
 * asks for a name and a phone number, and the money is settled against one order row.
 * A store that grows into a cart adds a block; it does not replace this one.
 */
export const ProductGrid: Block = {
  slug: 'productGrid',
  interfaceName: 'ProductGridBlock',
  fields: [
    ...sectionIntro,
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
