import type { Field } from 'payload'

/** Stable POS identities are independent of the WordPress migration provenance. */
export const menuSourceFields = (): Field[] => [
  {
    name: 'menuSourceSystem',
    type: 'text',
    label: 'سامانهٔ منوی مبدأ',
    admin: { description: 'برای منوی همگام‌شده: biza_miz.', readOnly: true },
    index: true,
  },
  {
    name: 'menuSourceId',
    type: 'text',
    label: 'شناسهٔ پایدار در منوی مبدأ',
    admin: { description: 'شناسهٔ کالا یا دسته در سامانهٔ مبدأ، نه نام یا کد کالا.', readOnly: true },
    index: true,
    maxLength: 128,
  },
]
