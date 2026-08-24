import type { Field } from 'payload'

/**
 * The heading and lead paragraph most blocks in the library start with.
 *
 * Localized here, not on the `layout` array — localizing a container gives every
 * locale its own separate list of blocks, so editors would rebuild the page
 * structure per language (PLAN §3.7).
 */
export const sectionIntro: Field[] = [
  {
    name: 'heading',
    type: 'text',
    label: 'عنوان بخش',
    localized: true,
  },
  {
    name: 'intro',
    type: 'textarea',
    label: 'توضیح کوتاه',
    localized: true,
  },
]

/** How many items sit side by side on a wide screen. */
export const columnsField: Field = {
  name: 'columns',
  type: 'select',
  label: 'تعداد ستون‌ها',
  defaultValue: '3',
  options: [
    { label: '۲', value: '2' },
    { label: '۳', value: '3' },
    { label: '۴', value: '4' },
  ],
}

/**
 * Written out rather than interpolated: Tailwind scans source text, so
 * `lg:grid-cols-${n}` would produce no CSS at all.
 */
export const columnClass = {
  '2': 'sm:grid-cols-2',
  '3': 'sm:grid-cols-2 lg:grid-cols-3',
  '4': 'sm:grid-cols-2 lg:grid-cols-4',
} as const
