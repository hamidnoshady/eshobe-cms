import type { PayloadRequest } from 'payload'

import { activeBillingCredentials } from '@/billing/auth/credentials'
import {
  BILLING_KEY_HEADER,
  BILLING_SIGNATURE_HEADER,
  BILLING_TIMESTAMP_HEADER,
  bodyFingerprint,
  verifyBillingSignature,
  type BillingScope,
} from '@/billing/auth/sign'

export type VerifiedServiceCall = { body: string; keyId: string; parsed: unknown }

const header = (req: PayloadRequest, name: string): null | string => {
  const headers = req.headers
  if (!headers || typeof headers.get !== 'function') return null
  return headers.get(name)
}

const rawBody = async (req: PayloadRequest): Promise<string> => {
  if (typeof req.text === 'function') return req.text()
  if (typeof req.json === 'function') return JSON.stringify(await req.json())
  return ''
}

/**
 * Accept a request signed by an active billing credential that holds `scope`.
 * A site key, a platform key and a missing signature all fail the same way:
 * this route is not a platform-admin surface.
 */
export const verifyBillingRequest = async (
  req: PayloadRequest,
  scope: BillingScope,
): Promise<{ error: Response; ok: false } | { ok: true; call: VerifiedServiceCall }> => {
  const keyId = header(req, BILLING_KEY_HEADER)
  const timestamp = header(req, BILLING_TIMESTAMP_HEADER)
  const signature = header(req, BILLING_SIGNATURE_HEADER)
  const body = await rawBody(req)
  if (!keyId || !timestamp || !signature) {
    return { error: Response.json({ message: 'امضای سرویس صورت‌حساب لازم است.', ok: false }, { status: 401 }), ok: false }
  }

  const credentials = (await activeBillingCredentials(req)).filter(
    (item) => item.keyId === keyId && item.scopes.includes(scope),
  )
  if (credentials.length === 0) {
    return { error: Response.json({ message: 'کلید سرویس معتبر نیست.', ok: false }, { status: 401 }), ok: false }
  }

  const matched = credentials.find(
    (item) => verifyBillingSignature({ body, secret: item.secret, signature, timestamp }).ok,
  )
  const verdict = verifyBillingSignature({
    body,
    secret: credentials[0]!.secret,
    signature,
    timestamp,
  })
  if (!matched) {
    const reason = verdict.ok ? 'mismatch' : verdict.reason
    const message = reason === 'expired' ? 'مهلت امضا گذشته است.' : 'امضا پذیرفته نشد.'
    return { error: Response.json({ message, ok: false, reason }, { status: 401 }), ok: false }
  }

  const fingerprint = `${keyId}:${bodyFingerprint(timestamp, body)}`
  try {
    await req.payload.create({
      collection: 'billing-replay-nonces',
      data: { bodyHash: fingerprint, keyId, seenAt: new Date().toISOString() },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch {
    return {
      error: Response.json({ message: 'این درخواست قبلاً دیده شده است.', ok: false, reason: 'replay' }, { status: 401 }),
      ok: false,
    }
  }

  let parsed: unknown = null
  if (body) {
    try {
      parsed = JSON.parse(body)
    } catch {
      return { error: Response.json({ message: 'بدنه باید JSON باشد.', ok: false }, { status: 400 }), ok: false }
    }
  }
  return { call: { body, keyId, parsed }, ok: true }
}
