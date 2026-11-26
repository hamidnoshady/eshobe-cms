import type { Field } from 'payload'

/**
 * Source provenance, carried identically by every document the WordPress
 * migration can create (issue #166: "preserve original WP/Woo ID, source
 * permalink, source raw payload, source timestamps and relationships").
 *
 * Three rules are load-bearing:
 *
 * - **This is not editorial content (issue #236).** The group is `admin.hidden`,
 *   so no create/edit view renders it — not a collapsed stub, not a blank
 *   panel. Imported records get a read-only, on-demand «جزئیات مهاجرت» view
 *   instead (`migrationDetailsField` below, `MigrationDetails` component), and
 *   native records get nothing at all. All import management lives in one
 *   place: «ابزارها → درون‌ریزی» (`/admin/migration-center`).
 * - **An ordinary save can never create or rewrite provenance.** Field-level
 *   `create`/`update` access is `false`, so Payload drops the submitted group
 *   and, on update, falls back to the stored document's value
 *   (`fields/hooks/beforeValidate/promise.js`). The migration engine and other
 *   service writes still write it through `overrideAccess: true`; a create
 *   without that flag keeps the native defaults below. Admin hiding is *not*
 *   the protection — this access rule is.
 * - **`rawPayload` never leaves with an anonymous caller.** A source record
 *   can carry postmeta and plugin fields the site owner never meant to
 *   publish, so its read is a staff session only — a site API key does not
 *   unlock it, and the public theme API never sees the key at all. The
 *   *mapped* fields beside it are the publication surface.
 *
 * The group defaults describe a native document (`system: 'eshobe'`,
 * `mappingStatus: 'manual'`), so editor-created content and
 * migration-created content are distinguishable in queries without either
 * side needing a sentinel.
 */
/**
 * `optional` is for collections that predate provenance (pages, posts,
 * products, orders, media…): leaving the two classifying selects
 * non-required keeps the group itself optional in the generated types, so a
 * decade of existing create call sites stays valid. The defaults still
 * stamp a native document when the group is written.
 */
export const migrationSourceField = ({ optional = false }: { optional?: boolean } = {}): Field => ({
  name: 'source',
  type: 'group',
  label: 'منشأ و مهاجرت',
  admin: {
    description:
      'رد مبدأ این سند. برای محتوای ساخته‌شده در همین‌جا سامانه «ای‌شوب» می‌ماند؛ رکورد مهاجر، شناسه و نشانی اصلی وردپرس/ووکامرس را این‌جا نگه می‌دارد تا ورود مجدد بدون تکرار و قابل تطبیق باشد.',
    // Provenance belongs to the import engine, not the editor. It is still
    // read through the admin's data layer so `MigrationDetails` can show it.
    hidden: true,
  },
  access: {
    /**
     * Service-only. A normal editor save (admin or REST) cannot write
     * provenance: Payload deletes the field and, on update, restores the
     * stored value — so an imported record keeps its source identifiers and
     * hashes no matter what the form submits.
     */
    create: () => false,
    update: () => false,
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
          required: !optional,
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
          required: !optional,
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

/** Name of the read-only, on-demand view that replaces the hidden group. */
export const MIGRATION_DETAILS_FIELD = 'migrationDetails'

/**
 * A `ui` field: no column, no API value, nothing to save. It renders
 * `MigrationDetails`, which draws a compact conflict warning plus a collapsed,
 * read-only panel — and only for a record that actually came from an import
 * (`source.system !== 'eshobe'`). A native document renders nothing, and the
 * panel itself re-checks the caller's permission and the record's provenance.
 */
export const migrationDetailsField = (): Field => ({
  name: MIGRATION_DETAILS_FIELD,
  type: 'ui',
  admin: {
    components: {
      Field: '@/admin/fields/MigrationDetails#MigrationDetails',
    },
    condition: (data) => {
      const source = (data as { source?: { system?: unknown } } | null | undefined)?.source
      return typeof source?.system === 'string' && source.system !== 'eshobe'
    },
  },
})
