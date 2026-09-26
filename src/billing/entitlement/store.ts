import { createHash } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { decideProjectionVersion, parseLimitMap, type LimitMap } from '@/billing/entitlement/limits'

export type ProjectionInput = {
  billingCycleEnd?: null | string
  billingCycleStart?: null | string
  effectiveAt?: null | string
  features: Record<string, boolean>
  limits: LimitMap
  planCode?: null | string
  serving: boolean
  siteId: string
  source: 'migration' | 'pull' | 'push'
  subscriptionStatus?: null | string
  version: number
}

export type ProjectionWrite =
  | { ok: true; result: 'created' | 'idempotent' | 'updated'; version: number }
  | { message: string; ok: false; status: number }

const checksumOf = (input: ProjectionInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        features: input.features,
        limits: input.limits,
        planCode: input.planCode ?? null,
        serving: input.serving,
        version: input.version,
      }),
    )
    .digest('hex')

const boolMap = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'boolean') out[key] = raw
  }
  return out
}

export const parseProjectionInput = (
  body: unknown,
  source: ProjectionInput['source'],
): { error: string } | { input: ProjectionInput } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'بدنه نامعتبر است.' }
  const raw = body as Record<string, unknown>
  if ('businessId' in raw || 'business_id' in raw || 'price' in raw || 'wallet' in raw) {
    return { error: 'تصویر حق‌دسترسی شناسهٔ کسب‌وکار یا قیمت را نمی‌پذیرد.' }
  }
  const siteId = typeof raw.siteId === 'string' ? raw.siteId : ''
  if (siteId.length < 8) return { error: 'سایت نامعتبر است.' }
  const version = Number(raw.version)
  if (!Number.isSafeInteger(version) || version < 1) return { error: 'نسخه باید عدد صحیح مثبت باشد.' }
  const limits = parseLimitMap(raw.limits)
  if ('error' in limits) return { error: limits.error }
  const features = boolMap(raw.features)
  return {
    input: {
      billingCycleEnd: typeof raw.billingCycleEnd === 'string' ? raw.billingCycleEnd : null,
      billingCycleStart: typeof raw.billingCycleStart === 'string' ? raw.billingCycleStart : null,
      effectiveAt: typeof raw.effectiveAt === 'string' ? raw.effectiveAt : new Date().toISOString(),
      features,
      limits: limits.limits,
      planCode: typeof raw.planCode === 'string' ? raw.planCode.slice(0, 64) : null,
      serving: raw.serving === true,
      siteId,
      source,
      subscriptionStatus: typeof raw.subscriptionStatus === 'string' ? raw.subscriptionStatus.slice(0, 32) : null,
      version,
    },
  }
}

export const readProjection = async (
  req: PayloadRequest,
  siteId: string,
): Promise<null | Record<string, unknown>> => {
  const { docs } = await req.payload.find({
    collection: 'central-entitlement-projections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { site: { equals: siteId } },
  })
  return (docs[0] as unknown as Record<string, unknown>) ?? null
}

export const writeProjection = async (req: PayloadRequest, input: ProjectionInput): Promise<ProjectionWrite> => {
  const site = await req.payload.findByID({
    id: input.siteId,
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })
  if (!site) return { message: 'سایت پیدا نشد.', ok: false, status: 404 }

  const current = await readProjection(req, input.siteId)
  const currentVersion = current ? Number(current.version ?? 0) : null
  const decision = decideProjectionVersion(currentVersion, input.version)
  if (decision === 'stale') {
    return { message: 'نسخهٔ قدیمی‌تر از تصویر فعلی است و نادیده گرفته شد.', ok: false, status: 409 }
  }
  if (decision === 'idempotent') return { ok: true, result: 'idempotent', version: input.version }

  const data = {
    billingCycleEnd: input.billingCycleEnd,
    billingCycleStart: input.billingCycleStart,
    checksum: checksumOf(input),
    effectiveAt: input.effectiveAt,
    features: input.features,
    limits: input.limits,
    planCode: input.planCode,
    receivedAt: new Date().toISOString(),
    serving: input.serving,
    site: input.siteId,
    source: input.source,
    subscriptionStatus: input.subscriptionStatus,
    version: input.version,
  }

  if (!current) {
    await req.payload.create({
      collection: 'central-entitlement-projections',
      data,
      depth: 0,
      overrideAccess: true,
      req,
    })
    return { ok: true, result: 'created', version: input.version }
  }

  await req.payload.update({
    id: String(current.id),
    collection: 'central-entitlement-projections',
    data,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return { ok: true, result: 'updated', version: input.version }
}
