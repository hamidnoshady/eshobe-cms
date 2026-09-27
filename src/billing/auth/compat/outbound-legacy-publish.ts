import type { PayloadRequest } from 'payload'

import {
  LEGACY_KEY_HEADER,
  LEGACY_NONCE_HEADER,
  LEGACY_SIGNATURE_HEADER,
  LEGACY_TIMESTAMP_HEADER,
  mintLegacyNonce,
  signLegacyUsageBody,
} from '@/billing/auth/compat/legacy-nonce-body-hash'
import type { ActiveCredential } from '@/billing/auth/credentials'
import { CONTRACT_VERSION, USAGE_SOURCE, type UsageEventV1 } from '@/billing/contract/v1'
import { centralBillingUrl, usageIngestUrl } from '@/billing/client/url'
import { MAX_ACK_CHARS, parseBatchAck, type EventResult } from '@/billing/client/interpret'

const TIMEOUT_MS = 10_000

export type LegacyPublishBatchResult =
  | { error: string; ok: false; transient: true }
  | { ok: true; results: EventResult[] }

/**
 * Temporary outbound path for a central Billing receiver that still verifies
 * the nonce/body-hash protocol. Enable with `BILLING_USAGE_AUTH=legacy-nonce`.
 */
export const postUsageBatchLegacy = async (
  req: PayloadRequest,
  events: UsageEventV1[],
  credential: ActiveCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<LegacyPublishBatchResult> => {
  let origin: URL | null
  try {
    origin = centralBillingUrl()
  } catch (error) {
    return { error: (error as Error).message, ok: false, transient: true }
  }
  if (!origin) return { error: 'CENTRAL_BILLING_URL is not configured', ok: false, transient: true }
  if (events.length === 0) return { ok: true, results: [] }

  const body = JSON.stringify({ contractVersion: CONTRACT_VERSION, events, source: USAGE_SOURCE })
  const timestampMs = String(Date.now())
  const nonce = mintLegacyNonce()
  const signature = signLegacyUsageBody({ body, nonce, secret: credential.secret, timestampMs })

  let response: Response
  try {
    response = await fetchImpl(usageIngestUrl(origin), {
      body,
      headers: {
        'content-type': 'application/json',
        [LEGACY_KEY_HEADER]: credential.keyId,
        [LEGACY_NONCE_HEADER]: nonce,
        [LEGACY_SIGNATURE_HEADER]: signature,
        [LEGACY_TIMESTAMP_HEADER]: timestampMs,
      },
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    return { error: (error as Error).message || 'billing ingest failed', ok: false, transient: true }
  }

  if (response.status === 429 || response.status >= 500) {
    return { error: `billing ingest HTTP ${response.status}`, ok: false, transient: true }
  }

  const text = await response.text()
  if (text.length > MAX_ACK_CHARS) return { error: 'billing ack exceeded size cap', ok: false, transient: true }
  if (!response.ok) {
    return { error: `billing ingest HTTP ${response.status}`, ok: false, transient: true }
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { error: 'billing ack was not JSON', ok: false, transient: true }
  }
  const parsed = parseBatchAck(json)
  if ('error' in parsed) return { error: parsed.error, ok: false, transient: true }
  return { ok: true, results: parsed.results }
}
