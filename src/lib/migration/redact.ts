/**
 * What may be stored/logged from a source record (issue #166 hard gate:
 * "credentials and PII never logged").
 *
 * A Woo order payload is both the import input *and* a bundle of secrets
 * someone else configured years ago — gateway tokens in meta, application
 * passwords, card fingerprints. Anything persisted to the migration ledger
 * or surfaced in an event/error passes through here first: secret-shaped
 * keys lose their values at any depth, and oversized values are truncated
 * so a pathological postmeta blob cannot bloat a ledger row. Billing names
 * and addresses stay — they are the business data being migrated, stored on
 * staff-only rows — but they never reach event messages, which are written
 * by the engine in plain language with counts and ids only.
 */

const SECRET_KEY =
  /(^|[_-])(password|passwd|pwd|secret|token|auth|authorization|api[_-]?key|consumer[_-]?(key|secret)|private[_-]?key|card|iban|vault|cvc|cvv)($|[_-])/i

const MAX_STRING = 20_000
const MAX_ITEMS = 500

export const isSecretShapedKey = (key: string): boolean => SECRET_KEY.test(key)

export const redactRawPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redactRawPayload(item))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretShapedKey(key) ? '[redacted]' : redactRawPayload(entry)
    }

    return out
  }
  if (typeof value === 'string' && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING)}…[truncated]`
  }

  return value
}

/** A one-line, secret-free rendering of a caught error, capped for a DB column. */
export const safeErrorMessage = (error: unknown, secrets: (null | string | undefined)[] = []): string => {
  let message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'خطای نامشخص در اجرای مهاجرت.'

  for (const secret of secrets) {
    if (secret && secret.length >= 4) message = message.split(secret).join('[redacted]')
  }

  // Belt and braces: Basic-auth blobs and credential query params.
  message = message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]')
    .replace(/(consumer_(key|secret)|password|token)=[^&\s]+/gi, '$1=[redacted]')

  return message.slice(0, 2_000)
}
