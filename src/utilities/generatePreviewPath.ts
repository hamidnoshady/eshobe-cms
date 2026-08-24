import type { CollectionSlug, PayloadRequest } from 'payload'

import type { PreviewSearchParams } from '@/app/(site)/next/preview/route'

type Props = {
  collection: CollectionSlug
  data?: Record<string, unknown> | null
  req: PayloadRequest
  slug?: string | null
}

/**
 * Preview has to open on the *site's* own domain, not the admin's: the front end
 * resolves its tenant from the `Host` header, so a relative URL would render the
 * admin host — which belongs to no site — and 404.
 *
 * Returns null rather than a guessed URL when the document has no site or slug yet.
 * A preview button that goes nowhere is better than one that opens someone else's
 * domain.
 */
export const generatePreviewPath = async ({
  data,
  req,
  slug,
}: Props): Promise<string | null> => {
  const siteId = typeof data?.site === 'object' ? (data.site as { id?: string })?.id : data?.site

  if (!slug || !siteId) return null

  const site = await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: String(siteId),
    req,
  })

  if (!site?.domain) return null

  const params = new URLSearchParams({
    // The locale segment the front end parses back out; `req.locale` is the locale
    // the editor is currently editing in.
    path: `/${req.locale ?? site.defaultLocale}/${encodeURIComponent(slug)}`,
    previewSecret: process.env.PREVIEW_SECRET || '',
  } satisfies PreviewSearchParams)

  // Port included: dev serves every domain off one port, production off none.
  const port = new URL(req.origin || 'http://localhost:3000').port

  return `http://${site.domain}${port ? `:${port}` : ''}/next/preview?${params}`
}
