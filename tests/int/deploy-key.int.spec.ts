// @vitest-environment node
import type { Payload } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { mintSiteKey } from '@/deploy/service'
import { hashApiKey } from '@/lib/api-keys'

/**
 * The key a deployment hands its theme has to be the key the CMS will accept.
 *
 * `api-keys` mints its own key in `beforeValidate` and discards whatever a caller
 * passes, so a deploy that generated its own value shipped the theme a credential
 * whose hash matched no row. Public reads still worked, which is why nothing failed
 * loudly — only draft reads and key-only routes did.
 */
describe('mintSiteKey', () => {
  let payload: Payload
  const created: string[] = []

  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  afterAll(async () => {
    for (const id of created) {
      await payload.delete({ collection: 'api-keys', id, overrideAccess: true })
    }
  })

  it('returns the raw value whose hash is the one stored', async () => {
    const site = (
      await payload.find({ collection: 'sites', depth: 0, limit: 1, overrideAccess: true })
    ).docs[0] as unknown as Record<string, unknown>
    expect(site, 'run `pnpm seed` first').toBeTruthy()

    const req = await createLocalReq({}, payload)
    const { id, raw } = await mintSiteKey(req, site, 'graphite')
    created.push(id)

    const match = await payload.find({
      collection: 'api-keys',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { keyHash: { equals: hashApiKey(raw) } },
    })

    expect(match.docs[0]?.id).toBe(id)
    // The raw value is handed over once and is not left lying on the request.
    expect(req.context.eshobeIssuedApiKey).toBeUndefined()
  })
})
