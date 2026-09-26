import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { PLATFORM_GROUPS } from '@/admin/visibility'
import { isEntitled, periodEnd, SUBSCRIPTION_STATUSES } from '@/lib/saas/plans'
import { freezeCommercialWrites } from './hooks/freezeCommercialWrites'
import { syncSubscriptionPeriod, oneSubscriptionPerSite } from './hooks/subscriptionLifecycle'

const STATUS_LABELS: Record<(typeof SUBSCRIPTION_STATUSES)[number], string> = {
  active: 'فعال',
  cancelled: 'لغو شده',
  expired: 'منقضی',
  pastDue: 'پرداخت عقب‌افتاده',
  suspended: 'معلق',
  trialing: 'دورهٔ آزمایشی',
}

/**
 * Legacy archive of subscription rows. Commercial lifecycle, renewal, trial and
 * past-due policy belong to cafe-restaurant-pos. This collection is not written
 * by the application. `serving` for a live site comes from the central
 * entitlement projection, not from these rows.
 *
 * ## Why a collection and not fields on `sites`
 *
 * A subscription has a *history*. `sites.plan` would answer "what is this customer
 * on today" and destroy the answer to "what were they on in Mordad, when they were
 * invoiced" every time somebody upgraded. Invoices point at a subscription, and an
 * invoice whose plan changed retroactively is not an invoice.
 *
 * ## Why it is platform-admin-only and *still* carries `site`
 *
 * `access` is `platformAdmin` on every operation — a customer cannot change their
 * own plan from inside the CMS, because that is a purchase, not a content edit. But
 * the row is registered with the multi-tenant plugin all the same, exactly as
 * `cdn-zones` is and for the reason CLAUDE.md records: registration is what keeps a
 * future access relaxation from turning these into rows shared by every tenant. The
 * `site` field is also what every quota and entitlement lookup joins on.
 *
 * ## `pastDue` still serves
 *
 * `isEntitled` treats `pastDue` as live (see `src/lib/saas/plans.ts`). Turning a
 * customer's website off the hour a payment fails loses the customer *and* the
 * money. Suspension is a deliberate operator action, and it is visible as such.
 */
export const Subscriptions: CollectionConfig<'subscriptions'> = {
  slug: 'subscriptions',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['site', 'plan', 'status', 'currentPeriodEnd', 'autoRenew'],
    description:
      'بایگانی فقط‌خواندنیِ اشتراک‌های قدیمی. تمدید، تعویق و صورتحساب در پلتفرم اشوب است.',
    group: PLATFORM_GROUPS.billing,
    hidden: true,
    useAsTitle: 'reference',
  },
  labels: { plural: 'اشتراک‌ها', singular: 'اشتراک' },
  fields: [
    {
      name: 'reference',
      type: 'text',
      label: 'شناسه',
      index: true,
      access: { create: () => false, update: () => false },
      admin: {
        description: 'خودکار از روی سایت و طرح ساخته می‌شود؛ برای پیدا کردن ردیف در گزارش‌ها.',
        readOnly: true,
      },
    },
    {
      name: 'plan',
      type: 'relationship',
      relationTo: 'plans',
      required: true,
      index: true,
      label: 'طرح',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          label: 'وضعیت',
          defaultValue: 'trialing',
          required: true,
          index: true,
          options: SUBSCRIPTION_STATUSES.map((value) => ({ label: STATUS_LABELS[value], value })),
          admin: {
            width: '50',
            description:
              '«پرداخت عقب‌افتاده» سایت را از کار نمی‌اندازد — تعلیق یک تصمیم صریح اپراتور است، نه نتیجهٔ خودکار یک پرداخت ناموفق.',
          },
        },
        {
          name: 'autoRenew',
          type: 'checkbox',
          label: 'تمدید خودکار',
          defaultValue: true,
          admin: {
            width: '50',
            description: 'در پایان دوره، صورتحساب بعدی ساخته می‌شود. برای طرح دائمی بی‌اثر است.',
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'startedAt',
          type: 'date',
          label: 'شروع',
          admin: { width: '33', description: 'خالی بماند، لحظهٔ ساخت ثبت می‌شود.' },
        },
        {
          name: 'currentPeriodStart',
          type: 'date',
          label: 'شروع دورهٔ جاری',
          admin: { width: '33', readOnly: true },
          access: { create: () => false, update: () => false },
        },
        {
          name: 'currentPeriodEnd',
          type: 'date',
          label: 'پایان دورهٔ جاری',
          index: true,
          admin: {
            width: '34',
            readOnly: true,
            description: 'از روی دورهٔ طرح محاسبه می‌شود. برای طرح دائمی خالی می‌ماند.',
          },
          access: { create: () => false, update: () => false },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'trialEndsAt',
          type: 'date',
          label: 'پایان دورهٔ آزمایشی',
          admin: { width: '50', readOnly: true },
          access: { create: () => false, update: () => false },
        },
        {
          name: 'cancelledAt',
          type: 'date',
          label: 'لغو شده در',
          admin: { width: '50', description: 'با انتخاب وضعیت «لغو شده» خودکار پر می‌شود.' },
        },
      ],
    },
    {
      /**
       * Per-subscription quota overrides.
       *
       * A deal is a deal: "the same Pro plan but with 50 sites' worth of media"
       * happens, and the alternative is a private plan row per customer, which makes
       * the price list unreadable within a year. Blank means "use the plan's number",
       * never zero — `resolveQuotaLimits` merges only the keys actually set.
       */
      name: 'limitOverrides',
      type: 'json',
      label: 'سقف‌های اختصاصی',
      admin: {
        description:
          'اختیاری و فقط برای قراردادهای خاص. یک شیء JSON مثل {"media": 5000} — کلیدهای نوشته‌نشده از خود طرح می‌آیند.',
      },
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت داخلی',
      admin: { description: 'شمارهٔ قرارداد، شرط تخفیف، هر چیزی که یک اپراتور دیگر باید بداند.' },
    },
    {
      name: 'entitled',
      type: 'checkbox',
      label: 'در حال سرویس‌دهی',
      access: { create: () => false, update: () => false },
      admin: {
        description: 'از روی وضعیت محاسبه می‌شود: فعال، آزمایشی یا پرداخت عقب‌افتاده.',
        position: 'sidebar',
        readOnly: true,
      },
      hooks: {
        // Derived, never typed. It exists as a stored column rather than a virtual
        // field so the fleet report can `count` on it instead of reading every row.
        beforeChange: [({ siblingData }) => isEntitled((siblingData as { status?: unknown })?.status)],
      },
    },
  ],
  hooks: {
    beforeChange: [syncSubscriptionPeriod],
    beforeValidate: [freezeCommercialWrites, oneSubscriptionPerSite],
  },
  timestamps: true,
}

/** Re-exported for the renewal job and the endpoints, which both need the same arithmetic. */
export { periodEnd }
