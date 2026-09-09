import { HeadBucketCommand } from '@aws-sdk/client-s3'
import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { STORAGE_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/storageConnectionSecrets'
import { isUuid } from '@/lib/ids'
import { decryptStorageSecret } from '@/storage/crypto'
import { clearStorageConnectionCache, freshStorageClient } from '@/storage/connection'
import type { StorageConnection } from '@/storage/types'

/**
 * `POST /api/storage-connections/self-test` — platform admin only.
 *
 * Verifies that a connection's credentials can actually reach the bucket, without uploading
 * or deleting anything: a `HeadBucket` is the read-only equivalent of "can I use this?".
 * The result is written back onto the row so the next admin to look at it knows whether the
 * credentials were ever known to work — the only way to tell "the secret key was mistyped"
 * from "ArvanCloud is down".
 */

const noStore = { 'cache-control': 'no-store' }

const json = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

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
    const row = doc as {
      accessKeyId?: string | null
      bucket?: string | null
      endpoint?: string | null
      forcePathStyle?: boolean | null
      id: string
      name?: string | null
      region?: string | null
      secretAccessKey?: string | null
    } | null

    if (!row) return null

    const secret = decryptStorageSecret(row.secretAccessKey)
    if (!secret) return null

    return {
      accessKeyId: String(row.accessKeyId ?? ''),
      bucket: String(row.bucket ?? ''),
      endpoint: String(row.endpoint ?? ''),
      forcePathStyle: row.forcePathStyle !== false,
      id: row.id,
      name: String(row.name ?? ''),
      region: String(row.region ?? ''),
      secretAccessKey: secret,
    }
  } finally {
    delete req.context[STORAGE_SECRET_READ_CONTEXT_KEY]
  }
}

export const storageSelfTest: Endpoint['handler'] = async (req) => {
  const { user } = await req.payload.auth({ headers: req.headers, req })
  // Same widening as the payment self-test: a `role: "platform"` key is the operator,
  // and «سایت‌ساز» in the POS console probes object storage from there.
  if (!(await isPlatformAdminOrPlatformKey(req, isPlatformAdmin(user)))) {
    return json({ message: 'فقط کارکنان سکو می‌توانند خودآزمایی اجرا کنند.', ok: false }, 403)
  }

  const body = (await req.json?.().catch(() => null)) as { id?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id : null

  if (!isUuid(id)) return json({ message: 'شناسهٔ اتصال نامعتبر است.', ok: false }, 400)

  const connection = await readConnection(req, id)
  if (!connection) {
    return json({ message: 'اتصال یافت نشد یا کلید آن خوانا نیست.', ok: false }, 404)
  }

  const startedAt = Date.now()
  try {
    await freshStorageClient(connection).send(new HeadBucketCommand({ Bucket: connection.bucket }))
  } catch (error) {
    const detail = `${(error as Error).message ?? 'خطای ناشناخته'} (${Date.now() - startedAt}ms)`
    await req.payload.update({
      collection: 'storage-connections',
      data: {
        lastSelfTestAt: new Date().toISOString(),
        lastSelfTestDetail: detail,
        lastSelfTestOk: false,
      },
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })
    return json({ detail, message: 'دسترسی به باکت برقرار نشد.', ok: false }, 502)
  }

  const detail = `باکت «${connection.bucket}» در دسترس است (${Date.now() - startedAt}ms)`
  await req.payload.update({
    collection: 'storage-connections',
    data: {
      lastSelfTestAt: new Date().toISOString(),
      lastSelfTestDetail: detail,
      lastSelfTestOk: true,
    },
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })

  // The connection (and thus its credentials) may have just changed; drop the cache so the
  // next upload resolves it fresh rather than reusing a stale S3 client.
  clearStorageConnectionCache()

  return json({ detail, ok: true })
}

export const storageConnectionEndpoints: Endpoint[] = [
  { handler: storageSelfTest, method: 'post', path: '/storage-connections/self-test' },
]
