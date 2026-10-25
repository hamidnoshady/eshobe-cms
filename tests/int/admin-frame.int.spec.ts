// @vitest-environment node
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminFrameAncestors, EMBED_EXIT_COOKIE, embedExitCookies, isTopLevelNavigation } from '@/lib/adminFrame'
import { EMBED_MARKER_COOKIE } from '@/lib/embed'
import { proxy } from '@/proxy'

/**
 * The POS modal frames `/admin` from a sibling subdomain (`admin.app.eshobe.com` framing
 * `cms.eshobe.com`). Two production failures came from that arrangement:
 *
 *   - `frame-ancestors` was a build-time `next.config` header, so an image built without
 *     the repository variable could never be framed — the modal showed a broken frame;
 *   - the frame's partitioned cookies share a partition key with a top-level visit to the
 *     CMS, so `/admin` opened in a tab ran as the embed service user with the chrome
 *     hidden: one customer's dashboard, no sidebar, no logout.
 */
describe('admin framing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads frame-ancestors from the runtime environment and drops junk', () => {
    expect(adminFrameAncestors('', '')).toBe("frame-ancestors 'self'")
    expect(
      adminFrameAncestors('https://admin.app.eshobe.com/, javascript:alert(1), nope', 'https://pos.example.com'),
    ).toBe("frame-ancestors 'self' https://admin.app.eshobe.com https://pos.example.com")
    expect(adminFrameAncestors('https://a.example.com', 'https://a.example.com')).toBe(
      "frame-ancestors 'self' https://a.example.com",
    )
  })

  it('tells a top-level page from a frame and from an RSC fetch', () => {
    const h = (dest: string, mode: string) => new Headers({ 'sec-fetch-dest': dest, 'sec-fetch-mode': mode })
    expect(isTopLevelNavigation(h('document', 'navigate'))).toBe(true)
    expect(isTopLevelNavigation(h('iframe', 'navigate'))).toBe(false)
    expect(isTopLevelNavigation(h('empty', 'cors'))).toBe(false)
    expect(isTopLevelNavigation(new Headers())).toBe(false)
  })

  it('clears only the partitioned embed copies over https', () => {
    const cookies = embedExitCookies('payload-token', true)
    for (const name of ['payload-token', 'payload-tenant', EMBED_MARKER_COOKIE]) {
      const line = cookies.find((c) => c.startsWith(`${name}=;`))
      expect(line).toContain('Max-Age=0')
      expect(line).toContain('Partitioned')
      expect(line).toContain('SameSite=None')
    }
    expect(cookies.find((c) => c.startsWith(`${EMBED_EXIT_COOKIE}=1`))).toContain('Max-Age=10')
  })

  it('redirects a top-level /admin visit that carries the embed marker, once', () => {
    vi.stubEnv('ADMIN_EMBED_ORIGINS', 'https://admin.app.eshobe.com')
    const visit = (extraCookie = '', dest = 'document') =>
      proxy(
        new NextRequest('https://cms.eshobe.com/admin', {
          headers: {
            cookie: `payload-lng=fa; ${EMBED_MARKER_COOKIE}=1; payload-token=x${extraCookie}`,
            'sec-fetch-dest': dest,
            'sec-fetch-mode': 'navigate',
            'x-forwarded-proto': 'https',
          },
        }),
      )

    const leaked = visit()
    expect(leaked.status).toBe(307)
    expect(leaked.headers.get('location')).toBe('https://cms.eshobe.com/admin')
    expect(leaked.headers.getSetCookie().some((c) => c.startsWith(`${EMBED_MARKER_COOKIE}=;`))).toBe(true)

    // The frame itself is left alone and gets the runtime frame-ancestors.
    const framed = visit('', 'iframe')
    expect(framed.status).toBe(200)
    expect(framed.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://admin.app.eshobe.com",
    )

    // A browser that kept the cookie anyway is not redirected in a loop.
    expect(visit(`; ${EMBED_EXIT_COOKIE}=1`).status).toBe(200)
  })
})
