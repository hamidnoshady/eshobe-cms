import type { Endpoint, PayloadRequest } from 'payload'

/**
 * Admin handoff — `POST /api/handoff` or `GET /api/handoff`
 *
 * The builder (separate app, separate origin) holds the human's session and
 * needs to land them in the CMS admin without the human typing a second
 * password. This is the redirect-handoff shape recommended in `WAVE-9.md` §4.2:
 *
 *   1. The builder authenticates the human itself (it owns accounts).
 *   2. It obtains a short-lived assertion — here the user's `payload-token`
 *      obtained via the builder's service key — and POSTs it to this endpoint
 *      on the *CMS* origin. The browser follows the redirect, so the
 *      `Set-Cookie` in the response lands on the CMS host, where `Host` can
 *      resolve the tenant.
 *   3. This endpoint verifies the token via `payload.auth`, sets the same
 *      `payload-token` cookie with `SameSite=None` (cross-site iframe/admin),
 *      and redirects into `/admin`.
 *
 * The same contract as `src/app/(site)/next/preview/route.ts`, but for the
 * control-plane admin rather than a customer's site preview. The token is the
 * Payload JWT; the secret check prevents anonymous cookie planting.
 *
 * `GET` is supported for the redirect itself (the builder may `Location:` the
 * browser after the POST); `POST` is the form-hand-off. Both require either
 * `?token=` or `Authorization: Bearer` plus the shared `PREVIEW_SECRET` (or
 * `HANDOFF_SECRET` if set) to keep the shape symmetric with `/next/preview`.
 */
const handler: Endpoint['handler'] = async (req: PayloadRequest) => {
  const payload = req.payload

  const url = new URL(req.url ?? 'http://localhost/api/handoff')
  const searchParams = url.searchParams

  // Support both GET query and POST JSON body
  let token: string | null = searchParams.get('token')
  let redirectTo: string | null = searchParams.get('redirect')
  let secret: string | null = searchParams.get('secret') ?? searchParams.get('previewSecret')

  if (req.method === 'POST') {
    try {
      const body = (req.data ?? (await (req as unknown as { json?: () => Promise<Record<string, unknown>> }).json?.())) as
        | Record<string, unknown>
        | undefined
      if (body) {
        token = (body.token as string) ?? token
        redirectTo = (body.redirect as string) ?? (body.redirectTo as string) ?? redirectTo
        secret = (body.secret as string) ?? (body.previewSecret as string) ?? secret
      }
    } catch {
      // body parsing is best-effort; query params remain
    }

    // Also check Authorization header as fallback
    if (!token) {
      const auth = req.headers.get('authorization')
      if (auth?.toLowerCase().startsWith('bearer ')) token = auth.slice(7)
    }
  } else if (!token) {
    const auth = req.headers.get('authorization')
    if (auth?.toLowerCase().startsWith('bearer ')) token = auth.slice(7)
  }

  const expectedSecret = process.env.HANDOFF_SECRET ?? process.env.PREVIEW_SECRET

  if (expectedSecret && secret != null && secret !== expectedSecret) {
    return Response.json({ error: 'forbidden' }, { status: 403, headers: { 'cache-control': 'no-store' } })
  }

  if (!token) {
    return Response.json({ error: 'token required' }, { status: 400, headers: { 'cache-control': 'no-store' } })
  }

  const target = redirectTo && redirectTo.startsWith('/') ? redirectTo : '/admin'

  const tokenCookie = `${payload.config.cookiePrefix}-token`

  // Verify the token — same call `src/app/(site)/next/preview` uses
  let user
  try {
    const authResult = await payload.auth({
      headers: new Headers({ cookie: `${tokenCookie}=${token}` }),
      req: req as unknown as PayloadRequest,
    })
    user = authResult.user
  } catch (error) {
    payload.logger.error({ err: error }, 'handoff: token verification failed')
    return Response.json({ error: 'invalid token' }, { status: 403, headers: { 'cache-control': 'no-store' } })
  }

  if (!user) {
    return Response.json({ error: 'invalid token' }, { status: 403, headers: { 'cache-control': 'no-store' } })
  }

  // Set the cookie on the CMS origin and redirect. `SameSite=None` because the
  // builder is a different origin and the admin may be embedded (WAVE-9 §4.2).
  const headers = new Headers()
  // Use `Response.redirect` semantics manually so we can append Set-Cookie
  headers.set('location', target)
  // Cookie serialization — Payload's auth cookie is httpOnly; match that
  const cookie = `${tokenCookie}=${token}; Path=/; HttpOnly; SameSite=None; Secure`
  headers.set('set-cookie', cookie)

  return new Response(null, { status: 302, headers })
}

export const handoffEndpoint: Endpoint = {
  path: '/handoff',
  method: 'get',
  handler,
}

export const handoffPostEndpoint: Endpoint = {
  path: '/handoff',
  method: 'post',
  handler,
}
