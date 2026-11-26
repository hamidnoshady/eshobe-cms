import type { CollectionConfig } from 'payload'

import { hiddenFromOperators } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { migrationSourceField } from './fields/migrationSource'
import { validateCustomer } from './hooks/validateCustomer'

const noDirectWrite = () => false

/**
 * A storefront customer — deliberately not a CMS `user`.
 *
 * WordPress stores shop customers and staff in one `wp_users` table; Eshobe
 * does not. Importing a Woo customer as a staff account would hand a
 * storefront shopper an admin-panel identity, and copying a WordPress
 * password hash is both a credential transplant and a downgrade. So a
 * customer lands here as a profile + addresses + order relationship with
 * `claimStatus: unclaimed`; account access is established later by the
 * one-time email claim in `src/lib/migration/customer-claims.ts`, never by
 * importing a hash. Reads are staff-only: a customer book is PII.
 */
export const Customers: CollectionConfig = {
  slug: 'customers',
  access: {
    create: authenticated,
    delete: authenticated,
    read: authenticated,
    update: authenticated,
  },
  admin: {
    defaultColumns: ['email', 'firstName', 'lastName', 'phone', 'claimStatus'],
    group: 'فروشگاه',
    hidden: hiddenFromOperators,
    useAsTitle: 'email',
  },
  labels: { plural: 'مشتریان', singular: 'مشتری' },
  fields: [
    { name: 'email', type: 'email', label: 'ایمیل', index: true },
    { name: 'firstName', type: 'text', label: 'نام' },
    { name: 'lastName', type: 'text', label: 'نام خانوادگی' },
    { name: 'displayName', type: 'text', label: 'نام نمایشی' },
    { name: 'phone', type: 'text', label: 'تلفن', index: true },
    {
      name: 'username',
      type: 'text',
      label: 'نام کاربری مبدأ',
      admin: { description: 'فقط برای شناسایی در تطبیق مهاجرت؛ گذرواژه وردپرس هرگز وارد نمی‌شود.' },
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'active',
      options: [
        { label: 'فعال', value: 'active' },
        { label: 'غیرفعال', value: 'inactive' },
        { label: 'مسدود', value: 'blocked' },
      ],
      required: true,
    },
    {
      name: 'claimStatus',
      type: 'select',
      label: 'وضعیت مطالبه حساب',
      defaultValue: 'unclaimed',
      options: [
        { label: 'مطالبه‌نشده', value: 'unclaimed' },
        { label: 'دعوت‌شده', value: 'invited' },
        { label: 'مطالبه‌شده', value: 'claimed' },
        { label: 'غیرفعال', value: 'disabled' },
      ],
      required: true,
    },
    {
      name: 'claimTokenHash',
      type: 'text',
      label: 'هش نشانه مطالبه',
      access: { create: noDirectWrite, read: noDirectWrite, update: noDirectWrite },
    },
    { name: 'claimExpiresAt', type: 'date', label: 'انقضای دعوت مطالبه' },
    { name: 'invitedAt', type: 'date', label: 'زمان دعوت' },
    { name: 'claimedAt', type: 'date', label: 'زمان مطالبه' },
    {
      name: 'addresses',
      type: 'array',
      label: 'نشانی‌ها',
      labels: { plural: 'نشانی‌ها', singular: 'نشانی' },
      fields: [
        { name: 'label', type: 'text', label: 'برچسب' },
        { name: 'firstName', type: 'text', label: 'نام' },
        { name: 'lastName', type: 'text', label: 'نام خانوادگی' },
        { name: 'company', type: 'text', label: 'شرکت' },
        { name: 'address1', type: 'text', label: 'نشانی ۱' },
        { name: 'address2', type: 'text', label: 'نشانی ۲' },
        { name: 'city', type: 'text', label: 'شهر' },
        { name: 'state', type: 'text', label: 'استان' },
        { name: 'postcode', type: 'text', label: 'کد پستی' },
        { name: 'country', type: 'text', label: 'کشور' },
        { name: 'phone', type: 'text', label: 'تلفن' },
        { name: 'email', type: 'email', label: 'ایمیل' },
        { name: 'isDefaultBilling', type: 'checkbox', label: 'پیش‌فرض صورت‌حساب', defaultValue: false },
        { name: 'isDefaultShipping', type: 'checkbox', label: 'پیش‌فرض ارسال', defaultValue: false },
      ],
    },
    { name: 'notes', type: 'textarea', label: 'یادداشت' },
    migrationSourceField({ optional: true }),
  ],
  hooks: { beforeValidate: [validateCustomer] },
}
