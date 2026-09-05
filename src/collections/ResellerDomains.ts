import type { CollectionBeforeValidateHook, CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { apiKeyAware } from '@/access/siteApiKey'
import { platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { domainValidationMessage, isValidDomain, normalizeDomain } from '@/lib/domains'

const normalizeDomainName: CollectionBeforeValidateHook = ({ data }) => {
  const value = (data as { domain?: unknown } | undefined)?.domain
  return typeof value === 'string' ? { ...data, domain: normalizeDomain(value) } : data
}

const platformOperationalField = {
  create: platformAdminFieldAccess,
  update: platformAdminFieldAccess,
}

/**
 * One platform-managed domain assigned to one site. It is intentionally separate from
 * `sites.domain`: the latter is a hostname the web server may serve; this row is a
 * registrar workflow and remains `providerAccepted` until an operator can verify DNS /
 * registrar completion. A successful order request is never represented as “active”.
 */
export const ResellerDomains: CollectionConfig<'reseller-domains'> = {
  slug: 'reseller-domains',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: apiKeyAware(authenticated),
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['domain', 'site', 'state', 'providerLastSeenAt'],
    description:
      'دامنه‌های ثبت یا منتقل‌شده با حساب نمایندگی پلتفرم. «پذیرفته‌شده توسط registrar» به معنی فعال بودن قطعی دامنه نیست؛ API ارائه‌شده endpoint وضعیت/انقضا ندارد و تأیید عملیاتی جداست.',
    group: 'زیرساخت',
    useAsTitle: 'domain',
  },
  fields: [
    {
      name: 'domain',
      type: 'text',
      label: 'دامنه',
      required: true,
      unique: true,
      index: true,
      validate: (value: unknown) =>
        typeof value === 'string' && isValidDomain(value) ? true : domainValidationMessage,
      admin: { description: 'نام کامل دامنه، بدون پروتکل، مسیر یا پورت.' },
    },
    {
      name: 'tld',
      type: 'text',
      label: 'پسوند کاتالوگ',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'state',
      type: 'select',
      label: 'وضعیت چرخهٔ عمر',
      required: true,
      defaultValue: 'requested',
      index: true,
      options: [
        { label: 'درخواست محلی', value: 'requested' },
        { label: 'پذیرفته‌شده توسط registrar', value: 'providerAccepted' },
        { label: 'فعال — تأیید دستی اپراتور', value: 'active' },
        { label: 'ناموفق', value: 'failed' },
        { label: 'خارج از نمایندگی', value: 'external' },
        { label: 'لغوشده', value: 'cancelled' },
      ],
      access: platformOperationalField,
      admin: {
        description:
          'فقط اپراتور پلتفرم تغییر می‌دهد. API مستندشدهٔ ResellerArea وضعیت سفارش یا انقضای دامنه را نمی‌دهد؛ پاسخ موفق فقط «پذیرفته‌شدن» را ثبت می‌کند.',
      },
    },
    {
      name: 'nameservers',
      type: 'array',
      label: 'نام‌سرورها',
      labels: { singular: 'نام‌سرور', plural: 'نام‌سرورها' },
      maxRows: 5,
      admin: {
        description: 'منبع ثبت‌شدهٔ CMS؛ تغییر واقعی با endpoint مدیریت registrar انجام می‌شود.',
      },
      fields: [
        {
          name: 'hostname',
          type: 'text',
          required: true,
          label: 'نام میزبان',
          validate: (value: unknown) =>
            typeof value === 'string' && isValidDomain(value) ? true : domainValidationMessage,
        },
      ],
    },
    {
      name: 'registrationContact',
      type: 'json',
      label: 'مخاطب ثبت/انتقال',
      admin: {
        description:
          'شیء contact مستند ResellerArea. شامل first_name، last_name، company_name، email، phone، fax، address، city، state، postcode و country. فقط مالک همان سایت به آن دسترسی دارد.',
      },
    },
    {
      name: 'contacts',
      type: 'json',
      label: 'مخاطبان WHOIS',
      admin: {
        description:
          'شیء دارای registrant، administrative، technical و billing برای UpdateDomainWhoisInfo. اطلاعات فقط برای مالک سایت و registrar ارسال می‌شود.',
      },
    },
    {
      name: 'irnicHandles',
      type: 'json',
      label: 'شناسه‌های IRNIC',
      admin: {
        description:
          'برای دامنه‌های .ir: irnic_holder_handle، irnic_admin_handle، irnic_tech_handle و irnic_bill_handle. این اطلاعات جایگزین رابطهٔ مالکیت در IRNIC نمی‌شود.',
      },
    },
    {
      name: 'customFields',
      type: 'json',
      label: 'فیلدهای اختصاصی پسوند',
      admin: { description: 'شیء fields مستند registrar؛ مثلاً شناسه‌های IRNIC برای .ir.' },
    },
    {
      type: 'collapsible',
      label: 'وضعیت امن registrar',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'providerLastSeenAt',
          type: 'date',
          label: 'آخرین پاسخ registrar',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'providerNote',
          type: 'textarea',
          label: 'خلاصهٔ پاسخ',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
      ],
    },
  ],
  hooks: { beforeValidate: [normalizeDomainName] },
  labels: { singular: 'دامنهٔ نمایندگی', plural: 'دامنه‌های نمایندگی' },
  timestamps: true,
}
