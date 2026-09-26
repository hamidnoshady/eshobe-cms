import { S3Client } from '@aws-sdk/client-s3'

import type { PayloadRequest } from 'payload'

import { decryptStorageSecret } from './crypto'
import { isStorageMode, type StorageMode } from './mode'
import { isStorageProviderId } from './providers'
import type { StorageClientKey, StorageConnection } from './types'
import { STORAGE_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/storageConnectionSecrets'

/**
 * Resolves the one S3-compatible object-storage connection the whole platform writes to.
 *
 * Cached in-process with a short TTL on the hot media path; every mutation on
 * `storage-connections` clears the cache immediately via hooks.
 */

const CONNECTION_TTL_MS = 60_000

const clientKey = (connection: StorageConnection): string => {
  const key: StorageClientKey = {
    accessKeyId: connection.accessKeyId,
    bucket: connection.bucket,
    endpoint: connection.endpoint,
    forcePathStyle: connection.forcePathStyle,
    provider: connection.provider,
    region: connection.region,
    secretAccessKey: connection.secretAccessKey,
    storageMode: connection.storageMode,
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
    maxAttempts: 3,
    region: connection.region || 'default',
    requestHandler: {
      httpAgent: { keepAlive: true, maxSockets: 100 },
      httpsAgent: { keepAlive: true, maxSockets: 100 },
    },
  })

  clients.set(key, client)
  return client
}

type CachedConnection = { connection: null | StorageConnection; fetchedAt: number }

let cached: CachedConnection | undefined

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

    const row = docs[0] as unknown as Record<string, unknown> | undefined

    if (row) {
      const secret = decryptStorageSecret(row.secretAccessKey as string | null | undefined)
      if (!secret) {
        throw new Error(
          'اتصال ذخیره‌سازی شیء فعال است اما کلید رمزنگاری‌شده خوانا نیست؛ ' +
            'آن را دوباره در «زیرساخت → ذخیره‌سازی اشیا» وارد کنید.',
        )
      }
      const storageMode: StorageMode = isStorageMode(row.storageMode)
        ? row.storageMode
        : 'object_storage_with_local_mirror'

      connection = {
        accessKeyId: String(row.accessKeyId ?? ''),
        bucket: String(row.bucket ?? ''),
        endpoint: String(row.endpoint ?? ''),
        forcePathStyle: row.forcePathStyle !== false,
        id: String(row.id),
        name: String(row.name ?? ''),
        provider: isStorageProviderId(row.provider) ? row.provider : 'arvancloud',
        region: String(row.region ?? ''),
        secretAccessKey: secret,
        storageMode,
      }
    }
  } finally {
    delete req.context[STORAGE_SECRET_READ_CONTEXT_KEY]
  }

  cached = { connection, fetchedAt: now }
  return connection
}

export const storageClient = (connection: StorageConnection): S3Client => buildClient(connection)

export const freshStorageClient = (connection: StorageConnection): S3Client =>
  new S3Client({
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    endpoint: connection.endpoint,
    forcePathStyle: connection.forcePathStyle,
    maxAttempts: 2,
    region: connection.region || 'default',
  })

export const clearStorageConnectionCache = (): void => {
  cached = undefined
  clients.clear()
}
