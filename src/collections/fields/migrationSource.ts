import type { Field } from 'payload'

/**
 * Source provenance, carried identically by every document the WordPress
 * migration can create (issue #166: "preserve original WP/Woo ID, source
 * permalink, source raw payload, source timestamps and relationships").
 *
 * Two rules are load-bearing:
 *
 * - **`rawPayload` never leaves with an anonymous caller.** A source record
 *   can carry postmeta and plugin fields the site owner never meant to
 *   publish, so its read is a staff session only — a site API key does not
 *   unlock it, and the public theme API never sees the key at all. The
 *   *mapped* fields beside it are the publication surface.
 * - **The group defaults describe a native document** (`system: 'eshobe'`,
 *   `mappingStatus: 'manual'`), so editor-created content and
 *   migration-created content are distinguishable at a glance and in queries
 *   without either side needing a sentinel.
 */
export const migrationSourceField = (): Field => ({
  name: 'source',
  type: 'group',
  label: 'منشأ و مهاجرت',
  admin: {
    description:
      'رد مبدأ این سند. برای محتوای ساخته‌شده در همین‌جا سامانه «ای‌شوب» می‌ماند؛ رکورد مهاجر، شناسه و نشانی اصلی وردپرس/ووکامرس را این‌جا نگه می‌دارد تا ورود مجدد بدون تکرار و قابل تطبیق باشد.',
  },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'system',
          type: 'select',
          label: 'سامانه مبدأ',
          admin: { width: '50' },
          defaultValue: 'eshobe',
          index: true,
          options: [
            { label: 'ای‌شوب (بومی)', value: 'eshobe' },
            { label: 'وردپرس', value: 'wordpress' },
            { label: 'ووکامرس', value: 'woocommerce' },
            { label: 'سامانه دیگر', value: 'other' },
          ],
          required: true,
        },
        {
          name: 'mappingStatus',
          type: 'select',
          label: 'وضعیت نگاشت',
          admin: { width: '50' },
          defaultValue: 'manual',
          options: [
            { label: 'دستی', value: 'manual' },
            { label: 'واردشده', value: 'imported' },
            { label: 'بایگانی‌شده', value: 'archived' },
            { label: 'مسدود', value: 'blocked' },
          ],
          required: true,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'installation',
          type: 'text',
          label: 'نصب مبدأ',
          admin: {
            description: 'دامنه یا شناسه نصب وردپرس مبدأ.',
            width: '50',
          },
        },
        {
          name: 'sourceId',
          type: 'text',
          label: 'شناسه در مبدأ',
          admin: { width: '50' },
          index: true,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'sourceType',
          type: 'text',
          label: 'گونه در مبدأ',
          admin: {
            description: 'مثل post_type یا نام طبقه‌بندی وردپرس.',
            width: '50',
          },
        },
        {
          name: 'sourceStatus',
          type: 'text',
          label: 'وضعیت در مبدأ',
          admin: { width: '50' },
        },
      ],
    },
    {
      name: 'sourceAuthorId',
      type: 'text',
      label: 'شناسه نویسنده در مبدأ',
    },
    {
      name: 'permalink',
      type: 'text',
      label: 'پیوسته‌نشانی مبدأ',
      admin: {
        description: 'نشانی کامل رکورد روی سایت قدیمی؛ مبنای نقشه تغییر مسیر.',
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'modifiedAt',
          type: 'date',
          label: 'آخرین ویرایش در مبدأ',
          admin: { width: '50' },
        },
        {
          name: 'contentHash',
          type: 'text',
          label: 'هش محتوای مبدأ',
          admin: {
            description: 'برای تشخیص «بدون تغییر» در هم‌گام‌سازی بعدی.',
            width: '50',
          },
        },
      ],
    },
    {
      name: 'rawPayload',
      type: 'json',
      label: 'بار خام مبدأ',
      access: {
        read: ({ req: { user } }) => Boolean(user),
      },
      admin: {
        description:
          'رکورد کامل مبدأ برای حسابرسی و نگاشت دیرهنگام. در API عمومی و کلید سایت هرگز برنمی‌گردد.',
        readOnly: true,
      },
    },
  ],
})
