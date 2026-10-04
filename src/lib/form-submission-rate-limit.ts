import { APIError, type PayloadRequest } from 'payload'

import { clientKey, consume } from '@/lib/rate-limit'
import { PUBLIC_FORM_HONEYPOT_FIELD } from '@/lib/public-form-fields'

export const DEFAULT_FORM_SUBMISSION_LIMIT = 5
export const DEFAULT_FORM_SUBMISSION_WINDOW_MS = 10 * 60_000

const positiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

type DataRecord = Record<string, unknown>
type ChallengeContext = { data: DataRecord; req: PayloadRequest; siteID: null | string }
type ChallengeVerifier = (context: ChallengeContext) => boolean | Promise<boolean>

const isRecord = (value: unknown): value is DataRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Remove the invisible form trap before a clean submission is stored. */
export const stripPublicFormHoneypot = (
  value: unknown,
): { data: unknown; filled: boolean } => {
  if (!isRecord(value) || !Array.isArray(value.submissionData)) return { data: value, filled: false }

  let filled = false
  const submissionData = value.submissionData.filter((entry) => {
    if (!isRecord(entry) || entry.field !== PUBLIC_FORM_HONEYPOT_FIELD) return true
    const trapValue = entry.value
    filled = filled || (typeof trapValue === 'string' ? trapValue.trim().length > 0 : Boolean(trapValue))
    return false
  })

  return { data: { ...value, submissionData }, filled }
}

/**
 * Optional CAPTCHA/challenge extension point. Projects can provide
 * `payload.config.custom.verifyPublicFormSubmission` without changing this plugin
 * hook; missing, throwing, or rejecting verifiers fail closed when configured.
 */
export const verifyPublicFormChallenge = async ({ data, req, siteID }: ChallengeContext): Promise<boolean> => {
  const custom = (req.payload.config as unknown as {
    custom?: { verifyPublicFormSubmission?: ChallengeVerifier }
  }).custom
  const verifier = custom?.verifyPublicFormSubmission
  if (typeof verifier !== 'function') return true

  try {
    return (await verifier({ data, req, siteID })) === true
  } catch {
    return false
  }
}

/**
 * Throttle anonymous public form submissions before they reach database/email hooks.
 * The bucket is per resolved site and client, so unrelated tenants do not share a
 * quota and rotating form IDs on one tenant does not multiply it. This limiter is
 * process-local by design; see `src/lib/rate-limit.ts` before scaling beyond one app
 * process.
 */
export const enforcePublicFormSubmissionRateLimit = (
  req: PayloadRequest,
  siteID: null | string,
  {
    limit = positiveInteger(process.env.FORM_SUBMISSION_RATE_LIMIT, DEFAULT_FORM_SUBMISSION_LIMIT),
    windowMs = positiveInteger(process.env.FORM_SUBMISSION_RATE_LIMIT_WINDOW_MS, DEFAULT_FORM_SUBMISSION_WINDOW_MS),
  }: { limit?: number; windowMs?: number } = {},
): void => {
  if (req.payloadAPI === 'local' || req.user) return
  if (req.method && req.method.toUpperCase() !== 'POST') return

  const result = consume({
    key: `form-submission:${siteID ?? 'unresolved'}:${clientKey(req.headers)}`,
    limit,
    windowMs,
  })

  if (result.allowed) return

  const responseHeaders = req.responseHeaders ?? new Headers()
  responseHeaders.set('cache-control', 'no-store')
  responseHeaders.set('retry-after', String(result.retryAfterSeconds))
  req.responseHeaders = responseHeaders

  throw new APIError(
    'Too many form submissions. Please wait and try again.',
    429,
    { retryAfterSeconds: result.retryAfterSeconds },
    true,
  )
}

/** Generic response shared by trap and optional challenge refusals. */
export const rejectPublicFormSubmission = (): never => {
  throw new APIError('Submission was rejected.', 400, undefined, true)
}
