import type { CollectionBeforeValidateHook, CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { isCurrencyCode, validatePriceMinor } from '@/lib/money'

const normalizeTld: CollectionBeforeValidateHook = ({ data }) => {
  const value = (data as { tld?: unknown } | undefined)?.tld
  if (typeof value !== 'string') return data

  return { ...data, tld: value.trim().toLowerCase().replace(/^\.+/, '') }
}

const validateTld = (value: unknown): string | true => {
  const tld = typeof value === 'string' ? value.trim().toLowerCase().replace(/^\.+/, '') : ''

  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
    tld,
  )
    ? true
    : 'پسوند را بدون نقطهٔ آغازین وارد کنید؛ مانند ir، com یا co.ir.'
}

/**
 * A deliberately manual price source. The supplied ResellerArea API contract does not
 * expose price/TLD catalog commands, so the wholesale amount must be entered by platform
 * staff. One row is global: applying per-site wholesale prices would contradict the
 * platform-wide margin policy.
 */
export const DomainResellerProducts: CollectionConfig<'domain-reseller-products'> = {
  slug: 'domain-reseller-products',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: [
      'tld',
      'enabled',
      'currency',
      'registrationCost',
      'transferCost',
      'renewalCost',
    ],
    description:
      'قیمت پایهٔ سالانهٔ هر پسوند نزد registrar. مستند ResellerArea قیمت را از API برنمی‌گرداند؛ قیمت نهایی هر درخواست با درصد سود سراسریِ «نمایندگی دامنه» محاسبه و snapshot می‌شود.',
    group: 'زیرساخت',
    useAsTitle: 'tld',
  },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'tld',
          type: 'text',
          label: 'پسوند',
          required: true,
          unique: true,
          index: true,
          validate: validateTld,
          admin: { width: '35', description: 'بدون نقطهٔ آغازین؛ نمونه: ir، com، co.ir.' },
        },
        {
          name: 'enabled',
          type: 'checkbox',
          label: 'برای درخواست جدید فعال',
          defaultValue: true,
          admin: { width: '25' },
        },
        {
          name: 'currency',
          type: 'select',
          label: 'واحد قیمت',
          required: true,
          defaultValue: 'IRT',
          options: [
            { label: 'تومان', value: 'IRT' },
            { label: 'ریال', value: 'IRR' },
            { label: 'دلار', value: 'USD' },
            { label: 'یورو', value: 'EUR' },
          ],
          validate: (value: unknown) =>
            isCurrencyCode(value) ? true : 'واحد پول پشتیبانی‌شده را انتخاب کنید.',
          admin: { width: '40' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'registrationCost',
          type: 'number',
          label: 'قیمت پایهٔ ثبت / سال',
          required: true,
          min: 0,
          validate: validatePriceMinor,
          admin: { width: '33' },
        },
        {
          name: 'transferCost',
          type: 'number',
          label: 'قیمت پایهٔ انتقال / سال',
          required: true,
          min: 0,
          validate: validatePriceMinor,
          admin: { width: '33' },
        },
        {
          name: 'renewalCost',
          type: 'number',
          label: 'قیمت پایهٔ تمدید / سال',
          required: true,
          min: 0,
          validate: validatePriceMinor,
          admin: { width: '33' },
        },
      ],
    },
  ],
  hooks: { beforeValidate: [normalizeTld] },
  labels: { singular: 'TLD نمایندگی', plural: 'کاتالوگ TLDهای نمایندگی' },
  timestamps: true,
}
