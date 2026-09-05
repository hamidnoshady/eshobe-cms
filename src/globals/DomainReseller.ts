import type { GlobalConfig } from 'payload'

import { platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import {
  encryptDomainResellerCredentials,
  maskDomainResellerCredential,
} from '@/globals/hooks/domainResellerSecrets'

const validateApiUrl = (value: unknown): string | true => {
  if (typeof value !== 'string' || !value.trim()) return 'نشانی API الزامی است.'

  try {
    const url = new URL(value)
    const providerHost =
      url.hostname === 'resellerarea.net' ||
      url.hostname.endsWith('.resellerarea.net') ||
      url.hostname === 'irpower.com' ||
      url.hostname.endsWith('.irpower.com')
    return url.protocol === 'https:' && providerHost
      ? true
      : 'نشانی API باید HTTPS و روی resellerarea.net یا irpower.com باشد.'
  } catch {
    return 'نشانی API معتبر نیست.'
  }
}

/**
 * The platform-owned ResellerArea identity. This is a global—not a per-site row—because
 * the platform is the reseller at IRPower and site owners must never hold or choose its
 * API key. Product costs live in the separate global TLD catalogue; the three markups here
 * are deliberately the one price policy for every tenant.
 */
export const DomainReseller: GlobalConfig = {
  slug: 'domain-reseller',
  access: {
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    description:
      'پیکربندی حساب نمایندگی دامنهٔ IRPower برای کل پلتفرم. کلید API فقط روی سرور و به‌صورت رمزنگاری‌شده نگهداری می‌شود؛ مشتریان هرگز آن را نمی‌بینند.',
    group: 'زیرساخت',
  },
  fields: [
    {
      name: 'enabled',
      type: 'checkbox',
      label: 'فروش دامنه فعال است',
      defaultValue: false,
      required: true,
      admin: {
        description:
          'تا وقتی خاموش است، سایت‌ها فقط می‌توانند قیمت کاتالوگ را ببینند و هیچ درخواست یا تغییر دامنه‌ای به registrar ارسال نمی‌شود.',
      },
    },
    {
      name: 'apiEndpoint',
      type: 'text',
      label: 'نشانی API ResellerArea',
      defaultValue: 'https://resellerarea.net/api',
      required: true,
      validate: validateApiUrl,
      admin: {
        description:
          'مطابق مستند ResellerArea. در صورت ارائهٔ endpoint اختصاصی IRPower، همان نشانی HTTPS را وارد کنید.',
      },
    },
    {
      name: 'margins',
      type: 'group',
      label: 'سود فروش پلتفرم',
      admin: {
        description:
          'درصد سود روی قیمت پایهٔ هر TLD در «کاتالوگ TLDها» اعمال می‌شود. این درصدها سراسری‌اند، نه برای هر سایت یا مشتری.',
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'registrationPercent',
              type: 'number',
              label: 'ثبت جدید (%)',
              defaultValue: 0,
              required: true,
              min: 0,
              max: 1000,
              admin: { width: '33' },
            },
            {
              name: 'transferPercent',
              type: 'number',
              label: 'انتقال (%)',
              defaultValue: 0,
              required: true,
              min: 0,
              max: 1000,
              admin: { width: '33' },
            },
            {
              name: 'renewalPercent',
              type: 'number',
              label: 'تمدید (%)',
              defaultValue: 0,
              required: true,
              min: 0,
              max: 1000,
              admin: { width: '33' },
            },
          ],
        },
      ],
    },
    {
      name: 'credentials',
      type: 'group',
      label: 'اعتبارنامهٔ حساب نمایندگی',
      admin: {
        description:
          'کلید فقط هنگام تایپ قابل مشاهده است. با ذخیره شدن AES-256-GCM رمزنگاری می‌شود و بعد از آن از پنل، REST و GraphQL بازگردانده نمی‌شود. خالی گذاشتن در ویرایش یعنی نگه‌داشتن کلید قبلی.',
      },
      fields: [
        {
          name: 'apiKey',
          type: 'text',
          label: 'X-Api-Key',
          access: {
            create: platformAdminFieldAccess,
            read: platformAdminFieldAccess,
            update: platformAdminFieldAccess,
          },
          hooks: { afterRead: [maskDomainResellerCredential()] },
        },
      ],
    },
    {
      name: 'clearCredentials',
      type: 'checkbox',
      label: 'پاک کردن کلید API ذخیره‌شده',
      defaultValue: false,
      access: {
        create: platformAdminFieldAccess,
        read: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      admin: { description: 'برای پاک‌سازی قطعی تیک بزنید و ذخیره کنید.' },
    },
    {
      name: 'credentialsSummary',
      type: 'text',
      label: 'وضعیت اعتبارنامه',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
  ],
  hooks: { beforeChange: [encryptDomainResellerCredentials] },
  label: 'نمایندگی دامنه',
}
