import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import type { Plugin } from 'payload'

import { s3ObjectStorageAdapter } from '@/storage/adapter'

/**
 * Tenant media on ArvanCloud Object Storage, configured by a superadmin.
 *
 * This replaced the Cloudflare R2 setup that read `R2_*` environment variables. The
 * connection now lives in the platform-admin-only `storage-connections` collection —
 * endpoint, bucket, region and an encrypted secret key entered once in the admin UI — and
 * `src/storage/adapter.ts` resolves it at request time. A tenant's site needs no
 * configuration of its own: every site's files land in the same bucket under
 * `sites/<id>/media` (see `src/hooks/mediaPrefix.ts`).
 *
 * Two details carry the old behaviour forward on purpose:
 *
 * - `prefix: ''` forces the `prefix` column into the media schema with an empty default, so
 *   dev, test and production never drift apart. (It must be `prefix`, not the plugin's
 *   `alwaysInsertFields` flag — the latter only inserts the field on the *disabled* path, and
 *   this plugin is always enabled.) The real per-site value is stamped by `setMediaPrefix`
 *   (`src/hooks/mediaPrefix.ts`); a static collection prefix would fight it.
 * - `disableLocalStorage: false` keeps Payload writing to `Media.staticDir` too. That is
 *   what makes the local-dev path work: with no enabled connection the adapter no-ops on
 *   upload and returns `undefined` from its static handler, and Payload serves the file from
 *   disk exactly as it did before R2. With a connection enabled, files also go to ArvanCloud
 *   and are served from there.
 */
export const storage: Plugin = cloudStoragePlugin({
  collections: {
    media: {
      adapter: s3ObjectStorageAdapter,
      disableLocalStorage: false,
      prefix: '',
    },
  },
})
