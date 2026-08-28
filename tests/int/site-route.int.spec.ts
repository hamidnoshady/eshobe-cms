import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'

import { consume, resetRateLimits } from '@/lib/rate-limit'
import { notifyRenderers } from '@/lib/renderer-webhook'
import { resolveSiteRoute } from '@/lib/site-route'

/**
 * The site's routing table and the two guards on the checkout endpoint.
 *
 * The resolver is pure, and that is the point: every route rule that lives inside a
 * `page.tsx` can only be tested through a browser, so the part that decides *which*
 * component a URL is — the part that broke `/en/checkout/<order>` — is tested here
 * instead, with no Next.js in the loop.
 */
describe('resolveSiteRoute', () => {
  it('resolves bare, locale-prefixed and default-locale forms to one route', () => {
    for (const path of [['posts'], ['en', 'posts'], ['fa', 'posts']]) {
      expect(resolveSiteRoute(path)).toEqual({ kind: 'posts' })
    }

    expect(resolveSiteRoute([])).toEqual({ kind: 'page', slug: 'home' })
    expect(resolveSiteRoute(['en'])).toEqual({ kind: 'page', slug: 'home' })
  })

  it('sends every non-reserved path to the page lookup, joined', () => {
    expect(resolveSiteRoute(['about'])).toEqual({ kind: 'page', slug: 'about' })
    expect(resolveSiteRoute(['en', 'about'])).toEqual({ kind: 'page', slug: 'about' })
    // Nested slugs keep working, exactly as before the resolver existed.
    expect(resolveSiteRoute(['fa', 'docs', 'intro'])).toEqual({ kind: 'page', slug: 'docs/intro' })
  })

  it('treats /posts/<x> as a post and /posts as the index', () => {
    expect(resolveSiteRoute(['posts', 'hello'])).toEqual({ kind: 'post', slug: 'hello' })
    expect(resolveSiteRoute(['en', 'posts', 'hello'])).toEqual({ kind: 'post', slug: 'hello' })
  })

  it('decodes a Persian slug before the CMS is asked for it', () => {
    expect(resolveSiteRoute(['posts', encodeURIComponent('سلام-dunya')])).toEqual({
      kind: 'post',
      slug: 'سلام-dunya',
    })
  })

  it('resolves the checkout receipt with and without a locale prefix', () => {
    // This is the bug the resolver exists to fix: `[domain]/checkout/[order]` as a
    // folder answered `/checkout/…` and 404'd `/en/checkout/…`, so an English-default
    // store had a confirmation link that only worked in Persian.
    const id = '0b64fcf8-be2a-47f7-bafc-46b84d73aa3b'

    expect(resolveSiteRoute(['checkout', id])).toEqual({ kind: 'checkout', order: id })
    expect(resolveSiteRoute(['en', 'checkout', id])).toEqual({ kind: 'checkout', order: id })
    // `/checkout` alone has no order to show.
    expect(resolveSiteRoute(['checkout'])).toEqual({ kind: 'checkout', order: null })
    // A deeper path is a page, not a checkout with extra segments.
    expect(resolveSiteRoute(['checkout', id, 'extra'])).toEqual({
      kind: 'page',
      slug: 'checkout/0b64fcf8-be2a-47f7-bafc-46b84d73aa3b/extra',
    })
  })

  it('does not treat a page named like a prefix as the route', () => {
    // `/posts` is the blog; `/posts-x` is a page, because matching is per segment and
    // not by string prefix.
    expect(resolveSiteRoute(['posts-x'])).toEqual({ kind: 'page', slug: 'posts-x' })
    expect(resolveSiteRoute(['search', 'deep'])).toEqual({ kind: 'page', slug: 'search/deep' })
  })
})

describe('checkout rate limit', () => {
  beforeAll(() => {
    resetRateLimits()
  })

  afterAll(() => {
    resetRateLimits()
  })

  it('allows up to the limit and refuses past it, with a retry hint', () => {
    const key = 'test:ip'

    for (let i = 0; i < 3; i++) {
      expect(consume({ key, limit: 3, now: 1_000, windowMs: 60_000 }).allowed).toBe(true)
    }

    const denied = consume({ key, limit: 3, now: 1_000, windowMs: 60_000 })

    // The window opened on the first call at `now: 1_000`, so 60s remain — counted from
    // the window's start, not from the moment of refusal.
    expect(denied).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  it('counts each key separately — one spray does not lock out the whole site', () => {
    resetRateLimits()

    expect(consume({ key: 'a', limit: 1, now: 0, windowMs: 1_000 }).allowed).toBe(true)
    expect(consume({ key: 'b', limit: 1, now: 0, windowMs: 1_000 }).allowed).toBe(true)
    expect(consume({ key: 'a', limit: 1, now: 0, windowMs: 1_000 }).allowed).toBe(false)
  })

  it('reopens the window after it expires, so a block is temporary by construction', () => {
    resetRateLimits()

    expect(consume({ key: 'c', limit: 1, now: 0, windowMs: 1_000 }).allowed).toBe(true)
    expect(consume({ key: 'c', limit: 1, now: 500, windowMs: 1_000 }).allowed).toBe(false)
    expect(consume({ key: 'c', limit: 1, now: 1_500, windowMs: 1_000 }).allowed).toBe(true)
  })

  it('never blocks when the limit is switched off (0)', () => {
    resetRateLimits()

    for (let i = 0; i < 5; i++) {
      expect(consume({ key: 'd', limit: 0, now: 0, windowMs: 1_000 }).allowed).toBe(true)
    }
  })
})

describe('renderer webhook', () => {
  const received: { body: string; signature: string }[] = []

  let server: ReturnType<typeof createServer>
  let url = ''
  const previous = { secret: process.env.PAYLOAD_SECRET, webhook: process.env.REVALIDATE_WEBHOOK_URL }

  beforeAll(async () => {
    process.env.PAYLOAD_SECRET = 'webhook-test-secret'

    server = createServer((req, res) => {
      const chunks: Buffer[] = []

      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString(),
          signature: req.headers['x-eshobe-signature'] as string,
        })

        res.statusCode = 200
        res.end('{}')
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`
    process.env.REVALIDATE_WEBHOOK_URL = url
  })

  afterAll(async () => {
    process.env.PAYLOAD_SECRET = previous.secret
    process.env.REVALIDATE_WEBHOOK_URL = previous.webhook

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('signs the exact bytes it sends, so the receiver can verify before purging', async () => {
    const logger = { warn: () => {}, info: () => {}, error: () => {} }

    notifyRenderers({
      paths: ['/acme.localhost/pricing', '/acme.localhost/en/pricing'],
      req: { payload: { logger } } as never,
      siteId: 'site-1',
    })

    // Fire-and-forget by design, so the test waits for the receiver rather than a promise.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(received).toHaveLength(1)

    const [{ body, signature }] = received

    expect(JSON.parse(body).paths).toEqual([
      '/acme.localhost/pricing',
      '/acme.localhost/en/pricing',
    ])
    expect(signature).toBe(
      `sha256=${createHmac('sha256', 'webhook-test-secret').update(body).digest('hex')}`,
    )
  })

  it('sends nothing when no renderer is configured, so the default is silent', () => {
    process.env.REVALIDATE_WEBHOOK_URL = ''

    const before = received.length

    notifyRenderers({
      paths: ['/x'],
      req: { payload: { logger: { warn: () => {}, info: () => {}, error: () => {} } } } as never,
      siteId: 'site-1',
    })

    expect(received.length).toBe(before)
  })
})
