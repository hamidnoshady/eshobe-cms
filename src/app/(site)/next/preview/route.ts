import type { PayloadRequest } from 'payload'
import { getPayload } from 'payload'

import { cookies, draftMode } from 'next/headers'
import { redirect } from 'next/navigation'
import { NextRequest } from 'next/server'

import configPromise from '@payload-config'

export type PreviewSearchParams = {
  path: string
  previewSecret: string
  token: string
}

/**
 * Turns on draft mode for one editor, on one customer domain.
 *
 * Everything awkward here comes from the same fact: the admin is on one origin and
 * the site is on another, so no cookie the admin holds is sent to this request.
 * `token` carries the editor's session across that boundary (see
 * `generatePreviewPath`), and both cookies this route sets have to be
 * `SameSite=None` because the preview lives in a cross-site iframe.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const payload = await getPayload({ config: configPromise })

  const { searchParams } = new URL(req.url)

  const path = searchParams.get('path')
  const previewSecret = searchParams.get('previewSecret')
  const token = searchParams.get('token')

  if (previewSecret !== process.env.PREVIEW_SECRET) {
    return new Response('You are not allowed to preview this page', { status: 403 })
  }

  if (!path) {
    return new Response('Insufficient search params', { status: 404 })
  }

  if (!path.startsWith('/')) {
    return new Response('This endpoint can only be used for relative previews', { status: 500 })
  }

  const tokenCookie = `${payload.config.cookiePrefix}-token`

  let user

  try {
    const authResult = await payload.auth({
      req: req as unknown as PayloadRequest,
      // The handed-over token when there is one, this domain's own cookie otherwise —
      // which is what a second preview link in the same browser session uses.
      headers: token ? new Headers({ cookie: `${tokenCookie}=${token}` }) : req.headers,
    })
    user = authResult.user
  } catch (error) {
    payload.logger.error({ err: error }, 'Error verifying token for live preview')
    return new Response('You are not allowed to preview this page', { status: 403 })
  }

  const draft = await draftMode()

  if (!user) {
    draft.disable()
    return new Response('You are not allowed to preview this page', { status: 403 })
  }

  // Whose drafts this shows is not decided here: the page reads them through
  // `findForSite` with `overrideAccess: false` and this user, so an editor of one
  // site who points a preview link at another site's domain gets a 404.

  draft.enable()

  const jar = await cookies()

  /**
   * Next writes the draft-mode cookie `SameSite=Lax` in development and
   * `None; Secure` in production (`next/dist/server/async-storage/
   * draft-mode-provider.js`). `Lax` is not sent from inside a cross-site iframe at
   * all — not even on the redirect below — so in dev draft mode would already be off
   * by the time the page rendered, and the pane would show the *published* page. A
   * preview that looks like it works and never shows the edit.
   */
  const bypass = jar.get('__prerender_bypass')
  if (bypass) jar.set({ ...bypass, httpOnly: true, path: '/', sameSite: 'none', secure: true })

  if (token) {
    /**
     * The token again, as a cookie on this domain: live preview refreshes by
     * re-rendering on the server, and that RSC request carries cookies, not the
     * query string this one arrived with. A session cookie on purpose — the grant
     * should not outlive the browser.
     *
     * `secure` over plain http in dev is intentional and required by `SameSite=None`;
     * browsers treat `localhost` and `*.localhost` as trustworthy origins.
     */
    jar.set({
      httpOnly: true,
      name: tokenCookie,
      path: '/',
      sameSite: 'none',
      secure: true,
      value: token,
    })
  }

  redirect(path)
}
