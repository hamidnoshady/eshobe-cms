import type { Endpoint, PayloadRequest } from 'payload'

import type { ResellerDomainEvent, Site } from '@/payload-types'

import { isValidDomain, normalizeDomain } from '@/lib/domains'
import { idOf, isUuid } from '@/lib/ids'
import {
  availabilityFromProviderError,
  callResellerArea,
  currencyFrom,
  type DomainAvailability,
  DomainResellerConfigurationError,
  DomainResellerProviderError,
  marginFor,
  operationFrom,
  operationsForAvailability,
  productForDomain,
  quoteFor,
  resellerConfiguration,
  resellerSettings,
  type RegistrarOperation,
  type ResellerProduct,
  whoisIndicatesRegistered,
} from '@/domain-reseller/service'

import { clientKey, consume } from '@/lib/rate-limit'
import { requestApiKey } from '@/access/siteApiKey'

import { siteForDomainKey } from './updateSiteDomain'

const noStore = { 'cache-control': 'no-store' }
const json = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

type ManagedDomain = {
  contacts?: unknown
  customFields?: unknown
  domain?: unknown
  id: string
  irnicHandles?: unknown
  nameservers?: Array<{ hostname?: unknown }> | null
  site?: unknown
  state?: unknown
  tld?: unknown
}

type ProductDocument = ResellerProduct & { id: string }
type EventOperation = ResellerDomainEvent['operation']
type OperationInput = {
  contact?: unknown
  domain?: unknown
  eppCode?: unknown
  fields?: unknown
  irnicHandles?: unknown
  nameservers?: unknown
  operation?: unknown
  period?: unknown
}

const siteKeyRequired = async (req: PayloadRequest): Promise<Response | Site> => {
  const site = await siteForDomainKey(req)
  return site
    ? site
    : json({ message: 'این عملیات فقط با کلید API همان سایت ممکن است.', ok: false }, 403)
}

const requestBody = async <T extends Record<string, unknown>>(
  req: PayloadRequest,
): Promise<T | Response> => {
  try {
    const value = await req.json?.()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return json({ message: 'بدنهٔ درخواست باید یک شیء JSON باشد.', ok: false }, 400)
    }
    return value as T
  } catch {
    return json({ message: 'بدنهٔ درخواست باید JSON معتبر باشد.', ok: false }, 400)
  }
}

const validPeriod = (value: unknown): number | null => {
  const period = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(period) && period >= 1 && period <= 5 ? period : null
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const nameserversFrom = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null

  const nameservers = value.map((entry) =>
    typeof entry === 'string' ? normalizeDomain(entry) : '',
  )
  return nameservers.every((hostname) => isValidDomain(hostname)) &&
    new Set(nameservers).size === nameservers.length
    ? nameservers
    : null
}

const nameserversStored = (domain: ManagedDomain): string[] =>
  (domain.nameservers ?? [])
    .map((row) => (typeof row?.hostname === 'string' ? normalizeDomain(row.hostname) : ''))
    .filter(Boolean)

const nameserverObject = (nameservers: string[]): Record<string, string> =>
  Object.fromEntries(nameservers.map((hostname, index) => [`ns${index + 1}`, hostname]))

const productFor = async (req: PayloadRequest, domain: string): Promise<ProductDocument | null> => {
  const { docs } = await req.payload.find({
    collection: 'domain-reseller-products',
    depth: 0,
    limit: 1000,
    pagination: false,
    overrideAccess: true,
    req,
  })

  const products = docs
    .map((product) => ({
      currency: currencyFrom(product.currency),
      enabled: product.enabled === true,
      id: String(product.id),
      registrationCost: Number(product.registrationCost),
      renewalCost: Number(product.renewalCost),
      tld: String(product.tld ?? ''),
      transferCost: Number(product.transferCost),
    }))
    .filter(
      (product): product is ProductDocument =>
        product.currency !== null &&
        product.tld.length > 0 &&
        Number.isSafeInteger(product.registrationCost) &&
        Number.isSafeInteger(product.transferCost) &&
        Number.isSafeInteger(product.renewalCost),
    )

  return productForDomain(domain, products)
}

const existingDomain = async (
  req: PayloadRequest,
  domain: string,
): Promise<ManagedDomain | null> => {
  const { docs } = await req.payload.find({
    collection: 'reseller-domains',
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
    req,
    where: { domain: { equals: domain } },
  })

  return (docs[0] as ManagedDomain | undefined) ?? null
}

