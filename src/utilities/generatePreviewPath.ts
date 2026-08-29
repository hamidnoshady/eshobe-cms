import type { PayloadRequest } from 'payload'

import { parseCookies } from 'payload/shared'

import type { PreviewSearchParams } from '@/app/(site)/next/preview/route'

import { siteUrlForDoc } from '@/lib/site-url'

type Props = {
  /** The collection's route prefix — `POSTS_BASE` for posts, empty for pages. */
  base?: string
  data?: Record<string, unknown> | null
  req: PayloadRequest
}

/**
 * Preview has to open on the *site's* own domain, not the admin's: the front end
 * resolves its tenant from the `Host` header, so a relative URL would render the
 * admin host — which belongs to no site — and 404.
 *
 * The path is the canonical one (`/about` on the site's default locale, `/en/about`
 * otherwise), so the editor previews the URL a visitor will actually be on.
 */
export const generatePreviewPath = async ({ base, data, req }: Props): Promise<string | null> => {
  const target = await siteUrlForDoc({ base, doc: data, req })

  if (!target) return null

  const params = new URLSearchParams({
    path: target.path,
    previewSecret: process.env.PREVIEW_SECRET || '',
    /**
     * The editor's own session token, handed across the origin boundary.
     *
     * The admin and the site are different origins, so the `payload-token` cookie
     * that authenticated *this* request is never sent to the preview: it is
     * host-only, and an iframe request is a cross-site context on top of that. So
     * `/next/preview` would see an anonymous request and answer 403 — the preview
     * pane would be that sentence.
     *
     * The iframe's `src` is the only channel between the two origins, and the
     * redirect at the far end drops the token from the document URL before anything
     * else on the page loads. `buildFormState` re-runs this on every field change,
     * so the token stays as fresh as the editor's session.
     */
    token: parseCookies(req.headers).get(`${req.payload.config.cookiePrefix}-token`) ?? '',
  } satisfies PreviewSearchParams)

  return `${target.origin}/next/preview?${params}`
}
