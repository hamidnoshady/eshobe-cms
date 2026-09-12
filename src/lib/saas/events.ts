/**
 * The platform's event vocabulary — the closed list of things this deployment says
 * happened.
 *
 * One table, three consumers: `webhooks.events` (which deliveries to make),
 * `audit-log.action` (what to record) and `GET /api/platform/events` (what to
 * report). Keeping them on one list is what makes "we got a webhook but the audit
 * log has nothing" impossible: the same constant produced both or neither.
 *
 * A closed list rather than free strings, for the reason every registry in this
 * codebase is closed (`src/blocks/index.ts`, `QUOTA_METRICS`): a misspelt event
 * name in a webhook subscription is a subscription that silently never fires, and
 * nothing anywhere errors.
 */

export const PLATFORM_EVENTS = {
  'site.created': 'سایت ساخته شد',
  'site.updated': 'سایت به‌روزرسانی شد',
  'site.suspended': 'سایت معلق شد',
  'site.resumed': 'سایت از تعلیق خارج شد',
  'site.deleted': 'سایت حذف شد',
  'domain.changed': 'دامنه تغییر کرد',
  'domain.verified': 'دامنه تأیید شد',
  'subscription.created': 'اشتراک ساخته شد',
  'subscription.changed': 'اشتراک تغییر کرد',
  'subscription.cancelled': 'اشتراک لغو شد',
  'subscription.expired': 'اشتراک منقضی شد',
  'invoice.issued': 'صورتحساب صادر شد',
  'invoice.paid': 'صورتحساب پرداخت شد',
  'invoice.overdue': 'صورتحساب سررسید گذشت',
  'quota.warning': 'نزدیک شدن به سقف',
  'quota.exceeded': 'عبور از سقف',
  'apikey.issued': 'کلید API صادر شد',
  'apikey.revoked': 'کلید API باطل شد',
  'plugin.changed': 'افزونه تغییر کرد',
  'storage.changed': 'اتصال ذخیره‌سازی تغییر کرد',
  'cdn.synced': 'CDN همگام شد',
  'order.paid': 'سفارش پرداخت شد',
  'backup.completed': 'پشتیبان گرفته شد',
  'platform.settingsChanged': 'تنظیمات سکو تغییر کرد',
} as const

export type PlatformEventName = keyof typeof PLATFORM_EVENTS

export const PLATFORM_EVENT_NAMES = Object.keys(PLATFORM_EVENTS) as PlatformEventName[]

/** Select-field shape, shared by `webhooks.events` and the audit log's filter. */
export const PLATFORM_EVENT_OPTIONS = PLATFORM_EVENT_NAMES.map((value) => ({
  label: `${PLATFORM_EVENTS[value]} (${value})`,
  value,
}))

export const isPlatformEvent = (value: unknown): value is PlatformEventName =>
  typeof value === 'string' && value in PLATFORM_EVENTS

/** Severity per event, so a console can colour a feed without a second table. */
export const eventLevel = (name: PlatformEventName): 'error' | 'info' | 'warn' => {
  if (name === 'quota.exceeded' || name === 'invoice.overdue' || name === 'subscription.expired') return 'error'
  if (
    name === 'quota.warning' ||
    name === 'site.suspended' ||
    name === 'subscription.cancelled' ||
    name === 'domain.changed'
  ) {
    return 'warn'
  }
  return 'info'
}

export type PlatformEventPayload = {
  actor?: null | { email?: null | string; id?: null | string; type: 'apiKey' | 'system' | 'user' }
  at: string
  data?: Record<string, unknown>
  event: PlatformEventName
  id: string
  message: string
  site?: null | { domain?: null | string; id: string }
}
