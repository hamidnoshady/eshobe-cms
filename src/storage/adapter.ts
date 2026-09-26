import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { Adapter, StaticHandler } from '@payloadcms/plugin-cloud-storage/types'
import { getFileKey, getFilePrefix } from '@payloadcms/plugin-cloud-storage/utilities'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'

import { getRangeRequestInfo } from 'payload/internal'

import { getActiveConnection, storageClient } from './connection'
import { shouldDropLocalMirrorAfterUpload, shouldUseObjectStorage } from './mode'

/**
 * Generic S3-compatible adapter for `@payloadcms/plugin-cloud-storage`.
 *
 * Provider-specific defaults (ArvanCloud path-style, R2 endpoint shape, …) live in
 * `storage-connections` rows and `src/storage/providers.ts`, not in this module.
 *
 * `disableLocalStorage: false` keeps the dev path working: with no enabled connection,
 * uploads stay on disk. When object storage is authoritative (`object_storage`), the local
 * temp copy is removed after a successful PutObject.
 */
export const s3ObjectStorageAdapter: Adapter = ({ collection, prefix = '' }) => ({
  name: 's3-object-storage',

  handleUpload: async ({ data, file, req }) => {
    const connection = await getActiveConnection(req)
    if (!shouldUseObjectStorage(connection)) return

    const { fileKey } = getFileKey({
      collectionPrefix: prefix,
      docPrefix: data.prefix,
      filename: file.filename,
    })

    await storageClient(connection!).send(
      new PutObjectCommand({
        Body: file.tempFilePath ? createReadStream(file.tempFilePath) : file.buffer,
        Bucket: connection!.bucket,
        ContentType: file.mimeType,
        Key: fileKey,
      }),
    )

    if (shouldDropLocalMirrorAfterUpload(connection!) && file.tempFilePath) {
      try {
        await unlink(file.tempFilePath)
      } catch {
        // Non-fatal: the authoritative copy is already in the bucket.
      }
    }

    return
  },

  handleDelete: async ({ doc, filename, req }) => {
    const connection = await getActiveConnection(req)
    if (!shouldUseObjectStorage(connection)) return

    const { fileKey } = getFileKey({
      collectionPrefix: prefix,
      docPrefix: doc.prefix,
      filename,
    })

    await storageClient(connection!).send(
      new DeleteObjectCommand({ Bucket: connection!.bucket, Key: fileKey }),
    )
  },

  staticHandler: (async (req, { headers, params }) => {
    const connection = await getActiveConnection(req)
    if (!shouldUseObjectStorage(connection)) return undefined as unknown as Response

    const { filename, prefix: prefixQueryParam, clientUploadContext } = params
    const client = storageClient(connection!)
    const docPrefix = await getFilePrefix({
      clientUploadContext,
      collection,
      filename,
      prefixQueryParam,
      req,
    })
    const { fileKey } = getFileKey({
      collectionPrefix: prefix,
      docPrefix,
      filename,
    })

    const abortController = new AbortController()
    if (req.signal) {
      req.signal.addEventListener('abort', () => abortController.abort())
    }

    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: connection!.bucket, Key: fileKey }),
      )

      const fileSize = head.ContentLength
      if (!fileSize) return new Response('Internal Server Error', { status: 500 })

      const rangeHeader = req.headers.get('range')
      const rangeResult = getRangeRequestInfo({ fileSize, rangeHeader })
      if (rangeResult.type === 'invalid') {
        return new Response(null, { headers: new Headers(rangeResult.headers), status: rangeResult.status })
      }

      const range =
        rangeResult.type === 'partial'
          ? `bytes=${rangeResult.rangeStart}-${rangeResult.rangeEnd}`
          : undefined

      const responseHeaders = new Headers(headers)
      for (const [header, value] of Object.entries(rangeResult.headers)) {
        responseHeaders.append(header, value)
      }
      responseHeaders.append('Content-Type', String(head.ContentType ?? 'application/octet-stream'))
      if (head.ETag) responseHeaders.append('ETag', head.ETag)

      if (head.ContentType === 'image/svg+xml') {
        responseHeaders.append('Content-Security-Policy', "script-src 'none'")
      }

      const incomingEtag = req.headers.get('etag') ?? req.headers.get('if-none-match')
      if (incomingEtag && incomingEtag === head.ETag) {
        return new Response(null, { headers: responseHeaders, status: 304 })
      }

      const object = await client.send(
        new GetObjectCommand({ Bucket: connection!.bucket, Key: fileKey, Range: range }),
        { abortSignal: abortController.signal },
      )

      if (!object.Body) return new Response(null, { status: 404, statusText: 'Not Found' })

      return new Response(object.Body as ReadableStream, {
        headers: responseHeaders,
        status: rangeResult.status,
      })
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        ('name' in err && (err.name === 'NoSuchKey' || err.name === 'NotFound') ||
          ('httpStatusCode' in err && err.httpStatusCode === 404))
      ) {
        return new Response(null, { status: 404, statusText: 'Not Found' })
      }
      req.payload.logger.error(err)
      return new Response('Internal Server Error', { status: 500 })
    }
  }) as StaticHandler,
})

/** @deprecated Use `s3ObjectStorageAdapter`. Kept for imports that have not migrated yet. */
export const arvanCloudAdapter = s3ObjectStorageAdapter
