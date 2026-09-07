import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { Adapter, StaticHandler } from '@payloadcms/plugin-cloud-storage/types'
import { getFileKey, getFilePrefix } from '@payloadcms/plugin-cloud-storage/utilities'
import { createReadStream } from 'node:fs'

import { getRangeRequestInfo } from 'payload/internal'

import { getActiveConnection, storageClient } from './connection'

/**
 * The ArvanCloud Object Storage adapter for `@payloadcms/plugin-cloud-storage`.
 *
 * ArvanCloud speaks the S3 API (`https://s3.ir-thr-at1.arvanstorage.ir`), so this is the
 * same shape as the S3 adapter — with the three ArvanCloud specifics that are easy to get
 * wrong:
 *
 * - **Path-style.** The bucket is a path segment, never a subdomain, so `forcePathStyle`
 *   stays on.
 * - **`region: 'default'`.** ArvanCloud has no real regions, but the AWS SDK refuses to
 *   sign without one; `default` is what ArvanCloud's own SDK examples use.
 * - **No ACL.** Like R2, the bucket is public or it is not. We serve everything through
 *   `/api/media/file/*` (the Caddy carve-out), so the bucket stays private and no
 *   `x-amz-acl` is ever sent.
 *
 * `disablePayloadAccessControl` stays off on purpose: `media.url` remains
 * `/api/media/file/<filename>?prefix=…`, the bucket stays private, and `next/image`'s
 * `localPatterns` keeps matching. The adapter's `generateURL` is therefore never called and
 * is deliberately omitted.
 *
 * **Local-disk fallback.** The plugin runs with `disableLocalStorage: false`, so Payload
 * always writes the file to `Media.staticDir` too. When no connection is enabled (a fresh
 * dev checkout, or before the superadmin has configured storage), `handleUpload` is a no-op
 * and `staticHandler` returns `undefined` — which makes Payload's file route fall through to
 * its own local filesystem serving. When a connection *is* enabled, files go to ArvanCloud
 * and are streamed from there.
 */
export const arvanCloudAdapter: Adapter = ({ collection, prefix = '' }) => ({
  name: 'arvancloud-object-storage',

  handleUpload: async ({ data, file, req }) => {
    const connection = await getActiveConnection(req)
    // No enabled connection: the file already landed on local disk (disableLocalStorage is
    // false), so there is nothing to do.
    if (!connection) return

    const { fileKey } = getFileKey({
      collectionPrefix: prefix,
      docPrefix: data.prefix,
      filename: file.filename,
    })

    await storageClient(connection).send(
      new PutObjectCommand({
        Body: file.tempFilePath ? createReadStream(file.tempFilePath) : file.buffer,
        Bucket: connection.bucket,
        ContentType: file.mimeType,
        Key: fileKey,
      }),
    )

    // Nothing to persist back: the upload is a side effect, and `media.url` stays
    // `/api/media/file/*` (no signed URL to store). Returning the doc would make the
    // plugin re-update it with itself — harmless but a wasted write.
    return
  },

  handleDelete: async ({ doc, filename, req }) => {
    const connection = await getActiveConnection(req)
    if (!connection) return

    const { fileKey } = getFileKey({
      collectionPrefix: prefix,
      docPrefix: doc.prefix,
      filename,
    })

    await storageClient(connection).send(
      new DeleteObjectCommand({ Bucket: connection.bucket, Key: fileKey }),
    )
  },

  staticHandler: (async (req, { headers, params }) => {
    const connection = await getActiveConnection(req)
    // Fall through to Payload's local filesystem serving (see module comment). The
    // runtime honours a non-Response return as "fall through"; the `StaticHandler` type
    // just does not express it.
    if (!connection) return undefined as unknown as Response

    const { filename, prefix: prefixQueryParam, clientUploadContext } = params
    const client = storageClient(connection)
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
        new HeadObjectCommand({ Bucket: connection.bucket, Key: fileKey }),
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

      // Uploads are allow-listed to raster images, but keep the belt-and-braces guard the
      // S3 adapter ships: an SVG must never execute if one ever reaches the bucket.
      if (head.ContentType === 'image/svg+xml') {
        responseHeaders.append('Content-Security-Policy', "script-src 'none'")
      }

      const incomingEtag = req.headers.get('etag') ?? req.headers.get('if-none-match')
      if (incomingEtag && incomingEtag === head.ETag) {
        return new Response(null, { headers: responseHeaders, status: 304 })
      }

      const object = await client.send(
        new GetObjectCommand({ Bucket: connection.bucket, Key: fileKey, Range: range }),
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
