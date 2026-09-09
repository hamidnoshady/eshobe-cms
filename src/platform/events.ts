import type { PayloadRequest } from 'payload'

import {
  clampLimit,
  compareEventsDesc,
  parseSince,
  type ControlEvent,
} from '@/lib/platform-control'

/**
 * The CMS's own tail, in one call — what the POS ships into OpenObserve.
 *
 * `console.error` inside this deployment exists for one boot of one container and
 * then never again (the same argument `docs/openobserve.md` makes on the POS side).
 * The CMS holds the *durable* half of the same knowledge in its own tables: a site
 * whose status changed, an order that arrived, a gateway whose self-test failed, a
 * domain nobody has verified, a key that was issued. This turns those rows into one
 * uniform, newest-first feed with a stable `id` per record, so the POS's shipper can
 * poll it on a cursor and drop what it has already sent.
 *
 * Deliberately not a log store of its own: nothing is written here, and nothing is
 * retained beyond what the rows themselves keep. The CMS is the source; the log
 * store is where an operator reads and alerts on it.
 */

const MAX_EVENTS = 500

const siteLabel = (site: unknown): { domain: null | string; id: null | string } => {
  if (site && typeof site === 'object') {
    const doc = site as { domain?: unknown; id?: unknown }
    return {
      domain: typeof doc.domain === 'string' ? doc.domain : null,
      id: doc.id === undefined || doc.id === null ? null : String(doc.id),
    }
  }
  return { domain: null, id: site === undefined || site === null ? null : String(site) }
}

export const platformEvents = async (
  req: PayloadRequest,
  opts: { limit?: unknown; since?: unknown } = {},
): Promise<{ cursor: null | string; events: ControlEvent[]; since: string }> => {
  const since = parseSince(opts.since)
  const sinceIso = since.toISOString()
  const limit = clampLimit(opts.limit, 200, MAX_EVENTS)

  const events: ControlEvent[] = []

  const sites = await req.payload.find({
    collection: 'sites',
    depth: 0,
    limit,
    overrideAccess: true,
    req,
    select: { name: true, createdAt: true, domain: true, domainVerified: true, status: true, updatedAt: true },
    sort: '-updatedAt',
    where: { updatedAt: { greater_than: sinceIso } },
  })

  for (const doc of sites.docs as unknown as Record<string, unknown>[]) {
    const id = String(doc.id)
    const at = String(doc.updatedAt ?? doc.createdAt ?? sinceIso)
    const status = String(doc.status ?? 'active')
    const suspended = status !== 'active'
    events.push({
      at,
      data: { domainVerified: doc.domainVerified === true, status },
      // The id carries the instant: one site row changing twice is two records, and
      // the shipper's dedupe is on `id` alone.
      id: `site:${id}:${at}`,
      kind: suspended ? 'site.suspended' : 'site.changed',
      level: suspended ? 'warn' : 'info',
      message: suspended
        ? `سایت ${doc.domain ?? id} در وضعیت ${status} است.`
        : `سایت ${doc.domain ?? id} به‌روزرسانی شد.`,
      siteDomain: typeof doc.domain === 'string' ? doc.domain : null,
      siteId: id,
    })
    if (doc.domainVerified !== true) {
      events.push({
        at,
        data: { domain: doc.domain ?? null },
        id: `domain:${id}:${at}`,
        kind: 'domain.unverified',
        level: 'warn',
        message: `دامنهٔ ${doc.domain ?? id} تأیید نشده است.`,
        siteDomain: typeof doc.domain === 'string' ? doc.domain : null,
        siteId: id,
      })
    }
  }

  const orders = await req.payload.find({
    collection: 'orders',
    depth: 1,
    limit,
    overrideAccess: true,
    req,
    select: { createdAt: true, currency: true, reference: true, site: true, status: true, total: true },
    sort: '-createdAt',
    where: { createdAt: { greater_than: sinceIso } },
  })

  for (const doc of orders.docs as unknown as Record<string, unknown>[]) {
    const site = siteLabel(doc.site)
    const at = String(doc.createdAt ?? sinceIso)
    events.push({
      at,
      data: {
        currency: doc.currency ?? null,
        reference: doc.reference ?? null,
        status: doc.status ?? null,
        total: doc.total ?? null,
      },
      id: `order:${String(doc.id)}`,
      kind: 'order.placed',
      level: 'info',
      message: `سفارش ${doc.reference ?? doc.id} با وضعیت ${doc.status ?? '—'} ثبت شد.`,
      siteDomain: site.domain,
      siteId: site.id,
    })
  }

  const gateways = await req.payload.find({
    collection: 'payment-gateways',
    depth: 1,
    limit,
    overrideAccess: true,
    req,
    select: { enabled: true, gateway: true, selfTestAt: true, selfTestDetail: true, selfTestOk: true, site: true },
    sort: '-selfTestAt',
    where: { selfTestAt: { greater_than: sinceIso } },
  })

  for (const doc of gateways.docs as unknown as Record<string, unknown>[]) {
    const site = siteLabel(doc.site)
    const at = String(doc.selfTestAt)
    const ok = doc.selfTestOk === true
    events.push({
      at,
      // `selfTestDetail` is the adapter's own message about a merchant account, never a
      // credential (WAVE-10: the specific detail goes to the log, the buyer sees coarse
      // Persian) — and the log is exactly where this record is going.
      data: { detail: doc.selfTestDetail ?? null, enabled: doc.enabled === true, ok },
      id: `gateway:${String(doc.id)}:${at}`,
      kind: 'gateway.selftest',
      level: ok ? 'info' : 'error',
      message: ok
        ? `خودآزمایی درگاه ${doc.gateway} موفق بود.`
        : `خودآزمایی درگاه ${doc.gateway} ناموفق بود.`,
      siteDomain: site.domain,
      siteId: site.id,
    })
  }

  const keys = await req.payload.find({
    collection: 'api-keys',
    depth: 1,
    limit,
    overrideAccess: true,
    req,
    select: { name: true, createdAt: true, disabledAt: true, role: true, site: true },
    sort: '-createdAt',
    where: { createdAt: { greater_than: sinceIso } },
  })

  for (const doc of keys.docs as unknown as Record<string, unknown>[]) {
    const site = siteLabel(doc.site)
    const at = String(doc.createdAt ?? sinceIso)
    events.push({
      at,
      data: { disabled: Boolean(doc.disabledAt), name: doc.name ?? null, role: doc.role ?? null },
      id: `key:${String(doc.id)}`,
      kind: 'key.issued',
      // A credential being minted is the record an operator most wants to find later,
      // so it is `warn` rather than `info`: it should stand out in a level filter.
      level: 'warn',
      message: `کلید «${doc.name ?? '—'}» (${doc.role ?? '—'}) صادر شد.`,
      siteDomain: site.domain,
      siteId: site.id,
    })
  }

  events.sort(compareEventsDesc)
  const page = events.slice(0, limit)
  return {
    // The cursor is the newest instant in this page, not `now`: the shipper must be
    // able to re-ask for everything after what it actually received, or a record
    // written while the query ran is skipped forever.
    cursor: page[0]?.at ?? null,
    events: page,
    since: sinceIso,
  }
}
