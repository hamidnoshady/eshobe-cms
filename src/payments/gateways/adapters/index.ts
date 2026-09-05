import type { GatewayAdapter, GatewayId } from '../types'

import { digipayAdapter } from './digipay'
import { snappPayAdapter } from './snappPay'
import { torobPayAdapter } from './torobPay'
import { zarinpalAdapter } from './zarinpal'

/**
 * Every gateway the platform can call, keyed by the id stored on `payment-gateways.gateway`
 * and on `orders.payment.provider`.
 *
 * The `Record<GatewayId, …>` type is the point: a descriptor added to `registry.ts` without
 * an adapter here is a compile error, not a runtime `undefined` on somebody's checkout. The
 * inverse — an adapter with no descriptor — is caught by `tests/int/gateways.int.spec.ts`,
 * which walks both tables and compares them, the same way `blocks.int.spec.ts` keeps the
 * block registry and `RenderBlocks.tsx` honest with each other.
 */
export const gatewayAdapters: Record<GatewayId, GatewayAdapter> = {
  digipay: digipayAdapter,
  snappPay: snappPayAdapter,
  torobPay: torobPayAdapter,
  zarinpal: zarinpalAdapter,
}

export const gatewayAdapter = (id: GatewayId): GatewayAdapter => gatewayAdapters[id]
