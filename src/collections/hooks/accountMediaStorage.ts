import type { CollectionAfterChangeHook, CollectionAfterDeleteHook } from 'payload'

import { idOf } from '@/lib/ids'
import { applyStorageLevel, storageBytesForSite, storedObjectBytes } from '@/billing/meters/storage-account'

/**
 * Keep the per-site byte total in step with media rows. The financial meter is
 * the time-weighted integral of that total, not a scan of the first 10k files.
 * A failure here is logged and does not fail the upload: the file is already
 * stored, and `recount` can rebuild the total.
 */
const levelAfter = async (
  req: Parameters<CollectionAfterChangeHook>[0]['req'],
  siteId: string,
  delta: number,
  createdBytes: number,
): Promise<void> => {
  const current = await storageBytesForSite(req, siteId)
  const next = current == null ? createdBytes : Math.max(0, current + delta)
  await applyStorageLevel(req, siteId, next)
}

export const accountMediaStorage: CollectionAfterChangeHook = async ({ doc, operation, previousDoc, req }) => {
  const siteId = idOf((doc as { site?: unknown }).site)
  if (!siteId) return doc
  try {
    const next = storedObjectBytes(doc as { filesize?: unknown; sizes?: Record<string, { filesize?: unknown }> })
    const prev =
      operation === 'create'
        ? 0
        : storedObjectBytes((previousDoc ?? {}) as { filesize?: unknown; sizes?: Record<string, { filesize?: unknown }> })
    if (operation !== 'create' && next === prev) return doc
    if (operation !== 'create' && (await storageBytesForSite(req, siteId)) == null) return doc
    await levelAfter(req, siteId, next - prev, next)
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'storage meter update failed' })
  }
  return doc
}

export const accountMediaStorageDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  const siteId = idOf((doc as { site?: unknown }).site)
  if (!siteId) return
  try {
    const current = await storageBytesForSite(req, siteId)
    if (current == null) return
    const removed = storedObjectBytes(doc as { filesize?: unknown; sizes?: Record<string, { filesize?: unknown }> })
    await applyStorageLevel(req, siteId, Math.max(0, current - removed))
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'storage meter delete failed' })
  }
}
