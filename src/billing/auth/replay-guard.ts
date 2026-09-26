import type { PayloadRequest } from 'payload'

import { bodyFingerprint } from '@/billing/auth/sign'

/**
 * Refuse an identical signed body seen twice within the replay window.
 * This is not part of the wire signature — only duplicate suppression.
 */
export const refuseReplayedBillingBody = async (
  req: PayloadRequest,
  args: { body: string; keyId: string; timestamp: string },
): Promise<{ ok: true } | { ok: false; reason: 'replay' }> => {
  const fingerprint = `${args.keyId}:${bodyFingerprint(args.timestamp, args.body)}`
  try {
    await req.payload.create({
      collection: 'billing-replay-nonces',
      data: { bodyHash: fingerprint, keyId: args.keyId, seenAt: new Date().toISOString() },
      depth: 0,
      overrideAccess: true,
      req,
    })
    return { ok: true }
  } catch {
    return { ok: false, reason: 'replay' }
  }
}
