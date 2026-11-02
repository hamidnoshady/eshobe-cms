/**
 * Turning a rejected media upload into a message a customer can act on.
 *
 * `TenantMediaUploadField` used to collapse every failure into "check the type and
 * size". The API already knows better: `sanitizeSvgUpload` returns a structured,
 * validator-generated reason, Payload reports MIME/quota/access failures and the
 * status separates storage faults from a bad file. This module reads only those
 * safe fields and maps them to localized copy. Raw response bodies, HTML, stack
 * traces and secrets are never rendered — React text escapes the rest.
 */

import { SVG_ERROR_CODES } from '@/lib/svgLimits'

export type UploadErrorKind =
  | 'auth'
  | 'file-size'
  | 'mime'
  | 'network'
  | 'quota'
  | 'storage'
  | 'svg-feature'
  | 'svg-invalid'
  | 'svg-size'
  | 'unexpected'
  | 'validation'

export type UploadErrorInfo = {
  code?: string
  feature?: string
  kind: UploadErrorKind
  message?: string
  reason?: string
  status?: number
}

const copy = (isPersian: boolean, fa: string, en: string): string => (isPersian ? fa : en)

const SVG_CODES = new Set<string>(SVG_ERROR_CODES)
const SVG_FEATURE_CODES = new Set([
  'svg-invalid-element',
  'svg-invalid-attribute',
  'svg-invalid-value',
  'svg-invalid-reference',
  'svg-invalid-css',
  'svg-invalid-structure',
  'svg-too-complex',
])
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/
const SAFE_CODE = /^[a-z0-9-]{1,64}$/
const MIME_RE =
  /invalid file type|file type .*not allowed|invalid mime type|mime type|content[- ]type|restricted file type|نوع فایل|فرمت فایل|پسوند/i
const SIZE_RE = /file too large|size .*limit|payload too large|بزرگ.*حد مجاز|حجم فایل/i
const QUOTA_RE = /quota|سهمیه|بستهٔ? اینترنت|طرح شما|plan limit/i

