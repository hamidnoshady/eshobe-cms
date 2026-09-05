import type { Endpoint, PayloadRequest } from 'payload'

import type { ResellerDomainEvent, Site } from '@/payload-types'

import { isValidDomain, normalizeDomain } from '@/lib/domains'
import { idOf, isUuid } from '@/lib/ids'
import {
  callResellerArea,
  currencyFrom,
  DomainResellerConfigurationError,
  DomainResellerProviderError,
  marginFor,
  operationFrom,
  productForDomain,
  quoteFor,
  resellerConfiguration,
  resellerSettings,
  type ResellerProduct,
} from '@/domain-reseller/service'

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
export const domainResellerQuote: Endpoint['handler'] = async (req) => {
  const site = await siteKeyRequired(req)
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
  const existing = await existingDomain(req, domain)
  const existingSiteId = existing ? idOf(existing.site) : null
  const availability =
    existing && existingSiteId === String(site.id)
      ? 'managedHere'
      : existing
        ? 'reservedInPlatform'
        : 'unknown'

  const quote = quoteFor({
    marginPercentage: marginFor(settings, operation),
    operation,
    period,
    product,
  })

  return json({
    availability,
    availabilityMessage:
      availability === 'unknown'
        ? 'API مستندشدهٔ registrar بررسی آزادبودن دامنه ندارد؛ پیش از ارسال، registrar وضعیت واقعی را می‌سنجد.'
        : availability === 'managedHere'
          ? 'این دامنه از قبل برای همین سایت در پلتفرم مدیریت می‌شود.'
          : 'این دامنه در یک workflow دیگر پلتفرم رزرو یا مدیریت شده است.',
    quote,
    resellerEnabled: settings.enabled === true,
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
  { handler: domainResellerQuote, method: 'get', path: '/site/registrar/quote' },
  { handler: domainResellerDomains, method: 'get', path: '/site/registrar/domains' },
  { handler: domainResellerOperations, method: 'get', path: '/site/registrar/operations' },
  { handler: domainResellerOrder, method: 'post', path: '/site/registrar/domains' },
  { handler: domainResellerManage, method: 'post', path: '/site/registrar/manage' },
]
