// @vitest-environment node
import type { PayloadRequest } from 'payload'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { revalidateSiteGlobalDelete } from '@/hooks/revalidateSiteGlobal'
import * as rendererWebhook from '@/lib/renderer-webhook'

describe('revalidateSiteGlobalDelete', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('notifies external renderers when a tenant-global row is deleted', async () => {
    const notify = vi.spyOn(rendererWebhook, 'notifyRenderers').mockImplementation(() => undefined)
    const hook = revalidateSiteGlobalDelete('branding')
    const req = {
      context: {},
      payload: { logger: { info: () => undefined, warn: () => undefined } },
    } as unknown as PayloadRequest

    await hook({
      collection: { slug: 'site-branding' } as never,
      context: {},
      doc: { id: 'b1', site: 'site-1' },
      id: 'b1',
      req,
    })

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: ['branding'],
        siteId: 'site-1',
        tags: ['site:site-1:branding'],
      }),
    )
  })

  it('skips when disableRevalidate is set', async () => {
    const notify = vi.spyOn(rendererWebhook, 'notifyRenderers').mockImplementation(() => undefined)
    const hook = revalidateSiteGlobalDelete('media')
    const req = {
      context: { disableRevalidate: true },
      payload: { logger: { info: () => undefined, warn: () => undefined } },
    } as unknown as PayloadRequest

    await hook({
      collection: { slug: 'media' } as never,
      context: {},
      doc: { id: 'm1', site: 'site-1' },
      id: 'm1',
      req,
    })

    expect(notify).not.toHaveBeenCalled()
  })
})