const domainForSite = async (
  req: PayloadRequest,
  siteId: string,
  id: unknown,
): Promise<ManagedDomain | null> => {
  if (!isUuid(id)) return null
  const domain = (await req.payload.findByID({
    id,
    collection: 'reseller-domains',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as ManagedDomain | null

  return domain && idOf(domain.site) === siteId ? domain : null
}

const safeProviderFailure = (error: unknown): string => {
  if (error instanceof DomainResellerProviderError && error.code !== undefined) {
    return `Registrar درخواست را نپذیرفت (کد ${String(error.code).slice(0, 40)}).`
  }
  return 'ارسال به registrar ناموفق بود؛ تنظیمات و وضعیت درخواست را بررسی کنید.'
}

const audit = async (
  req: PayloadRequest,
  siteId: string,
  domainId: string,
  operation: EventOperation,
  ok: boolean,
  summary: string,
): Promise<void> => {
  try {
    await req.payload.create({
      collection: 'reseller-domain-events',
      data: { domain: domainId, ok, operation, site: siteId, summary: summary.slice(0, 1000) },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    req.payload.logger.error({
      err: error as Error,
      msg: `could not audit registrar event ${operation}`,
    })
  }
}

/**
 * WHOIS probes per caller per window.
 *
 * A search box sends one provider request per keystroke-ish action, and the provider
 * account is the platform's — an unthrottled `?domain=` parameter would let one tenant
 * spend the platform's registrar quota. Env-tunable for the same reason the checkout
 * limit is: the honest number for a builder wizard and for a bulk-search script differ.
 */
const searchRateLimit = () => ({
  limit: Number(process.env.DOMAIN_SEARCH_RATE_LIMIT ?? 30),
  windowMs: Number(process.env.DOMAIN_SEARCH_RATE_LIMIT_WINDOW_MS ?? 60_000),
})

const availabilityMessages: Record<DomainAvailability, string> = {
  available: 'این دامنه آزاد است و می‌توانید آن را ثبت کنید.',
  managedHere: 'این دامنه از قبل برای همین سایت در پلتفرم مدیریت می‌شود؛ امکان تمدید دارید.',
  registered: 'این دامنه قبلاً ثبت شده است؛ در صورت مالکیت می‌توانید آن را منتقل کنید.',
  reservedInPlatform: 'این دامنه در یک workflow دیگر پلتفرم رزرو یا مدیریت شده است.',
  unknown:
    'وضعیت آزادبودن دامنه قطعی نشد؛ می‌توانید درخواست ثبت یا انتقال بدهید و registrar وضعیت واقعی را می‌سنجد.',
}

type AvailabilityAnswer = {
  availability: DomainAvailability
  availabilityMessage: string
  checkedWithRegistrar: boolean
  managedState: null | string
}

/**
 * The one place that answers "is this name free?".
 *
 * Local knowledge wins because it is certain and free: a row in `reseller-domains`
 * means this platform is already mid-workflow on the name, and no WHOIS answer can
 * override that without leaking which tenant holds it. Only an unknown name reaches
 * the registrar, and only through `GetDomainWhoisInfo` — the sole documented command
 * that observes a third-party domain. A provider failure is never sold as "available":
 * see `availabilityFromProviderError`.
 */
const availabilityFor = async (
  req: PayloadRequest,
  domain: string,
  siteId: null | string,
  { probeRegistrar }: { probeRegistrar: boolean },
): Promise<AvailabilityAnswer> => {
  const existing = await existingDomain(req, domain)
  if (existing) {
    const managedHere = Boolean(siteId) && idOf(existing.site) === siteId
    const availability: DomainAvailability = managedHere ? 'managedHere' : 'reservedInPlatform'
    return {
      availability,
      availabilityMessage: availabilityMessages[availability],
      checkedWithRegistrar: false,
      // A foreign row's state is not this caller's business; only its own is returned.
      managedState: managedHere ? ((existing.state as null | string) ?? null) : null,
    }
  }

  if (!probeRegistrar) {
    return {
      availability: 'unknown',
      availabilityMessage: availabilityMessages.unknown,
      checkedWithRegistrar: false,
      managedState: null,
    }
  }

  let configuration
  try {
    configuration = await resellerConfiguration(req.payload, req)
  } catch {
    return {
      availability: 'unknown',
      availabilityMessage: availabilityMessages.unknown,
      checkedWithRegistrar: false,
      managedState: null,
    }
  }

  try {
    const result = await callResellerArea(configuration, 'GetDomainWhoisInfo', { domain })
    const availability: DomainAvailability = whoisIndicatesRegistered(result)
      ? 'registered'
      : 'unknown'
    return {
      availability,
      availabilityMessage: availabilityMessages[availability],
      checkedWithRegistrar: true,
      managedState: null,
    }
  } catch (error) {
    const availability = availabilityFromProviderError(error)
    return {
      availability,
      availabilityMessage: availabilityMessages[availability],
      checkedWithRegistrar: true,
      managedState: null,
    }
  }
}

/** Prices every operation the answer permits, so the UI never has to re-ask per button. */
const quotesFor = ({
  operations,
  period,
  product,
  settings,
}: {
  operations: RegistrarOperation[]
  period: number
  product: ResellerProduct
  settings: Awaited<ReturnType<typeof resellerSettings>>
}) =>
  Object.fromEntries(
    operations.map((operation) => [
      operation,
      quoteFor({
        marginPercentage: marginFor(settings, operation),
        operation,
        period,
        product,
      }),
    ]),
  )

const publicDomain = (domain: ManagedDomain) => ({
  domain: domain.domain,
  id: domain.id,
  nameservers: nameserversStored(domain),
  state: domain.state,
  tld: domain.tld,
})

const publicOperation = (operation: {
  catalogueCost?: unknown
  currency?: unknown
  id: unknown
  marginPercentage?: unknown
  operation?: unknown
  paymentState?: unknown
  period?: unknown
  providerRespondedAt?: unknown
  providerSubmittedAt?: unknown
  quoteAmount?: unknown
  safeDetail?: unknown
  status?: unknown
}) => ({
  catalogueCost: operation.catalogueCost,
  currency: operation.currency,
  id: operation.id,
  marginPercentage: operation.marginPercentage,
  operation: operation.operation,
  paymentState: operation.paymentState,
  period: operation.period,
  providerRespondedAt: operation.providerRespondedAt,
  providerSubmittedAt: operation.providerSubmittedAt,
  quoteAmount: operation.quoteAmount,
  safeDetail: operation.safeDetail,
  status: operation.status,
})

/**
 * GET /api/site/registrar/quote?domain=example.ir&operation=register&period=1
 *
 * ResellerArea's published contract has no availability, price catalogue or order-status
 * command. The answer therefore distinguishes this platform's own reservation from the
 * honest `unknown` provider state; it never claims a domain is globally available merely
 * because it is absent from this CMS. Price comes from the superadmin's manual TLD catalog.
 */
/**
 * GET /api/site/registrar/quote
 *
 * A price, and nothing else: no order is placed, no row is written, and the answer
 * is the same for every caller because it is the platform's own catalogue price
 * plus the platform's own margin. That is why a **platform** key is accepted here
 * alongside a site key, and only here: the builder prices a domain at the first
 * step of its site-building wizard, before the site — and therefore its site key —
 * exists at all. Refusing that call would push the same question into a screen
 * that has to guess a number, which is the one outcome worse than answering it.
 *
 * A platform key gets the *coarser* availability answer on purpose: `managedHere`
 * means "this site already manages this domain", and with no site in the request
 * there is no such thing to say. Ordering (`POST /api/site/registrar/domains`)
 * remains site-key only, so nothing that commits a business is widened by this.
 */
export const domainResellerQuote: Endpoint['handler'] = async (req) => {
  const key = await requestApiKey(req)
  const site = key?.role === 'platform' ? null : await siteKeyRequired(req)
  if (site instanceof Response) return site

  const domain = typeof req.query.domain === 'string' ? normalizeDomain(req.query.domain) : ''
  const operation = operationFrom(req.query.operation)
  const period = validPeriod(req.query.period ?? 1)
  if (!domain || !isValidDomain(domain) || !operation || !period) {
    return json({ message: 'دامنه، عملیات و مدت درخواست نامعتبر است.', ok: false }, 400)
  }

  const product = await productFor(req, domain)
  if (!product) {
    return json(
      {
        message: 'این پسوند در کاتالوگ فعال پلتفرم نیست. برای قیمت‌گذاری با پشتیبانی تماس بگیرید.',
        ok: false,
      },
      404,
    )
  }

  const settings = await resellerSettings(req.payload, req)
  // A quote is a price question, so it stays free of provider traffic: availability here
  // is the local answer only. `GET …/search` is the route that spends a registrar call.
  const answer = await availabilityFor(req, domain, site ? String(site.id) : null, {
    probeRegistrar: false,
  })

  const quote = quoteFor({
    marginPercentage: marginFor(settings, operation),
    operation,
    period,
    product,
  })

  return json({
    availability: answer.availability,
    availabilityMessage:
      answer.availability === 'unknown'
        ? 'این پاسخ فقط قیمت است؛ برای بررسی آزادبودن دامنه از /api/site/registrar/search استفاده کنید.'
        : answer.availabilityMessage,
    quote,
    resellerEnabled: settings.enabled === true,
  })
}

/**
 * GET /api/site/registrar/search?domain=example.ir&period=1
 *
 * The step before buying: "is this name free, and what would it cost me?" — answered in
 * one round trip so a storefront/wizard can show an availability badge, a price, and the
 * *right* next action (register, transfer, or renew) without guessing any of the three.
 *
 * Two things it deliberately is not. It is not a registration: nothing is written, no
 * `reseller-domains` row appears, and the name is not reserved by looking at it. And it
 * is not an oracle for other tenants: a name another site is mid-workflow on answers
 * `reservedInPlatform` with no owner, no state and no registrar call, which is the same
 * shape `GET …/quote` already uses.
 *
 * Accepts a platform key alongside a site key for the reason the quote route does — the
 * builder searches a domain at step one of its wizard, before any site key exists — and
 * with the same consequence: `managedHere` (and therefore the renew action) needs a site
 * to mean anything, so a platform key never sees it.
 */
export const domainResellerSearch: Endpoint['handler'] = async (req) => {
  const key = await requestApiKey(req)
  const site = key?.role === 'platform' ? null : await siteKeyRequired(req)
  if (site instanceof Response) return site

  const domain = typeof req.query.domain === 'string' ? normalizeDomain(req.query.domain) : ''
  const period = validPeriod(req.query.period ?? 1)
  if (!domain || !isValidDomain(domain) || !period) {
    return json({ message: 'دامنه یا مدت درخواست نامعتبر است.', ok: false }, 400)
  }

  // Keyed on the credential, not the IP: the caller is a server-side integration, so its
  // API key is the accountable identity; `clientKey` only separates anonymous callers.
  const { limit, windowMs } = searchRateLimit()
  const throttle = consume({
    key: `registrar-search:${key?.id ?? (req.headers ? clientKey(req.headers) : 'unknown')}`,
    limit,
    windowMs,
  })
  if (!throttle.allowed) {
    return Response.json(
      { message: 'تعداد جست‌وجوی دامنه بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.', ok: false },
      {
        headers: { ...noStore, 'retry-after': String(throttle.retryAfterSeconds) },
        status: 429,
      },
    )
  }

  const settings = await resellerSettings(req.payload, req)
  const product = await productFor(req, domain)
  if (!product) {
    return json(
      {
        availability: 'unknown',
        availabilityMessage: availabilityMessages.unknown,
        message: 'این پسوند در کاتالوگ فعال پلتفرم نیست. برای قیمت‌گذاری با پشتیبانی تماس بگیرید.',
        ok: false,
      },
      404,
    )
  }

  // No registrar credential to spend while selling is off; the local answer still stands.
  const answer = await availabilityFor(req, domain, site ? String(site.id) : null, {
    probeRegistrar: settings.enabled === true,
  })
  const operations = operationsForAvailability(answer.availability, answer.managedState)

  return json({
    availability: answer.availability,
    availabilityMessage: answer.availabilityMessage,
    // True only when a registrar WHOIS call actually happened, so a UI can distinguish
    // "checked, and it is taken" from "nobody asked" instead of inferring it from wording.
    checkedWithRegistrar: answer.checkedWithRegistrar,
    domain,
    ok: true,
    // The operations a buyer may start right now, each already priced for `period`.
    operations,
    period,
    quotes: quotesFor({ operations, period, product, settings }),
    resellerEnabled: settings.enabled === true,
    tld: product.tld,
  })
}

/**
 * POST /api/site/registrar/domains
 *
 * Creates a local operation before submitting it so a network interruption always has a
 * visible lifecycle row. The caller selected immediate submission, but payment remains
 * `pendingIntegration` because neither this CMS nor this registrar response proves payment.
 */
export const domainResellerOrder: Endpoint['handler'] = async (req) => {
  const site = await siteKeyRequired(req)
  if (site instanceof Response) return site
  const input = await requestBody<OperationInput>(req)
  if (input instanceof Response) return input

  const domain = typeof input.domain === 'string' ? normalizeDomain(input.domain) : ''
  const operation = operationFrom(input.operation)
  const period = validPeriod(input.period)
  if (!domain || !isValidDomain(domain) || !operation || !period) {
    return json({ message: 'دامنه، عملیات یا مدت درخواست نامعتبر است.', ok: false }, 400)
  }

  const product = await productFor(req, domain)
  if (!product) {
    return json({ message: 'این پسوند برای فروش فعال نیست.', ok: false }, 404)
  }

  const settings = await resellerSettings(req.payload, req)
  if (settings.enabled !== true) {
    return json({ message: 'فروش دامنه توسط پلتفرم فعال نشده است.', ok: false }, 409)
  }

  const quote = quoteFor({
    marginPercentage: marginFor(settings, operation),
    operation,
    period,
    product,
  })

  const nameservers = operation === 'renew' ? null : nameserversFrom(input.nameservers)
  if (operation !== 'renew' && !nameservers) {
    return json({ message: 'برای ثبت یا انتقال، ۱ تا ۵ نام‌سرور معتبر وارد کنید.', ok: false }, 400)
  }
  if (input.contact !== undefined && !plainObject(input.contact)) {
    return json({ message: 'contact باید یک شیء JSON باشد.', ok: false }, 400)
  }
  if (input.fields !== undefined && !plainObject(input.fields)) {
    return json({ message: 'fields باید یک شیء JSON باشد.', ok: false }, 400)
  }
  if (input.irnicHandles !== undefined && !plainObject(input.irnicHandles)) {
    return json({ message: 'irnicHandles باید یک شیء JSON باشد.', ok: false }, 400)
  }
  if (
    input.eppCode !== undefined &&
    (typeof input.eppCode !== 'string' || input.eppCode.length > 512)
  ) {
    return json({ message: 'کد انتقال نامعتبر است.', ok: false }, 400)
  }

  // The provider documents the .ir handles as custom `fields`. Keep the structured
  // `irnicHandles` record for the CMS form but include it in the command too, so a caller
  // cannot accidentally create a local-only IRNIC configuration.
  const registrarFields = {
    ...(plainObject(input.irnicHandles) ? input.irnicHandles : {}),
    ...(plainObject(input.fields) ? input.fields : {}),
  }

  const prior = await existingDomain(req, domain)
  const siteId = String(site.id)
  if (prior && idOf(prior.site) !== siteId) {
    return json({ message: 'این دامنه اکنون در workflow پلتفرم دیگری است.', ok: false }, 409)
  }

  /**
   * Pre-flight the two mistakes the search step exists to prevent, because a client can
   * always post straight here without searching first. Each costs one WHOIS call and
   * saves a `RegisterDomain`/`TransferDomain` the registry is certain to reject — which
   * on this provider is a real charge against the platform reseller balance.
   *
   * Only a *certain* answer blocks: WHOIS contacts prove a registration, and an explicit
   * "no such domain" proves the opposite. Anything else is `unknown` and the order goes
   * through, because the registrar remains the authority and a flaky probe must not
   * become an outage of the order path.
   */
  if (operation !== 'renew') {
    const preflight = await availabilityFor(req, domain, siteId, { probeRegistrar: true })
    if (operation === 'register' && preflight.availability === 'registered') {
      return json(
        {
          availability: preflight.availability,
          message: 'این دامنه قبلاً ثبت شده است؛ در صورت مالکیت، درخواست انتقال ثبت کنید.',
          ok: false,
          operations: operationsForAvailability(preflight.availability, preflight.managedState),
        },
        409,
      )
    }
    if (operation === 'transfer' && preflight.availability === 'available') {
      return json(
        {
          availability: preflight.availability,
          message: 'این دامنه ثبت نشده است؛ انتقال ممکن نیست و باید آن را ثبت کنید.',
          ok: false,
          operations: operationsForAvailability(preflight.availability, preflight.managedState),
        },
        409,
      )
    }
  }

  let managed: ManagedDomain
  if (operation === 'renew') {
    if (!prior || !['providerAccepted', 'active'].includes(String(prior.state))) {
      return json(
        { message: 'تمدید فقط برای دامنهٔ پذیرفته‌شدهٔ همین سایت ممکن است.', ok: false },
        404,
      )
    }
    managed = prior
  } else if (prior && !['failed', 'cancelled', 'requested'].includes(String(prior.state))) {
    return json(
      { message: 'برای این دامنه یک درخواست فعال یا پذیرفته‌شده وجود دارد.', ok: false },
      409,
    )
  } else if (prior) {
    managed = (await req.payload.update({
      id: prior.id,
      collection: 'reseller-domains',
      data: {
        customFields: registrarFields,
        irnicHandles: input.irnicHandles,
        nameservers: nameservers!.map((hostname) => ({ hostname })),
        registrationContact: input.contact,
        state: 'requested',
        tld: product.tld,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })) as ManagedDomain
  } else {
    managed = (await req.payload.create({
      collection: 'reseller-domains',
      data: {
        customFields: registrarFields,
        domain,
        irnicHandles: input.irnicHandles,
        nameservers: nameservers!.map((hostname) => ({ hostname })),
        registrationContact: input.contact,
        site: siteId,
        state: 'requested',
        tld: product.tld,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })) as ManagedDomain
  }

  const order = await req.payload.create({
    collection: 'reseller-domain-operations',
    data: {
      catalogueCost: quote.catalogueCost,
      currency: quote.currency,
      domain: managed.id,
      marginPercentage: quote.marginPercentage,
      operation,
      paymentState: 'pendingIntegration',
      period,
      providerSubmittedAt: new Date().toISOString(),
      quoteAmount: quote.price,
      site: siteId,
      status: 'submitting',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })

  let configuration
  try {
    configuration = await resellerConfiguration(req.payload, req)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'پیکربندی registrar نامعتبر است.'
    const failed = await req.payload.update({
      id: order.id,
      collection: 'reseller-domain-operations',
      data: { providerRespondedAt: new Date().toISOString(), safeDetail: detail, status: 'failed' },
      depth: 0,
      overrideAccess: true,
      req,
    })
    if (operation !== 'renew') {
      await req.payload.update({
        id: managed.id,
        collection: 'reseller-domains',
        data: {
          providerLastSeenAt: new Date().toISOString(),
          providerNote: detail,
          state: 'failed',
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
    }
    await audit(
      req,
      siteId,
      managed.id,
      operation,
      false,
      'Registrar was not configured; request was not sent.',
    )
    return json({ message: detail, ok: false, operation: publicOperation(failed) }, 409)
  }

  const request =
    operation === 'register'
      ? {
          command: 'RegisterDomain',
          parameters: {
            ...(plainObject(input.contact) ? { contact: input.contact } : {}),
            domain,
            ...(Object.keys(registrarFields).length ? { fields: registrarFields } : {}),
            nameservers: nameserverObject(nameservers!),
            period,
          },
        }
      : operation === 'transfer'
        ? {
            command: 'TransferDomain',
            parameters: {
              ...(plainObject(input.contact) ? { contact: input.contact } : {}),
              domain,
              ...(typeof input.eppCode === 'string' && input.eppCode
                ? { epp_code: input.eppCode }
                : {}),
              ...(Object.keys(registrarFields).length ? { fields: registrarFields } : {}),
              nameservers: nameserverObject(nameservers!),
              period,
            },
          }
        : { command: 'RenewDomain', parameters: { domain, period } }

  try {
    await callResellerArea(configuration, request.command, request.parameters)
  } catch (error) {
    const detail = safeProviderFailure(error)
    const now = new Date().toISOString()
    const failed = await req.payload.update({
      id: order.id,
      collection: 'reseller-domain-operations',
      data: { providerRespondedAt: now, safeDetail: detail, status: 'failed' },
      depth: 0,
      overrideAccess: true,
      req,
    })
    if (operation !== 'renew') {
      await req.payload.update({
        id: managed.id,
        collection: 'reseller-domains',
        data: { providerLastSeenAt: now, providerNote: detail, state: 'failed' },
        depth: 0,
        overrideAccess: true,
        req,
      })
    }
    await audit(req, siteId, managed.id, operation, false, detail)
    return json({ message: detail, ok: false, operation: publicOperation(failed) }, 502)
  }

  const now = new Date().toISOString()
  const accepted = await req.payload.update({
    id: order.id,
    collection: 'reseller-domain-operations',
    data: {
      providerRespondedAt: now,
      safeDetail: 'Registrar درخواست را پذیرفت؛ API وضعیت نهایی/پرداخت را ارائه نمی‌کند.',
      status: 'providerAccepted',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
  const updatedDomain =
    operation === 'renew'
      ? managed
      : ((await req.payload.update({
          id: managed.id,
          collection: 'reseller-domains',
          data: {
            providerLastSeenAt: now,
            providerNote: 'Registrar درخواست را پذیرفت؛ تا تأیید عملیاتی، فعال تلقی نمی‌شود.',
            state: 'providerAccepted',
          },
          depth: 0,
          overrideAccess: true,
          req,
        })) as ManagedDomain)

  await audit(req, siteId, managed.id, operation, true, 'Registrar accepted the billable request.')
  return json(
    {
      domain: publicDomain(updatedDomain),
      message:
        'درخواست به registrar ارسال و پذیرفته شد. پرداخت همچنان در انتظار اتصال پلتفرم پرداخت است.',
      ok: true,
      operation: publicOperation(accepted),
    },
    201,
  )
}

/** GET /api/site/registrar/domains — the site key is the tenant boundary, not a supplied site id. */
export const domainResellerDomains: Endpoint['handler'] = async (req) => {
  const site = await siteKeyRequired(req)
  if (site instanceof Response) return site
  const { docs } = await req.payload.find({
    collection: 'reseller-domains',
    depth: 0,
    limit: 100,
    pagination: false,
    overrideAccess: true,
    req,
    where: { site: { equals: site.id } },
  })
  return json({ domains: docs.map((domain) => publicDomain(domain as ManagedDomain)) })
}

/** GET /api/site/registrar/operations — the tenant's safe request/progress timeline.
 * This is local workflow state, not a claimed registrar order-status feed: the published
 * provider contract has no such command. */
export const domainResellerOperations: Endpoint['handler'] = async (req) => {
  const site = await siteKeyRequired(req)
  if (site instanceof Response) return site

  const { docs } = await req.payload.find({
    collection: 'reseller-domain-operations',
    depth: 0,
    limit: 100,
    pagination: false,
    overrideAccess: true,
    req,
    sort: '-createdAt',
    where: { site: { equals: site.id } },
  })

  return json({ operations: docs.map((operation) => publicOperation(operation)) })
}

const contactsForUpdate = (value: unknown): Record<string, unknown> | null => {
  if (!plainObject(value)) return null
  const names = ['registrant', 'administrative', 'technical', 'billing']
  return names.every((name) => plainObject(value[name])) ? value : null
}

const scalarResult = (result: unknown, keys: string[]): unknown => {
  if (typeof result === 'string') return result
  if (!plainObject(result)) return undefined
  return keys.map((key) => result[key]).find((value) => value !== undefined)
}

/**
 * POST /api/site/registrar/manage
 *
 * Implements every non-billable command documented by the supplied ResellerArea PDF.
 * The tenant may manage its assigned domain through this server-side façade, but receives
 * neither the platform X-Api-Key nor the raw provider body. A transfer code/WHOIS result is
 * returned only to the authenticated key for that same site and is never persisted/audited.
 */
export const domainResellerManage: Endpoint['handler'] = async (req) => {
  const site = await siteKeyRequired(req)
  if (site instanceof Response) return site
  const input = await requestBody<Record<string, unknown>>(req)
  if (input instanceof Response) return input

  const domain = await domainForSite(req, String(site.id), input.id)
  if (!domain) return json({ message: 'دامنه یافت نشد.', ok: false }, 404)
  if (!['providerAccepted', 'active'].includes(String(domain.state))) {
    return json(
      { message: 'تا پیش از پذیرش registrar، مدیریت دامنه در دسترس نیست.', ok: false },
      409,
    )
  }

  const action = typeof input.action === 'string' ? input.action : ''
  let command = ''
  let eventOperation: EventOperation | null = null
  let parameters: Record<string, unknown> = { domain: domain.domain }
  let nextNameservers: string[] | null = null
  let nextContacts: Record<string, unknown> | null = null

  switch (action) {
    case 'nameservers.get':
      command = 'GetDomainNameServers'
      eventOperation = 'nameserversGet'
      break
    case 'nameservers.update': {
      const nameservers = nameserversFrom(input.nameservers)
      if (!nameservers) return json({ message: '۱ تا ۵ نام‌سرور معتبر وارد کنید.', ok: false }, 400)
      command = 'UpdateDomainNameServers'
      eventOperation = 'nameserversUpdate'
      parameters = { ...parameters, ...nameserverObject(nameservers) }
      nextNameservers = nameservers
      break
    }
    case 'lock.get':
      command = 'GetDomainLockStatus'
      eventOperation = 'lockGet'
      break
    case 'lock.update':
      if (typeof input.lockStatus !== 'boolean') {
        return json({ message: 'lockStatus باید true یا false باشد.', ok: false }, 400)
      }
      command = 'UpdateDomainLockStatus'
      eventOperation = 'lockUpdate'
      parameters = { ...parameters, lock_status: input.lockStatus }
      break
    case 'transfer-code.get':
      command = 'GetDomainTransferCode'
      eventOperation = 'transferCodeGet'
      break
    case 'child-nameserver.add':
      if (
        typeof input.nameserver !== 'string' ||
        !isValidDomain(normalizeDomain(input.nameserver))
      ) {
        return json({ message: 'nameserver نامعتبر است.', ok: false }, 400)
      }
      if (typeof input.ip !== 'string' || !input.ip.trim()) {
        return json({ message: 'ip نامعتبر است.', ok: false }, 400)
      }
      command = 'AddDomainChildNameServer'
      eventOperation = 'childNameserverAdd'
      parameters = {
        ...parameters,
        ip: input.ip.trim(),
        nameserver: normalizeDomain(input.nameserver),
      }
      break
    case 'child-nameserver.update':
      if (
        typeof input.nameserver !== 'string' ||
        !isValidDomain(normalizeDomain(input.nameserver))
      ) {
        return json({ message: 'nameserver نامعتبر است.', ok: false }, 400)
      }
      if (typeof input.currentIp !== 'string' || typeof input.newIp !== 'string') {
        return json({ message: 'currentIp و newIp الزامی‌اند.', ok: false }, 400)
      }
      command = 'UpdateDomainChildNameServer'
      eventOperation = 'childNameserverUpdate'
      parameters = {
        ...parameters,
        current_ip: input.currentIp.trim(),
        nameserver: normalizeDomain(input.nameserver),
        new_ip: input.newIp.trim(),
      }
      break
    case 'child-nameserver.remove':
      if (
        typeof input.nameserver !== 'string' ||
        !isValidDomain(normalizeDomain(input.nameserver))
      ) {
        return json({ message: 'nameserver نامعتبر است.', ok: false }, 400)
      }
      command = 'RemoveDomainChildNameServer'
      eventOperation = 'childNameserverRemove'
      parameters = { ...parameters, nameserver: normalizeDomain(input.nameserver) }
      break
    case 'irnic-contact.get':
      if (typeof input.irnicHandle !== 'string' || !input.irnicHandle.trim()) {
        return json({ message: 'irnicHandle الزامی است.', ok: false }, 400)
      }
      command = 'GetContactInfo'
      eventOperation = 'irnicContactGet'
      parameters = { irnic_handle: input.irnicHandle.trim() }
      break
    case 'transfer.validate': {
      const transferType = input.transferType
      if (transferType !== 'ResellerTransfer' && transferType !== 'OwnerTransfer') {
        return json(
          { message: 'transferType باید ResellerTransfer یا OwnerTransfer باشد.', ok: false },
          400,
        )
      }
      command = 'IsValidTransfer'
      eventOperation = 'transferValidate'
      parameters = { domain: domain.domain, transfer_type: transferType }
      if (transferType === 'OwnerTransfer') {
        const transferContacts = input.transferContacts
        if (!plainObject(transferContacts)) {
          return json({ message: 'برای OwnerTransfer، transferContacts لازم است.', ok: false }, 400)
        }
        for (const key of ['holder', 'admin', 'tech', 'bill']) {
          if (typeof transferContacts[key] !== 'string' || !String(transferContacts[key]).trim()) {
            return json({ message: `transferContacts.${key} الزامی است.`, ok: false }, 400)
          }
          parameters[key] = String(transferContacts[key]).trim()
        }
      }
      break
    }
    case 'whois.get':
      command = 'GetDomainWhoisInfo'
      eventOperation = 'whoisGet'
      break
    case 'whois.update': {
      const contacts = contactsForUpdate(input.contacts)
      if (!contacts) {
        return json(
          {
            message: 'contacts باید registrant، administrative، technical و billing داشته باشد.',
            ok: false,
          },
          400,
        )
      }
      command = 'UpdateDomainWhoisInfo'
      eventOperation = 'whoisUpdate'
      parameters = { ...parameters, ...contacts }
      nextContacts = contacts
      break
    }
    default:
      return json({ message: 'عملیات مدیریت دامنه شناخته‌شده نیست.', ok: false }, 400)
  }

  if (!command || !eventOperation) {
    return json({ message: 'عملیات مدیریت دامنه ناقص است.', ok: false }, 400)
  }

  let configuration
  try {
    configuration = await resellerConfiguration(req.payload, req)
  } catch (error) {
    return json(
      {
        message:
          error instanceof DomainResellerConfigurationError
            ? error.message
            : 'پیکربندی registrar نامعتبر است.',
        ok: false,
      },
      409,
    )
  }

  let result: unknown
  try {
    result = await callResellerArea(configuration, command, parameters)
  } catch (error) {
    const detail = safeProviderFailure(error)
    await audit(req, String(site.id), domain.id, eventOperation, false, detail)
    return json({ message: detail, ok: false }, 502)
  }

  const now = new Date().toISOString()
  let updated = domain
  if (nextNameservers || nextContacts) {
    updated = (await req.payload.update({
      id: domain.id,
      collection: 'reseller-domains',
      data: {
        ...(nextNameservers
          ? { nameservers: nextNameservers.map((hostname) => ({ hostname })) }
          : {}),
        ...(nextContacts ? { contacts: nextContacts } : {}),
        providerLastSeenAt: now,
        providerNote: `Registrar ${command} را پذیرفت.`,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })) as ManagedDomain
  } else {
    await req.payload.update({
      id: domain.id,
      collection: 'reseller-domains',
      data: { providerLastSeenAt: now, providerNote: `Registrar ${command} را پذیرفت.` },
      depth: 0,
      overrideAccess: true,
      req,
    })
  }
  await audit(
    req,
    String(site.id),
    domain.id,
    eventOperation,
    true,
    `Registrar completed ${command}.`,
  )

  // Map only documented response fields. The raw body might contain future fields (or PII),
  // so it must not become an accidental public API merely because the provider added one.
  const response: Record<string, unknown> = { domain: publicDomain(updated), ok: true }
  if (action === 'nameservers.get') response.nameservers = result
  if (action === 'lock.get')
    response.lockStatus = scalarResult(result, ['lock_status', 'lockStatus'])
  if (action === 'transfer-code.get') {
    response.transferCode = scalarResult(result, ['transfer_code', 'epp_code', 'code'])
  }
  if (action === 'irnic-contact.get') response.relations = scalarResult(result, ['relations'])
  if (action === 'whois.get') response.contacts = result
  return json(response)
}

export const domainResellerEndpoints: Endpoint[] = [
  { handler: domainResellerSearch, method: 'get', path: '/site/registrar/search' },
  { handler: domainResellerQuote, method: 'get', path: '/site/registrar/quote' },
  { handler: domainResellerDomains, method: 'get', path: '/site/registrar/domains' },
  { handler: domainResellerOperations, method: 'get', path: '/site/registrar/operations' },
  { handler: domainResellerOrder, method: 'post', path: '/site/registrar/domains' },
  { handler: domainResellerManage, method: 'post', path: '/site/registrar/manage' },
]
