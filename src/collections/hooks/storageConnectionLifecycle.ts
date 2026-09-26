import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
} from 'payload'

import { APIError } from 'payload'

import { assertSafeStorageEndpoint } from '@/storage/endpoint'
import { applyProviderDefaults } from '@/storage/providers'
import { STORAGE_HEALTH_PATCH_CONTEXT_KEY } from './storageConnectionSecrets'
import { clearStorageConnectionCache } from '@/storage/connection'

type Row = Record<string, unknown>

const CONFIG_KEYS = [
  'accessKeyId',
  'bucket',
  'endpoint',
  'forcePathStyle',
  'provider',
  'region',
  'secretAccessKey',
  'storageMode',
] as const

const changedConfig = (data: Row, originalDoc: Row | undefined): boolean => {
  if (data.clearCredentials === true) return true
  const typedSecret = data.secretAccessKey
  if (typeof typedSecret === 'string' && typedSecret.trim()) return true

  return CONFIG_KEYS.some((key) => {
    if (key === 'secretAccessKey') return false
    if (!(key in data)) return false
    return data[key] !== originalDoc?.[key]
  })
}

/** Normalise provider defaults and vet the endpoint before save. */
export const normaliseStorageConnection: CollectionBeforeChangeHook = async ({ data, req }) => {
  const input = (data ?? {}) as Row
  const defaults = applyProviderDefaults({
    endpoint: input.endpoint as string | null,
    forcePathStyle: input.forcePathStyle as boolean | null,
    provider: input.provider as string | null,
    region: input.region as string | null,
  })

  input.provider = defaults.provider
  if (!input.endpoint || typeof input.endpoint !== 'string' || !input.endpoint.trim()) {
    input.endpoint = defaults.endpoint
  }
  if (input.forcePathStyle === undefined || input.forcePathStyle === null) {
    input.forcePathStyle = defaults.forcePathStyle
  }
  if (!input.region || typeof input.region !== 'string' || !String(input.region).trim()) {
    input.region = defaults.region
  }

  if (typeof input.endpoint === 'string' && input.endpoint.trim()) {
    input.endpoint = await assertSafeStorageEndpoint(input.endpoint)
  }

  return input
}

/** Invalidate stale health when anything connection-affecting changes. */
export const invalidateStorageHealthOnChange: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  if (!originalDoc?.id) return data
  if (!changedConfig((data ?? {}) as Row, originalDoc as Row)) return data

  return {
    ...data,
    authenticationOk: false,
    bucketAccessible: false,
    deleteAccessOk: false,
    endpointReachable: false,
    healthStatus: 'retest_required',
    lastErrorCategory: 'CONFIGURATION',
    lastErrorCode: 'ConfigurationChanged',
    lastErrorMessage: 'پیکربندی تغییر کرد. دوباره خودآزمایی را اجرا کنید.',
    lastSelfTestOk: false,
    readAccessOk: false,
    writeAccessOk: false,
  }
}

/**
 * When enabling a connection, disable every other row in the same transaction instead of
 * throwing — the operator expects «فعال» to switch production storage atomically.
 */
export const deactivateOtherStorageConnections: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const enabled = Boolean((data as Row)?.enabled ?? originalDoc?.enabled)
  if (!enabled) return data

  const selfId = originalDoc?.id as string | undefined
  const { docs } = await req.payload.find({
    collection: 'storage-connections',
    depth: 0,
    limit: 50,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [{ enabled: { equals: true } }, ...(selfId ? [{ id: { not_equals: selfId } }] : [])],
    },
  })

  for (const doc of docs) {
    await req.payload.update({
      collection: 'storage-connections',
      data: { enabled: false, healthStatus: 'disabled' },
      depth: 0,
      id: doc.id,
      overrideAccess: true,
      req,
    })
  }

  return data
}

export const requireFullHealthBeforeEnable: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const enabling = (data as Row)?.enabled === true
  if (!enabling) return data

  const id = originalDoc?.id as string | undefined
  if (!id) return data

  const stored = (await req.payload.findByID({
    collection: 'storage-connections',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })) as unknown as Row | null

  const merged = { ...stored, ...(data as Row) } as Row
  const healthStatus = String(merged?.healthStatus ?? '')
  const writeOk = merged?.writeAccessOk
  const readOk = merged?.readAccessOk
  const deleteOk = merged?.deleteAccessOk

  if (
    healthStatus !== 'healthy' ||
    writeOk !== true ||
    readOk !== true ||
    deleteOk !== true
  ) {
    throw new APIError(
      'برای فعال‌سازی، ابتدا «خودآزمایی کامل» را با موفقیت اجرا کنید (نوشتن، خواندن و حذف).',
      400,
    )
  }

  return data
}

export const preventDeleteActiveStorageConnection: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const doc = await req.payload.findByID({
    collection: 'storage-connections',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })

  if ((doc as { enabled?: boolean } | null)?.enabled) {
    throw new APIError(
      'اتصال فعال را نمی‌توان حذف کرد. ابتدا آن را غیرفعال کنید یا اتصال دیگری را فعال کنید.',
      400,
    )
  }
}

/** Runs after field access so self-test can persist derived health columns safely. */
export const mergeContextStorageHealth: CollectionBeforeChangeHook = ({ data, req }) => {
  const patch = req.context?.[STORAGE_HEALTH_PATCH_CONTEXT_KEY]
  if (!patch || typeof patch !== 'object') return data
  return { ...data, ...(patch as Row) }
}

export const clearStorageCacheAfterChange: CollectionAfterChangeHook = () => {
  clearStorageConnectionCache()
  return undefined
}

export const clearStorageCacheAfterDelete: CollectionAfterDeleteHook = () => {
  clearStorageConnectionCache()
}