/** Plain text only: no markup, no control characters, bounded length. */
const safeText = (value: unknown, limit = 300): string => {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readErrorBody = async (response: Response): Promise<Record<string, unknown> | null> => {
  try {
    const text = await response.text()
    if (text.length > 32 * 1024) return null
    return record(JSON.parse(text))
  } catch {
    // A proxy HTML page, a truncated body or an empty response: the status is still
    // meaningful, and no part of this body is safe enough to quote.
    return null
  }
}

const errorMessages = (body: Record<string, unknown> | null): string => {
  const entries = Array.isArray(body?.errors) ? body.errors : []
  const messages = entries
    .map((entry) => (typeof entry === 'string' ? entry : record(entry)?.message))
    .filter((message): message is string => typeof message === 'string')
  if (typeof body?.message === 'string') messages.push(body.message)
  return messages.map((message) => safeText(message, 240)).filter(Boolean).join(' ').slice(0, 300)
}

const svgReason = (info: UploadErrorInfo, isPersian: boolean): string => {
  const reason = safeText(info.reason, 240)
  if (isPersian) {
    return reason || copy(true, 'ویژگی بهکاررفته در فایل SVG مجاز نیست.', '')
  }

  const feature = info.feature && SAFE_TOKEN.test(info.feature) ? info.feature : ''
  const name = feature ? `«${feature}»` : 'it'
  switch (info.code) {
    case 'svg-invalid-element':
      return `The SVG element ${name} is not allowed.`
    case 'svg-invalid-attribute':
      return `The SVG attribute ${name} is not allowed.`
    case 'svg-invalid-value':
      return `The value of ${name} is not allowed.`
    case 'svg-invalid-reference':
      return feature
        ? `The SVG reference «#${feature}» does not point at an allowed element in this file.`
        : 'An SVG reference does not point at an allowed element in this file.'
    case 'svg-invalid-css':
      return 'The SVG stylesheet contains a rule or value that is not allowed.'
    case 'svg-invalid-structure':
      return 'The SVG filter graph has a structure that is not allowed.'
    case 'svg-too-complex':
      return 'The SVG filter graph is too complex.'
    default:
      return 'The file contains an SVG feature that is not allowed.'
  }
}

export const networkUploadError = (): UploadErrorInfo => ({ kind: 'network' })
export const unexpectedUploadError = (): UploadErrorInfo => ({ kind: 'unexpected' })

/** Read a rejected `POST /api/media` response without trusting its body wholesale. */
export const parseUploadError = async (response: Response): Promise<UploadErrorInfo> => {
  const status = response.status
  const body = await readErrorBody(response)
  const first: Record<string, unknown> = Array.isArray(body?.errors)
    ? (body.errors.map((entry) => record(entry)).find(Boolean) ?? {})
    : {}
  const data = record(first.data) ?? record(body?.data) ?? {}
  const message = errorMessages(body)
  const codeValue = typeof data.code === 'string' && SAFE_CODE.test(data.code) ? data.code : ''
  const feature =
    typeof data.feature === 'string' && SAFE_TOKEN.test(data.feature) ? data.feature : ''
  const reason = safeText(data.reason, 240)

  // Only our own validator's structured data gets to name the rejected feature.
  if (data.validator === 'svg' && SVG_CODES.has(codeValue)) {
    if (codeValue === 'svg-too-large') {
      return { code: codeValue, feature, kind: 'svg-size', reason, status }
    }
    return {
      code: codeValue,
      feature,
      kind: SVG_FEATURE_CODES.has(codeValue) ? 'svg-feature' : 'svg-invalid',
      reason,
      status,
    }
  }

  if (status === 402 || QUOTA_RE.test(message)) {
    return { kind: 'quota', message, status }
  }
  if (status === 401 || status === 403) return { kind: 'auth', message, status }
  if (status === 413 || SIZE_RE.test(message)) {
    return { kind: 'file-size', message, status }
  }
  if (status >= 500) return { kind: 'storage', message, status }
  if (MIME_RE.test(message)) return { kind: 'mime', message, status }
  if (status === 400 || status === 422) {
    return { kind: 'validation', message, status }
  }
  return { kind: 'unexpected', message, status }
}

const MESSAGES: Record<UploadErrorKind, [string, string]> = {
  'svg-feature': [
    'فایل SVG پذیرفته نشد:',
    'SVG upload rejected:',
  ],
  'svg-invalid': [
    'فایل SVG پذیرفته نشد:',
    'The SVG file could not be accepted:',
  ],
  'svg-size': [
    'فایل SVG بزرگتر از ۲۰۰ کیلوبایت است. فایل کوچکتری انتخاب کنید.',
    'The SVG is larger than 200 KB. Choose a smaller file.',
  ],
  'file-size': [
    'اندازهٔ فایل بیشتر از حد مجاز است. فایل کوچکتری انتخاب کنید.',
    'The file is larger than the allowed limit. Choose a smaller file.',
  ],
  mime: [
    'نوع فایل پشتیبانی نمیشود. فقط JPEG، PNG، WebP، GIF، AVIF یا SVG امن مجاز است.',
    'Unsupported file type. Use JPEG, PNG, WebP, GIF, AVIF or a safe SVG.',
  ],
  quota: [
    'سهمیهٔ رسانهٔ این سایت تکمیل شده است. برای افزایش سهمیه با پشتیبانی تماس بگیرید.',
    'This site has reached its media quota. Contact support to increase it.',
  ],
  auth: [
    'دسترسی لازم برای بارگذاری ندارید. دوباره وارد شوید یا از مدیر سایت بخواهید دسترسی بدهد.',
    'You do not have permission to upload. Sign in again or ask a site admin for access.',
  ],
  storage: [
    'فایل روی سرور ذخیره نشد. کمی بعد دوباره تلاش کنید؛ اگر ادامه داشت به پشتیبانی اطلاع دهید.',
    'The file could not be stored on the server. Try again shortly, then contact support.',
  ],
  network: [
    'ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید و دوباره تلاش کنید.',
    'Could not reach the server. Check your connection and try again.',
  ],
  unexpected: [
    'خطای پیشبینینشدهای در بارگذاری رخ داد. دوباره تلاش کنید.',
    'An unexpected server error occurred while uploading. Please try again.',
  ],
  validation: [
    'فایل پذیرفته نشد: اطلاعات ارسالی معتبر نیست. فایل و فیلدهای همراه آن را بررسی کنید.',
    'The file was rejected: the submitted data is invalid. Check the file and its fields.',
  ],
}

/** Localized, filename-scoped copy. The filename is isolated to resist bidi spoofing. */
export const uploadErrorMessage = (
  info: UploadErrorInfo,
  filename: string,
  isPersian: boolean,
): string => {
  const [fa, en] = MESSAGES[info.kind]
  let message = copy(isPersian, fa, en)

  if (info.kind === 'svg-feature' || info.kind === 'svg-invalid') {
    message = `${message} ${svgReason(info, isPersian)}`
  }
  // Other validation messages are deliberately not quoted: a Payload field error
  // can contain paths, stack lines or server internals. Only the category and the
  // filename reach the user; the structured SVG validator reason is the exception.

  const label = safeText(filename, 80)
  if (!label) return message
  const isolated = `\u2068${label}\u2069`
  return `${message} ${copy(isPersian, `(${isolated})`, `[${isolated}]`)}`
}
