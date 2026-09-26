import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { STORAGE_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/storageConnectionSecrets'
import {
  STORAGE_HEALTH_PATCH_CONTEXT_KEY,
  STORAGE_HEALTH_WRITE_CONTEXT_KEY,
} from '@/collections/hooks/storageConnectionSecrets'
import { isUuid } from '@/lib/ids'
import { decryptStorageSecret } from '@/storage/crypto'
import { clearStorageConnectionCache, freshStorageClient, getActiveConnection } from '@/storage/connection'
import {
  runFullStorageTest,
  runQuickStorageTest,
  type StorageTestMode,
} from '@/storage/health'
import type { StorageConnection } from '@/storage/types'
import { storageUsageReport } from '@/storage/usage'
import { deriveHealthStatus } from '@/storage/health'
import { isStorageProviderId } from '@/storage/providers'
import { isStorageMode } from '@/storage/mode'

/**
 * Collection endpoints on `storage-connections` — see `StorageConnections.endpoints`.
 *
 * `POST /api/storage-connections/self-test` — quick or full diagnostic (`mode`).
 * `GET /api/storage-connections/overview` — operator dashboard summary.
 * `GET /api/storage-connections/usage` — database-known media usage.
 */

const noStore = { 'cache-control': 'no-store' }

const json = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

const authorised = async (req: PayloadRequest): Promise<boolean> => {
  const { user } = await req.payload.auth({ headers: req.headers, req })
  return isPlatformAdminOrPlatformKey(req, isPlatformAdmin(user))
}

const readConnection = async (
  req: PayloadRequest,
  id: string,
): Promise<null | StorageConnection> => {
  req.context[STORAGE_SECRET_READ_CONTEXT_KEY] = true
  try {
    const doc = await req.payload.findByID({
      collection: 'storage-connections',
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })
    const row = doc as unknown as Record<string, unknown> | null
    if (!row) return null

    const secret = decryptStorageSecret(row.secretAccessKey as string | null | undefined)
    if (!secret) return null

    return {
      accessKeyId: String(row.accessKeyId ?? ''),
      bucket: String(row.bucket ?? ''),
      endpoint: String(row.endpoint ?? ''),
      forcePathStyle: row.forcePathStyle !== false,
      id: String(row.id),
      name: String(row.name ?? ''),
      provider: isStorageProviderId(row.provider) ? row.provider : 'arvancloud',
      region: String(row.region ?? ''),
      secretAccessKey: secret,
      storageMode: isStorageMode(row.storageMode) ? row.storageMode : 'object_storage_with_local_mirror',
    }
  } finally {
    delete req.context[STORAGE_SECRET_READ_CONTEXT_KEY]
  }
}

const persistHealth = async (
  req: PayloadRequest,
  id: string,
  result: Awaited<ReturnType<typeof runFullStorageTest>>,
): Promise<void> => {
  const now = new Date().toISOString()
  const patch = {
    authenticationOk: result.authenticationOk,
    bucketAccessible: result.bucketAccessible,
    deleteAccessOk: result.deleteAccessOk,
    endpointReachable: result.endpointReachable,
    healthStatus: result.ok ? 'healthy' : 'failed',
    lastCheckedAt: now,
    lastErrorCategory: result.errorCategory ?? null,
    lastErrorCode: result.errorCode ?? null,
    lastErrorMessage: result.errorMessage ?? null,
    lastHealthyAt: result.ok ? now : undefined,
    lastSelfTestAt: now,
    lastSelfTestDetail: result.ok
      ? `خودآزمایی ${result.mode === 'full' ? 'کامل' : 'سریع'} موفق (${result.latencyMs}ms)`
      : result.errorMessage ?? 'خودآزمایی ناموفق',
    lastSelfTestOk: result.ok,
    latencyMs: result.latencyMs,
    readAccessOk: result.readAccessOk,
    writeAccessOk: result.writeAccessOk,
  }

  await req.payload.update({
    collection: 'storage-connections',
    context: {
      [STORAGE_HEALTH_PATCH_CONTEXT_KEY]: patch,
      [STORAGE_HEALTH_WRITE_CONTEXT_KEY]: true,
    },
    data: {},
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })
}

export const storageSelfTest: Endpoint['handler'] = async (req) => {
  if (!(await authorised(req))) {
    return json({ message: 'فقط کارکنان سکو می‌توانند خودآزمایی اجرا کنند.', ok: false }, 403)
  }

  const body = (await req.json?.().catch(() => null)) as { id?: unknown; mode?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id : null
  const mode: StorageTestMode = body?.mode === 'quick' ? 'quick' : 'full'

  if (!isUuid(id)) return json({ message: 'شناسهٔ اتصال نامعتبر است.', ok: false }, 400)

  const connection = await readConnection(req, id)
  if (!connection) {
    return json({ message: 'اتصال یافت نشد یا کلید آن خوانا نیست.', ok: false }, 404)
  }

  const client = freshStorageClient(connection)
  const result = mode === 'quick' ? await runQuickStorageTest(connection, client) : await runFullStorageTest(connection, client)

  await persistHealth(req, id, result)
  clearStorageConnectionCache()

  if (!result.ok) {
    return json(
      {
        latencyMs: result.latencyMs,
        message: result.errorMessage ?? 'خودآزمایی ناموفق بود.',
        mode: result.mode,
        ok: false,
        steps: result.steps,
      },
      502,
    )
  }

  return json({
    latencyMs: result.latencyMs,
    message: 'اتصال کاملاً عملیاتی است.',
    mode: result.mode,
    ok: true,
    steps: result.steps,
  })
}

export const storageOverview: Endpoint['handler'] = async (req) => {
  if (!(await authorised(req))) {
    return json({ message: 'دسترسی مجاز نیست.' }, 403)
  }

  let active: StorageConnection | null = null
  let usable = false
  try {
    active = await getActiveConnection(req)
    usable = Boolean(active)
  } catch {
    usable = false
  }

  const { docs } = await req.payload.find({
    collection: 'storage-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-updatedAt',
    where: active ? { id: { equals: active.id } } : { enabled: { equals: true } },
  })

  const row = (docs[0] ?? null) as unknown as Record<string, unknown> | null
  const healthStatus = row ? deriveHealthStatus(row as Parameters<typeof deriveHealthStatus>[0]) : 'unknown'

  return json({
    configured: (await req.payload.count({ collection: 'storage-connections', overrideAccess: true, req }))
      .totalDocs > 0,
    connection: row
      ? {
          bucket: row.bucket ?? null,
          enabled: row.enabled === true,
          endpoint: row.endpoint ?? null,
          healthStatus,
          id: row.id,
          lastCheckedAt: row.lastCheckedAt ?? row.lastSelfTestAt ?? null,
          lastHealthyAt: row.lastHealthyAt ?? null,
          latencyMs: row.latencyMs ?? null,
          name: row.name ?? null,
          provider: row.provider ?? null,
          storageMode: row.storageMode ?? null,
        }
      : null,
    enabled: Boolean(active),
    usable,
  })
}

export const storageUsage: Endpoint['handler'] = async (req) => {
  if (!(await authorised(req))) {
    return json({ message: 'دسترسی مجاز نیست.' }, 403)
  }

  const usage = await storageUsageReport(req)
  return json({ ok: true, usage })
}

export const storageConnectionEndpoints: Endpoint[] = [
  { handler: storageOverview, method: 'get', path: '/overview' },
  { handler: storageSelfTest, method: 'post', path: '/self-test' },
  { handler: storageUsage, method: 'get', path: '/usage' },
]
