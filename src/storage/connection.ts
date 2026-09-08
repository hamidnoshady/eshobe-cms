import { S3Client } from '@aws-sdk/client-s3'

import type { PayloadRequest } from 'payload'

import { decryptStorageSecret } from './crypto'
import type { StorageClientKey, StorageConnection } from './types'
import { STORAGE_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/storageConnectionSecrets'

/**
 * Resolves the one ArvanCloud object-storage connection the whole platform writes to.
 *
 * The connection lives in the `storage-connections` collection — a platform-admin-only row,
 * configured once by a superadmin — never in environment variables. Every tenant's media
 * lands in the same bucket, namespaced by `sites/<id>/media` (see `src/hooks/mediaPrefix.ts`),
 * so no per-tenant or per-user configuration exists.
 *
 * The connection is cached in-process for a short TTL: it is read on the hot media-serving
 * path, and the row changes only when an admin edits it, so a minute of staleness is a
 * harmless price for not hitting Postgres on every image request.
 */

const CONNECTION_TTL_MS = 60_000

const clientKey = (connection: StorageConnection): string => {
  const key: StorageClientKey = {
    accessKeyId: connection.accessKeyId,
    bucket: connection.bucket,
    endpoint: connection.endpoint,
    forcePathStyle: connection.forcePathStyle,
    region: connection.region,
    secretAccessKey: connection.secretAccessKey,
  }
  return JSON.stringify(key)
}

const clients = new Map<string, S3Client>()

const buildClient = (connection: StorageConnection): S3Client => {
  const key = clientKey(connection)
  const existing = clients.get(key)
  if (existing) return existing

  const client = new S3Client({
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    endpoint: connection.endpoint,
    forcePathStyle: connection.forcePathStyle,
    region: connection.region || 'default',
    requestHandler: {
      // Keep connections alive across requests — the media route streams many small
      // objects, and a fresh TLS handshake per object is the avoidable cost here.
      httpAgent: { keepAlive: true, maxSockets: 100 },
      httpsAgent: { keepAlive: true, maxSockets: 100 },
    },
  })

  clients.set(key, client)
  return client
}

type CachedConnection = { connection: null | StorageConnection; fetchedAt: number }

let cached: CachedConnection | undefined

/**
 * The active connection, or `null` when none is enabled (uploads stay on local disk, the
 * same posture as the old R2 setup when its env vars were unset in development).
 *
 * Throws when a connection *is* enabled but its secret is missing or no longer decrypts:
 * that is the "half-configured bucket" state the old `r2Configured()` guard existed to
 * prevent, and falling back to local disk would silently hide it — files would land only on
 * one replica's disk and be gone on the next deploy.
 */
export const getActiveConnection = async (
  req: PayloadRequest,
): Promise<null | StorageConnection> => {
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CONNECTION_TTL_MS) return cached.connection

  req.context[STORAGE_SECRET_READ_CONTEXT_KEY] = true
  let connection: null | StorageConnection = null
  try {
    const { docs } = await req.payload.find({
      collection: 'storage-connections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'createdAt',
      where: { enabled: { equals: true } },
    })

    const row = docs[0] as StorageConnection | null

    if (row) {
      const secret = decryptStorageSecret(row.secretAccessKey)
      if (!secret) {
        throw new Error(
          'اتصال ذخیره‌سازی ArvanCloud فعال است اما کلید رمزنگاری‌شده خوانا نیست؛ ' +
            'آن را دوباره در «زیرساخت → اتصال ذخیره‌سازی» وارد کنید.',
        )
      }
      connection = {
        accessKeyId: String(row.accessKeyId ?? ''),
        bucket: String(row.bucket ?? ''),
        endpoint: String(row.endpoint ?? ''),
        forcePathStyle: row.forcePathStyle !== false,
        id: row.id,
        name: String(row.name ?? ''),
        region: String(row.region ?? ''),
        secretAccessKey: secret,
      }
    }
  } finally {
    delete req.context[STORAGE_SECRET_READ_CONTEXT_KEY]
  }

  cached = { connection, fetchedAt: now }
  return connection
}

/** Build (or reuse) the S3 client for a resolved connection. */
export const storageClient = (connection: StorageConnection): S3Client => buildClient(connection)

/** For the self-test endpoint, which must bypass the TTL cache and use a fresh client. */
export const freshStorageClient = (connection: StorageConnection): S3Client => {
  const client = new S3Client({
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    endpoint: connection.endpoint,
    forcePathStyle: connection.forcePathStyle,
    region: connection.region || 'default',
  })
  return client
}

/** Test-only: forget the cached connection so a test can point at a fresh row. */
export const clearStorageConnectionCache = (): void => {
  cached = undefined
  clients.clear()
}
