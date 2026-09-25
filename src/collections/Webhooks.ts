import type { CollectionConfig, FieldAccess } from 'payload'

import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { PLATFORM_EVENT_OPTIONS } from '@/lib/saas/events'
import { webhookEndpoints } from '@/endpoints/webhooks'
import {
  PLATFORM_SECRET_READ_CONTEXT_KEY,
  encryptWebhookSecret,
  maskPlatformSecret,
} from './hooks/platformSecrets'

/**
 * Outbound webhooks: the platform telling somebody else's system that something
 * happened here.
 *
 * ## Why a platform collection and not a per-site one
 *
 * The consumers are the operator's own systems — a billing ledger, a provisioning
 * pipeline, a Slack relay, the sibling POS. A customer wanting a webhook on their
 * own content is a different product, and it would need per-tenant delivery limits,
 * per-tenant failure isolation and a per-tenant secret rotation story. A row here
 * may *filter* by site, which covers "tell me about acme.ir" without pretending to
 * be a tenant-facing feature.
 *
 * ## The three things that make a webhook safe
 *
 *  1. **Always signed.** `encryptWebhookSecret` generates a secret when none is
 *     given, so an unsigned endpoint cannot be created by leaving a field blank.
 *     The signature is `sha256=HMAC(secret, "<timestamp>.<body>")` — timestamp
 *     *inside* the signed string, which is what makes a captured delivery
 *     replay-detectable rather than replayable forever.
 *  2. **https only, and no private address.** `validateWebhookUrl` refuses
 *     loopback, link-local and RFC1918 hosts: an operator-configurable URL that the
 *     server fetches is a server-side request forgery primitive, and the CMS can
 *     reach the database and the metadata service from where it stands.
 *  3. **Delivery is best-effort and bounded.** Nothing that produces an event waits
 *     on a receiver — a paid order must not fail because somebody's Slack relay is
 *     down, which is the rule `src/lib/renderer-webhook.ts` already states for its
 *     own hook. Failures land in `webhook-deliveries` with the response status, and
 *     a run of them disables the endpoint rather than retrying forever.
 */

const secretReadAccess: FieldAccess = ({ req }) =>
  isPlatformAdmin(req.user) || req.context[PLATFORM_SECRET_READ_CONTEXT_KEY] === true

/**
 * https, a public host, no credentials in the URL.
 *
 * `http` is allowed only when `WEBHOOK_ALLOW_INSECURE=true`, which exists for a dev
 * loop against a local receiver and is checked per call rather than captured at
 * import (CLAUDE.md: an env-tunable read at module load is frozen and untestable).
 */
export const validateWebhookUrl = (value: unknown): string | true => {
  const raw = String(value ?? '').trim()
  if (!raw) return 'نشانی الزامی است.'

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'نشانی معتبر نیست.'
  }

  const insecureAllowed = process.env.WEBHOOK_ALLOW_INSECURE === 'true'
  if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) {
    return 'نشانی باید با https:// شروع شود.'
  }

  if (url.username || url.password) return 'نام کاربری و رمز را داخل نشانی نگذارید؛ از کلید امضا استفاده کنید.'

  const host = url.hostname.toLowerCase()
  const privateHost =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    host === '[::1]'

  if (privateHost && !insecureAllowed) {
    return 'نشانی داخلی و لوکال پذیرفته نمی‌شود — سرور نباید به شبکهٔ داخلی خودش درخواست بزند.'
  }

  return true
}

