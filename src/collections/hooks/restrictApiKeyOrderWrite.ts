import type { CollectionBeforeChangeHook } from 'payload'

import type { Order } from '@/payload-types'
import { requestApiKey } from '@/access/siteApiKey'

/**
 * WAVE-9 §9.4 — a site key's one write on an order is a status transition
 * (`src/access/siteApiKey.ts`'s `apiKeyAware` already scopes `update` to the key's
 * own site). This is the second half of that promise: every field *but* `status`
 * reverts to what the document already held, so a compromised or overreaching key
 * call can never rewrite a receipt, a buyer's phone number or the amount charged —
 * only move the order along its own status list.
 *
 * A no-op for an admin-session write (no key on the request) and for a create (an
 * order is created by the checkout endpoint, never by a site key).
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

  return { ...originalDoc, status: data.status ?? originalDoc.status }
}
