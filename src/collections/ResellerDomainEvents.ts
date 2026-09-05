import type { CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { apiKeyAware } from '@/access/siteApiKey'
import { platformAdmin } from '@/access/platformAdmin'

/** Audit data intentionally records only an action and a safe sentence. It never stores an
 * EPP code, X-Api-Key, unfiltered provider body, or the contacts returned by WHOIS. */
export const ResellerDomainEvents: CollectionConfig<'reseller-domain-events'> = {
  slug: 'reseller-domain-events',
  access: {
    create: () => false,
    delete: platformAdmin,
    read: apiKeyAware(authenticated),
    update: () => false,
  },
  admin: {
    defaultColumns: ['createdAt', 'domain', 'operation', 'ok'],
    description:
      'گزارش امن عملیات registrar. رمز انتقال، کلید API، هدرها، پاسخ خام و اطلاعات تماس هرگز در این گزارش ذخیره نمی‌شوند.',
    group: 'زیرساخت',
    useAsTitle: 'operation',
  },
  fields: [
    {
      name: 'domain',
      type: 'relationship',
      relationTo: 'reseller-domains',
      required: true,
      index: true,
      label: 'دامنه',
    },
    {
      name: 'operation',
      type: 'select',
      required: true,
      label: 'عملیات',
      options: [
        { label: 'ثبت', value: 'register' },
        { label: 'انتقال', value: 'transfer' },
        { label: 'تمدید', value: 'renew' },
        { label: 'دریافت نام‌سرورها', value: 'nameserversGet' },
        { label: 'به‌روزرسانی نام‌سرورها', value: 'nameserversUpdate' },
        { label: 'دریافت قفل انتقال', value: 'lockGet' },
        { label: 'به‌روزرسانی قفل انتقال', value: 'lockUpdate' },
        { label: 'دریافت کد انتقال', value: 'transferCodeGet' },
        { label: 'افزودن child nameserver', value: 'childNameserverAdd' },
        { label: 'به‌روزرسانی child nameserver', value: 'childNameserverUpdate' },
        { label: 'حذف child nameserver', value: 'childNameserverRemove' },
        { label: 'دریافت تماس IRNIC', value: 'irnicContactGet' },
        { label: 'اعتبارسنجی انتقال', value: 'transferValidate' },
        { label: 'دریافت تماس WHOIS', value: 'whoisGet' },
        { label: 'به‌روزرسانی تماس WHOIS', value: 'whoisUpdate' },
      ],
    },
    { name: 'ok', type: 'checkbox', required: true, label: 'موفق' },
    { name: 'summary', type: 'textarea', required: true, label: 'خلاصهٔ امن' },
  ],
  labels: { singular: 'رویداد نمایندگی دامنه', plural: 'رویدادهای نمایندگی دامنه' },
  timestamps: true,
}