export const Webhooks: CollectionConfig<'webhooks'> = {
  slug: 'webhooks',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'url', 'enabled', 'consecutiveFailures', 'lastDeliveryAt'],
    description:
      'اعلان‌های خروجی سکو به سامانه‌های دیگر. هر ارسال با کلید محرمانه امضا می‌شود؛ نشانی باید https و عمومی باشد.',
    group: PLATFORM_GROUPS.integrations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  labels: { plural: 'وب‌هوک‌ها', singular: 'وب‌هوک' },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام',
      required: true,
      admin: { description: 'برای خودتان — مثلاً «دفتر مالی» یا «کانال اعلان پشتیبانی».' },
    },
    {
      name: 'url',
      type: 'text',
      label: 'نشانی مقصد',
      required: true,
      validate: validateWebhookUrl,
      admin: { description: 'فقط https و میزبان عمومی. نام کاربری/رمز داخل نشانی پذیرفته نمی‌شود.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'enabled',
          type: 'checkbox',
          label: 'فعال',
          defaultValue: true,
          index: true,
          admin: { width: '50' },
        },
        {
          name: 'site',
          type: 'relationship',
          relationTo: 'sites',
          label: 'فقط برای سایت',
          admin: {
            width: '50',
            description: 'خالی یعنی رویدادهای همهٔ سایت‌ها و رویدادهای سطح سکو.',
          },
        },
      ],
    },
    {
      name: 'events',
      type: 'select',
      label: 'رویدادها',
      hasMany: true,
      required: true,
      options: PLATFORM_EVENT_OPTIONS,
      admin: {
        description: 'فقط این رویدادها ارسال می‌شوند. فهرست بسته است — هر مقدار، یک رویدادی است که این کد تولید می‌کند.',
      },
    },
    {
      name: 'secret',
      type: 'text',
      label: 'کلید امضا',
      access: {
        create: platformAdminFieldAccess,
        read: secretReadAccess,
        update: platformAdminFieldAccess,
      },
      hooks: { afterRead: [maskPlatformSecret()] },
      admin: {
        description:
          'خالی بگذارید تا خودکار ساخته شود. رمزنگاری‌شده ذخیره می‌شود و دیگر برگردانده نمی‌شود؛ برای دیدن یک‌بارهٔ کلید تازه، از «ساخت کلید جدید» در فهرست استفاده کنید.',
      },
    },
    {
      name: 'clearSecret',
      type: 'checkbox',
      label: 'ساخت کلید امضای جدید',
      defaultValue: false,
      admin: { description: 'با ذخیره، کلید فعلی باطل و کلید تازه‌ای ساخته می‌شود. گیرنده باید هم‌زمان به‌روز شود.' },
    },
    {
      name: 'secretSummary',
      type: 'text',
      label: 'وضعیت کلید امضا',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      type: 'collapsible',
      label: 'وضعیت ارسال',
      admin: { initCollapsed: true },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'lastDeliveryAt',
              type: 'date',
              label: 'آخرین ارسال',
              access: { create: () => false, update: () => false },
              admin: { readOnly: true, width: '50' },
            },
            {
              name: 'lastDeliveryOk',
              type: 'checkbox',
              label: 'آخرین ارسال موفق بود',
              access: { create: () => false, update: () => false },
              admin: { readOnly: true, width: '50' },
            },
          ],
        },
        {
          name: 'consecutiveFailures',
          type: 'number',
          label: 'خطاهای پیاپی',
          defaultValue: 0,
          access: { create: () => false, update: () => false },
          admin: {
            readOnly: true,
            description:
              'پس از رسیدن به سقفِ تنظیمات سکو، وب‌هوک خودکار خاموش می‌شود — یک گیرندهٔ خراب نباید تا ابد صف را مصرف کند.',
          },
        },
        {
          name: 'lastError',
          type: 'text',
          label: 'آخرین خطا',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
      ],
    },
  ],
  /**
   * `/api/webhooks/test` and `/api/webhooks/rotate-secret` are collection endpoints,
   * not top-level ones: Payload dispatches `/api/<first-segment>/…` against the
   * collection whose slug matches, and never falls back to `config.endpoints`. A
   * top-level `/webhooks/test` would 404 forever (CLAUDE.md, Payload section —
   * `/api-keys/issue` and `/storage-connections/self-test` both learned this).
   */
  endpoints: webhookEndpoints,
  hooks: {
    beforeChange: [encryptWebhookSecret],
  },
  timestamps: true,
}
