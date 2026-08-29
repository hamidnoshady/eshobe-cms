import type { Plugin } from 'payload'

import { s3Storage } from '@payloadcms/storage-s3'

/**
 * Uploads to Cloudflare R2, namespaced per site.
 *
 * R2 speaks S3, so `@payloadcms/storage-s3` is the adapter — with three
 * R2-specific details that are easy to get wrong:
 *
 * - `region: 'auto'`. R2 has no regions, but the AWS SDK refuses to sign a request
 *   without one.
 * - **No ACL.** R2 rejects `x-amz-acl`; a bucket is public or it is not. Leaving
 *   `acl` unset is deliberate — setting `'public-read'` makes every upload fail.
 * - `forcePathStyle`. R2's endpoint is `<account>.r2.cloudflarestorage.com`, and the
 *   bucket is the first path segment, not a subdomain.
 *
 * `disablePayloadAccessControl` is left off on purpose: files keep being served
 * through `/api/media/file/*`, so the bucket stays private, the Caddy carve-out for
 * media keeps working, and `next/image`'s `localPatterns` still matches. The
 * `?prefix=` query the plugin appends to those URLs is allowed by that pattern — a
 * `localPatterns` entry with no `search` key matches any query string.
 */
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_BUCKET', 'R2_SECRET_ACCESS_KEY'] as const

type Env = Partial<Record<(typeof R2_VARS)[number] | 'R2_ENDPOINT', string | undefined>>

/**
 * All four credentials or none. A half-configured bucket is the dangerous state:
 * the plugin would take over the collection and then fail on every upload, so the
 * adapter is only enabled when it can actually work, and local disk storage
 * (`Media.staticDir`) stays in charge otherwise.
 */
export const r2Configured = (env: Env = process.env): boolean =>
  R2_VARS.every((key) => Boolean(env[key]))

export const r2Endpoint = (env: Env = process.env): string =>
  env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`

export const storage: Plugin = s3Storage({
  /**
   * The `prefix` column exists whether or not R2 is configured. Without this the
   * media table's schema would depend on an environment variable — dev would drift
   * from production and the committed migration would describe neither.
   */
  alwaysInsertFields: true,
  bucket: process.env.R2_BUCKET ?? '',
  collections: {
    media: true,
  },
  config: {
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
    endpoint: r2Endpoint(),
    forcePathStyle: true,
    region: 'auto',
  },
  enabled: r2Configured(),
})
