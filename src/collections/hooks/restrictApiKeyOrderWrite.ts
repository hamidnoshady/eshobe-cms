import type { CollectionBeforeChangeHook } from 'payload'

import type { Order } from '@/payload-types'
import { isFulfillmentState } from '@/lib/cafe-order'
import { requestApiKey } from '@/access/siteApiKey'

/**
 * WAVE-9 §9.4 — a site key's writes on an order are narrow by design
 * (`src/access/siteApiKey.ts`'s `apiKeyAware` already scopes `update` to the key's own
 * site). This is the second half of that promise: every field the key did not earn
 * reverts to what the document already held, so a compromised or overreaching call can
 * never rewrite a receipt, a buyer's phone number or the amount charged.
 *
 * ## What a site key may write (ESH-150)
 *
 *  - `status` — the payment lifecycle it already owned.
 *  - `cafe.fulfillment` / `cafe.fulfillmentAt` — the kitchen's answer. This is the
 *    POS's own fact and the reason the field exists: Biza accepts, starts, readies or
 *    rejects *its* ticket, and the guest's receipt reads it back. Without this the
 *    documented lifecycle would be unwritable by the only system that knows the answer.
 *    A value outside the closed vocabulary is **dropped, not rejected**: `status` in the
 *    same call is the POS's real assertion, and failing the whole write because it also
 *    sent a state this CMS has never heard of would leave a paid ticket looking unpaid.
 *    Payload's own select validation still refuses it in the ordinary API path.
 *
 * Both are allow-listed, not "everything except the fields on a deny list": a field
 * added to `orders` later is unwritable by a site key by default, which is the safe
 * direction for a mistake to point.
 *
 * A no-op for an admin-session write (no key on the request) and for a create (an order
 * is created by the checkout endpoint, never by a site key).
 */
export const restrictApiKeyOrderWrite: CollectionBeforeChangeHook<Order> = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || !originalDoc) return data

  const key = await requestApiKey(req)
  if (key?.role !== 'site') return data

  const fulfillment = data.cafe?.fulfillment

  return {
    ...originalDoc,
    status: data.status ?? originalDoc.status,
    ...(originalDoc.cafe || fulfillment
      ? {
          cafe: {
            ...originalDoc.cafe,
            // Only a value from the closed vocabulary is accepted; anything else leaves
            // the stored state untouched rather than writing a string no receipt can
            // render.
            ...(isFulfillmentState(fulfillment)
              ? {
                  fulfillment,
                  fulfillmentAt: data.cafe?.fulfillmentAt ?? new Date().toISOString(),
                }
              : {}),
          },
        }
      : {}),
  }
}
