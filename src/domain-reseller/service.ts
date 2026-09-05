import type { Payload, PayloadRequest } from 'payload'

import { DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY } from '@/globals/hooks/domainResellerSecrets'
import { decryptDomainResellerSecret } from '@/domain-reseller/crypto'
import { isCurrencyCode, type CurrencyCode } from '@/lib/money'

export type RegistrarOperation = 'register' | 'transfer' | 'renew'

export type ResellerProduct = {
  currency: CurrencyCode
  enabled: boolean
  registrationCost: number
  renewalCost: number
  tld: string
  transferCost: number
}

export type ResellerQuote = {
  catalogueCost: number
  currency: CurrencyCode
  marginPercentage: number
  operation: RegistrarOperation
  period: number
  price: number
  tld: string
}

type ProviderError = { code?: unknown; message?: unknown }
type ProviderResponse = {
  error?: ProviderError
  errors?: ProviderError[]
  result?: unknown
  success?: unknown
}

type StoredResellerSettings = {
  apiEndpoint?: unknown
  credentials?: { apiKey?: unknown }
  enabled?: unknown
  margins?: {
    registrationPercent?: unknown
    renewalPercent?: unknown
    transferPercent?: unknown
  }
}

export type ResellerConfiguration = {
  apiEndpoint: string
  apiKey: string
}

export class DomainResellerConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainResellerConfigurationError'
  }
}

export class DomainResellerProviderError extends Error {
  readonly code?: number | string
  readonly status: number

  constructor(message: string, options: { code?: number | string; status?: number } = {}) {
    super(message)
    this.name = 'DomainResellerProviderError'
    this.code = options.code
    this.status = options.status ?? 502
  }
}

const validApiEndpoint = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    const url = new URL(value)
    const providerHost =
      url.hostname === 'resellerarea.net' ||
      url.hostname.endsWith('.resellerarea.net') ||
      url.hostname === 'irpower.com' ||
      url.hostname.endsWith('.irpower.com')
    return url.protocol === 'https:' && providerHost ? url.toString() : null
  } catch {
    return null
  }
}

const percentage = (value: unknown): number => {
  const valueAsNumber = Number(value)
  return Number.isFinite(valueAsNumber) && valueAsNumber >= 0 && valueAsNumber <= 1000
    ? valueAsNumber
    : 0
}

export const marginFor = (
  settings: StoredResellerSettings,
  operation: RegistrarOperation,
): number => {
  const margins = settings.margins ?? {}
  return percentage(
    operation === 'register'
      ? margins.registrationPercent
      : operation === 'transfer'
        ? margins.transferPercent
        : margins.renewalPercent,
  )
}

const costFor = (product: ResellerProduct, operation: RegistrarOperation): number =>
  operation === 'register'
    ? product.registrationCost
    : operation === 'transfer'
      ? product.transferCost
      : product.renewalCost

/** Pure because quotes must be snapshot-tested independently of whatever price a staff
 * member enters tomorrow. Cents / Toman are integers; rounding up keeps a fractional
 * percentage from silently undercharging by one minor unit. */
export const quoteFor = ({
  marginPercentage,
  operation,
  period,
  product,
}: {
  marginPercentage: number
  operation: RegistrarOperation
  period: number
  product: ResellerProduct
}): ResellerQuote => {
  if (!Number.isInteger(period) || period < 1 || period > 5) {
    throw new DomainResellerConfigurationError('مدت دامنه باید عددی بین ۱ تا ۵ سال باشد.')
  }

  const annualCost = costFor(product, operation)
  if (!Number.isSafeInteger(annualCost) || annualCost < 0) {
    throw new DomainResellerConfigurationError('قیمت پایهٔ TLD نامعتبر است.')
  }

  const catalogueCost = annualCost * period
  if (!Number.isSafeInteger(catalogueCost)) {
    throw new DomainResellerConfigurationError('قیمت دامنه از محدودهٔ قابل‌محاسبه خارج است.')
  }

  const safeMargin = percentage(marginPercentage)
  const price = Math.ceil((catalogueCost * (100 + safeMargin)) / 100)
  if (!Number.isSafeInteger(price)) {
    throw new DomainResellerConfigurationError('قیمت نهایی دامنه از محدودهٔ قابل‌محاسبه خارج است.')
  }

  return {
    catalogueCost,
    currency: product.currency,
    marginPercentage: safeMargin,
    operation,
    period,
    price,
    tld: product.tld,
  }
}

