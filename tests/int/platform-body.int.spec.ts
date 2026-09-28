// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { PayloadRequest } from 'payload'

import { readJsonBody } from '@/endpoints/platformShared'

// A real Request, because the bug lived in how a real (bodiless) POST reads.
const post = (body?: string) =>
  new Request('http://localhost/api/platform/sites/x/deployment/redeploy', {
    body,
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }) as unknown as PayloadRequest

describe('readJsonBody', () => {
  it('treats a POST with no body as {} — the console buttons that post nothing', async () => {
    expect(await readJsonBody(post())).toEqual({ body: {} })
    expect(await readJsonBody(post('   '))).toEqual({ body: {} })
  })

  it('parses a JSON object', async () => {
    expect(await readJsonBody(post('{"lane":"preview"}'))).toEqual({ body: { lane: 'preview' } })
  })

  it('still refuses malformed JSON and non-objects with a 400', async () => {
    const bad = await readJsonBody(post('{nope'))
    expect(bad.error?.status).toBe(400)
    const scalar = await readJsonBody(post('"text"'))
    expect(scalar.error?.status).toBe(400)
    expect(await scalar.error?.json()).toMatchObject({ ok: false })
  })

  it('falls back to req.json() for a hand-built request', async () => {
    const fake = { json: async () => ({ ref: 'main' }) } as Partial<PayloadRequest> as PayloadRequest
    expect(await readJsonBody(fake)).toEqual({ body: { ref: 'main' } })
  })
})
