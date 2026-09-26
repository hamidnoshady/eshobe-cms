// @vitest-environment node
import { createHmac } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { notifyRenderers, signRendererBody } from '@/lib/renderer-webhook'

/**
 * The v1 renderer revalidation signature, pinned byte for byte.
 *
 * `docs/THEME_API.md` §17 publishes it as `HMAC-SHA256(secret, rawBody)`, and every
 * theme deployed against contract v1 verifies it that way. The platform webhooks sign
 * `<timestamp>.<body>` instead, and this module's own header once said it did too —
 * which is exactly the kind of sentence a future edit "fixes" the code to match.
 * Doing so would not fail loudly: every deployed theme would reject every notice and
 * serve stale pages. A timestamped scheme is a v2 contract, made in the doc first.
 */

const SECRET = 'esrv_known_test_secret'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the renderer webhook signature (v1)', () => {
  it('is HMAC-SHA256 over the exact raw body, and not over "<timestamp>.<body>"', () => {
    const timestamp = '2026-09-25T12:00:00.000Z'
    const body = JSON.stringify({ paths: ['/acme.ir/fa/pricing'], siteId: 'site-1', timestamp })

    const expected = `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`
    const timestamped = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`

    expect(signRendererBody(SECRET, body)).toBe(expected)
    expect(signRendererBody(SECRET, body)).not.toBe(timestamped)
  })

  it('sends exactly that signature over exactly the bytes it posts, with the timestamp unsigned beside it', async () => {
    const sent: { body: string; headers: Record<string, string>; url: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ body: String(init.body), headers: init.headers as Record<string, string>, url })
      return new Response(null, { status: 204 })
    })
    vi.stubEnv('REVALIDATE_WEBHOOK_URL', 'https://renderer.example/revalidate')
    vi.stubEnv('PAYLOAD_SECRET', SECRET)

    // The global fallback target only: no deployments exist for this fake request.
    const req = {
      payload: {
        find: async () => ({ docs: [] }),
        logger: { warn: () => undefined },
      },
    } as unknown as PayloadRequest

    notifyRenderers({
      paths: ['/acme.ir/fa/pricing'],
      req,
      resources: ['page'],
      siteId: 'site-1',
      tags: ['site:site-1:page'],
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    const [delivery] = sent
    const timestamp = delivery!.headers['x-eshobe-timestamp']!
    expect(JSON.parse(delivery!.body)).toEqual({
      paths: ['/acme.ir/fa/pricing'],
      resources: ['page'],
      siteId: 'site-1',
      tags: ['site:site-1:page'],
      timestamp,
    })

    const expected = `sha256=${createHmac('sha256', SECRET).update(delivery!.body, 'utf8').digest('hex')}`
    const timestamped = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${delivery!.body}`, 'utf8').digest('hex')}`
    expect(delivery!.headers['x-eshobe-signature']).toBe(expected)
    expect(delivery!.headers['x-eshobe-signature']).not.toBe(timestamped)
  })
})