/** Longest suffix wins: a `co.ir` catalogue row must take precedence over `ir`. */
export const productForDomain = <T extends ResellerProduct>(
  domain: string,
  products: T[],
): T | null => {
  const normalized = domain.toLowerCase().replace(/\.$/, '')
  const eligible = products
    .filter((product) => product.enabled && normalized.endsWith(`.${product.tld.toLowerCase()}`))
    .sort((a, b) => b.tld.length - a.tld.length)

  return eligible[0] ?? null
}

/** Reads global policy without its secret. This may be called from a tenant endpoint: it
 * returns only booleans/margins used to price its own request. */
export const resellerSettings = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<StoredResellerSettings> =>
  (await payload.findGlobal({
    slug: 'domain-reseller',
    depth: 0,
    overrideAccess: true,
    req,
  })) as StoredResellerSettings

/** Reads exactly one write-only value for the short lifetime of a server-side adapter call. */
export const resellerConfiguration = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<ResellerConfiguration> => {
  req.context[DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY] = true
  let settings: StoredResellerSettings
  try {
    settings = (await payload.findGlobal({
      slug: 'domain-reseller',
      depth: 0,
      overrideAccess: true,
      req,
    })) as StoredResellerSettings
  } finally {
    delete req.context[DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY]
  }

  if (settings.enabled !== true) {
    throw new DomainResellerConfigurationError('فروش و مدیریت API دامنه توسط پلتفرم فعال نشده است.')
  }

  const apiEndpoint = validApiEndpoint(settings.apiEndpoint)
  const apiKey = decryptDomainResellerSecret(
    typeof settings.credentials?.apiKey === 'string' ? settings.credentials.apiKey : undefined,
  )

  if (!apiEndpoint || !apiKey) {
    throw new DomainResellerConfigurationError(
      'نشانی یا کلید API نمایندگی دامنه پیکربندی نشده است.',
    )
  }

  return { apiEndpoint, apiKey }
}

const timeoutMs = (): number => {
  const configured = Number(process.env.DOMAIN_RESELLER_TIMEOUT_MS ?? 10_000)
  return Number.isFinite(configured) && configured >= 1000 && configured <= 60_000
    ? configured
    : 10_000
}

const providerMessage = (
  response: ProviderResponse,
): { code?: number | string; message: string } => {
  const error = response.errors?.[0] ?? response.error
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  const code =
    typeof error?.code === 'number' || typeof error?.code === 'string' ? error.code : undefined
  return { code, message: message || 'Registrar درخواست را نپذیرفت.' }
}

/**
 * The only network boundary for IRPower/ResellerArea. It deliberately logs no request
 * payload: transfer codes and contacts must never turn up in application logs. Every
 * command is POST JSON with an x-api-key, as specified by the supplied API document.
 */
export const callResellerArea = async (
  configuration: ResellerConfiguration,
  command: string,
  parameters: Record<string, unknown>,
): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())

  let response: Response
  try {
    response = await fetch(configuration.apiEndpoint, {
      body: JSON.stringify({ command, ...parameters }),
      headers: { 'content-type': 'application/json', 'x-api-key': configuration.apiKey },
      method: 'POST',
      // A redirect can cross origins; never allow an API key-bearing request to be replayed
      // at a location the platform configuration did not authorize.
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    throw new DomainResellerProviderError('ارتباط با registrar برقرار نشد.')
  } finally {
    clearTimeout(timer)
  }

  let payload: ProviderResponse
  try {
    payload = (await response.json()) as ProviderResponse
  } catch {
    throw new DomainResellerProviderError('registrar پاسخ JSON معتبر نداد.', {
      status: response.status,
    })
  }

  if (!response.ok || (payload.success !== true && payload.success !== 'true')) {
    const detail = providerMessage(payload)
    throw new DomainResellerProviderError(detail.message, {
      code: detail.code,
      status: response.status,
    })
  }

  return payload.result
}

export const operationFrom = (value: unknown): RegistrarOperation | null =>
  value === 'register' || value === 'transfer' || value === 'renew' ? value : null

export const currencyFrom = (value: unknown): CurrencyCode | null =>
  isCurrencyCode(value) ? value : null
