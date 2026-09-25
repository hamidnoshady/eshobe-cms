import type { PayloadRequest, Where } from 'payload'

/**
 * A store site's control-centre summary, computed tenant-scoped.
 *
 * Every read below runs with the caller's own `req`, so the multi-tenant plugin
 * narrows each `count`/`find` to the site(s) the request belongs to — a store
 * overview can never count another tenant's orders or products. It mirrors the
 * shape the product brief asks a store overview to show (recent/pending/paid
 * orders, product count, stock warnings, payment-configuration health) and
 * nothing more: no revenue roll-up that would need an unbounded scan of orders.
 *
 * Each query is individually guarded — one failing count must not blank the whole
 * dashboard — matching how `CustomerDashboard` already treats its own reads.
 */

/** At or below this on-hand count (but above zero) a tracked product is "low stock". */
export const LOW_STOCK_THRESHOLD = 5

export type StoreOrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded'

export type StoreRecentOrder = {
  createdAt: string
  currency: string
  id: string
  productTitle: string
  reference: string
  status: string
  total: number
}

export type StoreOverview = {
  orders: {
    cancelled: number
    paid: number
    pending: number
    recent: StoreRecentOrder[]
    refunded: number
    total: number
  }
  payments: {
    /** Enabled gateways whose last self-test is not passing (0 = all good). */
    needsAttention: number
    /** Gateways with a row for this site, whether on or off. */
    configured: number
    /** Gateways switched on. */
    enabled: number
    /** Enabled gateways whose last self-test passed. */
    healthy: number
  }
  products: {
    outOfStock: number
    lowStock: number
    published: number
    total: number
  }
}

export const storeOverview = async (req: PayloadRequest): Promise<StoreOverview> => {
  const { payload } = req

  // `overrideAccess: false` is what makes every read tenant-scoped: it is the
  // difference between the multi-tenant plugin's read constraint being applied
  // (this site only) and being skipped (every customer's data). See the same rule
  // in `src/lib/site-query.ts`.
  const count = async (collection: 'orders' | 'products', where?: Where): Promise<number> => {
    try {
      const { totalDocs } = await payload.count({ collection, overrideAccess: false, req, where })
      return totalDocs
    } catch {
      return 0
    }
  }

  const [
    ordersTotal,
    ordersPending,
    ordersPaid,
    ordersCancelled,
    ordersRefunded,
    productsTotal,
    productsPublished,
    productsLowStock,
    productsOutOfStock,
  ] = await Promise.all([
    count('orders'),
    count('orders', { status: { equals: 'pending' } }),
    count('orders', { status: { equals: 'paid' } }),
    count('orders', { status: { equals: 'cancelled' } }),
    count('orders', { status: { equals: 'refunded' } }),
    count('products'),
    count('products', { _status: { equals: 'published' } }),
    count('products', {
      and: [
        { trackInventory: { equals: true } },
        { inventory: { greater_than: 0 } },
        { inventory: { less_than_equal: LOW_STOCK_THRESHOLD } },
      ],
    }),
    count('products', {
      and: [{ trackInventory: { equals: true } }, { inventory: { less_than_equal: 0 } }],
    }),
  ])

  let recent: StoreRecentOrder[] = []
  try {
    const { docs } = await payload.find({
      collection: 'orders',
      depth: 0,
      limit: 5,
      overrideAccess: false,
      req,
      select: {
        createdAt: true,
        currency: true,
        productTitle: true,
        reference: true,
        status: true,
        total: true,
      },
      sort: '-createdAt',
    })
    recent = docs.map((doc) => ({
      createdAt: String(doc.createdAt ?? ''),
      currency: String((doc as { currency?: unknown }).currency ?? ''),
      id: String(doc.id),
      productTitle: String((doc as { productTitle?: unknown }).productTitle ?? ''),
      reference: String((doc as { reference?: unknown }).reference ?? ''),
      status: String((doc as { status?: unknown }).status ?? ''),
      total: Number((doc as { total?: unknown }).total ?? 0),
    }))
  } catch {
    recent = []
  }

  let configured = 0
  let enabled = 0
  let healthy = 0
  try {
    const { docs } = await payload.find({
      collection: 'payment-gateways',
      depth: 0,
      limit: 50,
      overrideAccess: false,
      req,
      select: { enabled: true, selfTestOk: true },
    })
    configured = docs.length
    for (const doc of docs) {
      const on = Boolean((doc as { enabled?: unknown }).enabled)
      if (!on) continue
      enabled += 1
      if (Boolean((doc as { selfTestOk?: unknown }).selfTestOk)) healthy += 1
    }
  } catch {
    /* leave the payment counters at zero */
  }

  return {
    orders: {
      cancelled: ordersCancelled,
      paid: ordersPaid,
      pending: ordersPending,
      recent,
      refunded: ordersRefunded,
      total: ordersTotal,
    },
    payments: {
      configured,
      enabled,
      healthy,
      needsAttention: Math.max(0, enabled - healthy),
    },
    products: {
      lowStock: productsLowStock,
      outOfStock: productsOutOfStock,
      published: productsPublished,
      total: productsTotal,
    },
  }
}
