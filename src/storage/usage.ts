import type { PayloadRequest } from 'payload'

export type StorageUsageReport = {
  /** Sum of `filesize` on media rows (bytes), when the field is populated. */
  databaseBytesKnown: number
  databaseBytesUnknownCount: number
  lastUploadAt: string | null
  mediaItems: number
  /** Per-tenant breakdown using the `prefix` column (`sites/<id>/…`). */
  bySite: { bytesKnown: number; items: number; siteId: string }[]
}

const siteIdFromPrefix = (prefix: string | null | undefined): string | null => {
  if (!prefix || typeof prefix !== 'string') return null
  const match = /^sites\/([^/]+)\//.exec(prefix)
  return match?.[1] ?? null
}

/** Operational visibility from Postgres — not provider-reported bucket usage. */
export const storageUsageReport = async (req: PayloadRequest): Promise<StorageUsageReport> => {
  const { docs, totalDocs } = await req.payload.find({
    collection: 'media',
    depth: 0,
    limit: 5000,
    overrideAccess: true,
    pagination: false,
    req,
    select: { createdAt: true, filesize: true, prefix: true, site: true },
    sort: '-createdAt',
  })

  let databaseBytesKnown = 0
  let databaseBytesUnknownCount = 0
  let lastUploadAt: string | null = null

  const bySiteMap = new Map<string, { bytesKnown: number; items: number }>()

  for (const doc of docs as {
    createdAt?: string
    filesize?: number | null
    prefix?: string | null
    site?: string | { id?: string } | null
  }[]) {
    if (!lastUploadAt && doc.createdAt) lastUploadAt = doc.createdAt

    const size = typeof doc.filesize === 'number' ? doc.filesize : null
    if (size === null) databaseBytesUnknownCount += 1
    else databaseBytesKnown += size

    const siteId =
      typeof doc.site === 'string'
        ? doc.site
        : doc.site && typeof doc.site === 'object' && doc.site.id
          ? String(doc.site.id)
          : siteIdFromPrefix(doc.prefix)

    if (siteId) {
      const current = bySiteMap.get(siteId) ?? { bytesKnown: 0, items: 0 }
      current.items += 1
      if (size !== null) current.bytesKnown += size
      bySiteMap.set(siteId, current)
    }
  }

  return {
    bySite: [...bySiteMap.entries()]
      .map(([siteId, stats]) => ({ siteId, ...stats }))
      .sort((a, b) => b.items - a.items),
    databaseBytesKnown,
    databaseBytesUnknownCount,
    lastUploadAt,
    mediaItems: totalDocs,
  }
}
