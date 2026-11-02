import type { CollectionBeforeValidateHook } from 'payload'

import { createHash } from 'node:crypto'

import { validateSourceBaseUrlSyntax } from '@/lib/wordpress/source-url'

import { failField, siteIdOfWrite } from './contentSameSite'

/** The stable fingerprint until discovery replaces it with the source's own home/url pair. */
export const migrationInstallationFingerprint = (parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex')

/**
 * Normalize + uniquify a WordPress source per site.
 *
 * `installation` is one segment of every idempotency key, so two source rows
 * for the same installation on one site would make "re-run creates zero
 * duplicates" depend on which row the operator picked. One row per
 * (site, installation); reconnecting the same WordPress updates that row.
 */
export const validateMigrationSource: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>

  if (typeof row.baseUrl === 'string') {
    const checked = validateSourceBaseUrlSyntax(row.baseUrl)

    if (!checked.ok) {
      failField(collection, req, [{ message: checked.message, path: 'baseUrl' }])
    } else {
      row.baseUrl = checked.baseUrl
    }
  }

  const baseUrl = typeof row.baseUrl === 'string' ? row.baseUrl : stored.baseUrl

  if (!row.installation && !stored.installation && typeof baseUrl === 'string' && baseUrl) {
    row.installation = migrationInstallationFingerprint([baseUrl])
  }

  const siteId = siteIdOfWrite(row, stored)
  const installation =
    typeof row.installation === 'string' && row.installation
      ? row.installation
      : typeof stored.installation === 'string'
        ? stored.installation
        : null

  if (siteId && installation) {
    const { docs } = await req.payload.find({
      collection: 'migration-sources',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      req,
      select: { installation: true },
      where: {
        and: [{ site: { equals: siteId } }, { installation: { equals: installation } }],
      },
    })
    const clash = docs.find((doc) => String(doc.id) !== String(stored.id ?? ''))

    if (clash) {
      failField(collection, req, [
        {
          message: 'این نصب وردپرس برای همین سایت از قبل ثبت شده است؛ همان مبدأ را ویرایش کنید.',
          path: 'installation',
        },
      ])
    }
  }

  return data
}
