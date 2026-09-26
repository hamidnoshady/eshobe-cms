import type { PayloadRequest } from 'payload'

import { CONTRACT_VERSION, USAGE_SOURCE, type UsageEventV1 } from '@/billing/contract/v1'
import { credentialForScope } from '@/billing/auth/credentials'
import { signBillingBody, BILLING_KEY_HEADER, BILLING_SIGNATURE_HEADER, BILLING_TIMESTAMP_HEADER } from '@/billing/auth/sign'
import { MAX_ACK_CHARS, parseBatchAck, type EventResult } from '@/billing/client/interpret'
import { centralBillingUrl, usageIngestUrl } from '@/billing/client/url'

const TIMEOUT_MS = 10_000

export type PublishBatchResult =
  | { error: string; ok: false; transient: true }
  | { ok: true; results: EventResult[] }

/**
 * POST one batch. Network failures, timeouts and unreadable bodies are
 * transient. The caller decides sent vs retry from `results`, and never marks
 * an event sent just because the socket opened.
 */
export const postUsageBatch = async (
  req: PayloadRequest,
  events: UsageEventV1[],
  fetchImpl: typeof fetch = fetch,
): Promise<PublishBatchResult> => {
  let origin: URL | null
  try {
    origin = centralBillingUrl()
  } catch (error) {
    return { error: (error as Error).message, ok: false, transient: true }
  }
  if (!origin) return { error: 'CENTRAL_BILLING_URL is not configured', ok: false, transient: true }
  if (events.length === 0) return { ok: true, results: [] }

  const credential = await credentialForScope(req, 'billing.usage.write')
  if (!credential) return { error: 'no active billing.usage.write credential', ok: false, transient: true }

  const body = JSON.stringify({ contractVersion: CONTRACT_VERSION, events, source: USAGE_SOURCE })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signBillingBody(credential.secret, timestamp, body)

  let response: Response
  try {
    response = await fetchImpl(usageIngestUrl(origin), {
      body,
      headers: {
        'content-type': 'application/json',
        [BILLING_KEY_HEADER]: credential.keyId,
        [BILLING_SIGNATURE_HEADER]: signature,
        [BILLING_TIMESTAMP_HEADER]: timestamp,
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
