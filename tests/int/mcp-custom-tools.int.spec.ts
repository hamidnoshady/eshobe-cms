import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { MCP_KEY_CONTEXT } from '@/mcp/context'
import { mcpTools } from '@/mcp/tools'

/**
 * The custom tools, called the way the plugin calls them: `(args, req)`.
 *
 * These are unit tests around a stubbed `payload.find`, which is the right scope for
 * them — argument validation, the field allowlist and the mapping are this repo's
 * code, while "the tenant scope applies" is the multi-tenant plugin's property and is
 * proven over HTTP in `tests/e2e/mcp.e2e.spec.ts`. The stub also asserts *how* the
 * read is made (`overrideAccess: false`), because that is the one line whose removal
 * would turn every custom tool into a cross-tenant reader and still look green here
 * if it were only asserted on results.
 */

const tool = (name: string) => {
  const found = mcpTools.find((entry) => entry.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

const text = (result: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(result.content[0]!.text) as Record<string, unknown>

const reqWith = (
  find: ReturnType<typeof vi.fn>,
  context: Record<string, unknown> = {},
): PayloadRequest =>
  ({
    context,
    payload: {
      config: {
        localization: {
          defaultLocale: 'fa',
          locales: [{ code: 'fa' }, { code: 'en' }],
        },
      },
      find,
      logger: { error: vi.fn() },
    },
  }) as unknown as PayloadRequest

/** The first argument a stubbed `payload.find` was called with. */
const firstCallArg = (mock: { mock: { calls: unknown[][] } }): Record<string, unknown> =>
  mock.mock.calls[0]?.[0] as Record<string, unknown>

describe('cms_describe_capabilities', () => {
  it('lists the configured surface when no key grants are on the request', async () => {
    const req = reqWith(vi.fn())
    const body = text(await tool('cms_describe_capabilities').handler({}, req))

    expect(body.ok).toBe(true)
    const data = body.data as {
      collections: Array<{ collection: string; toolNames: string[] }>
      languages: { defaultLocale: string; locales: string[] }
      tools: string[]
    }

    expect(data.languages).toEqual({ defaultLocale: 'fa', locales: ['fa', 'en'] })
    expect(data.tools).toContain('cms_describe_capabilities')

    const pages = data.collections.find((entry) => entry.collection === 'pages')
    expect(pages?.toolNames).toEqual(['findPages', 'createPages', 'updatePages'])

    // Never advertised, never callable.
    for (const forbidden of ['users', 'api-keys', 'payment-gateways', 'audit-log']) {
      expect(data.collections.map((entry) => entry.collection)).not.toContain(forbidden)
    }
  })

  it('narrows to what this key was granted', async () => {
    const req = reqWith(vi.fn(), {
      [MCP_KEY_CONTEXT]: {
        capabilities: {
          pages: { find: true },
          'payload-mcp-tool': { cmsDescribeCapabilities: true },
        },
        id: 'key-9',
        label: 'read only',
      },
    })

    const body = text(await tool('cms_describe_capabilities').handler({}, req))
    const data = body.data as {
      collections: Array<{
        collection: string
        grantedOperations: string[]
        toolNames: string[]
      }>
      tools: string[]
    }

    const pages = data.collections.find((entry) => entry.collection === 'pages')
    expect(pages?.grantedOperations).toEqual(['find'])
    expect(pages?.toolNames).toEqual(['findPages'])
    expect(data.tools).toEqual(['cmsDescribeCapabilities'])
  })
})

describe('cms_site_context', () => {
  it('reads access-controlled and returns only the allowlisted fields', async () => {
    const find = vi.fn(async () => ({
      docs: [
        {
          availableLocales: ['fa', 'en'],
          defaultLocale: 'fa',
          domain: 'acme.localhost',
          domainVerified: true,
          id: 'site-1',
          name: 'Acme',
          status: 'active',
          type: 'business',
          // Present on the document, and not this tool's business.
          billingCustomerId: 'cus_123',
          renderedBy: 'platform',
        },
      ],
    }))

    const body = text(await tool('cms_site_context').handler({}, reqWith(find)))
    expect(body.ok).toBe(true)

    const call = firstCallArg(find)
    expect(call).toMatchObject({ collection: 'sites', overrideAccess: false, req: expect.anything() })
    // `select` is the allowlist: without it the whole sites document ships.
    expect(Object.keys(call.select as Record<string, boolean>).sort()).toEqual([
      'availableLocales',
      'defaultLocale',
      'domain',
      'domainVerified',
      'name',
      'status',
      'type',
    ])

    const sites = (body.data as { sites: Array<Record<string, unknown>> }).sites
    expect(Object.keys(sites[0]!).sort()).toEqual([
      'availableLocales',
      'defaultLocale',
      'domain',
      'domainVerified',
      'id',
      'name',
      'status',
      'type',
    ])
  })

  it('answers with a coarse refusal when the read is denied', async () => {
    const find = vi.fn(async () => {
      throw new Error('Access denied for collection sites by tenant 4f0c')
    })

    const body = text(await tool('cms_site_context').handler({}, reqWith(find)))
    expect(body.ok).toBe(false)
    expect(body.error).toMatchObject({ code: 'not_permitted' })
    // The underlying message names a tenant; a client must not receive it.
    expect(JSON.stringify(body)).not.toContain('tenant 4f0c')
  })
})

describe('cms_content_status', () => {
  const req = () =>
    reqWith(
      vi.fn(async () => ({
        docs: [
          {
            _status: 'published',
            id: 'page-1',
            publishedAt: '2026-01-01T00:00:00.000Z',
            slug: 'about',
            title: 'درباره ما',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            _status: 'draft',
            id: 'page-2',
            publishedAt: '2099-01-01T00:00:00.000Z',
            slug: 'launch',
            title: 'رونمایی',
            updatedAt: '2026-02-01T00:00:00.000Z',
          },
          {
            _status: 'draft',
            id: 'page-3',
            publishedAt: null,
            slug: 'notes',
            title: null,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
        totalDocs: 3,
      })),
    )

  it('rejects an argument list that is not the documented shape', async () => {
    const body = text(await tool('cms_content_status').handler({ collection: 'users' }, req()))
    expect(body.error).toMatchObject({ code: 'invalid_input' })
  })

  it('rejects an out-of-range limit', async () => {
    const body = text(
      await tool('cms_content_status').handler({ collection: 'pages', limit: 500 }, req()),
    )
    expect(body.error).toMatchObject({ code: 'invalid_input' })
  })

  it('reports published, draft and scheduled-for-later in one shape', async () => {
    const request = req()
    const body = text(
      await tool('cms_content_status').handler({ collection: 'pages', limit: 10 }, request),
    )

    expect(body.ok).toBe(true)
    const data = body.data as {
      documents: Array<{ id: string; scheduledForFuture: boolean; status: string; title: unknown }>
      totalDocs: number
    }
    expect(data.totalDocs).toBe(3)
    expect(data.documents.map((doc) => [doc.id, doc.status, doc.scheduledForFuture])).toEqual([
      ['page-1', 'published', false],
      ['page-2', 'draft', true],
      ['page-3', 'draft', false],
    ])

    const call = firstCallArg(request.payload.find as unknown as { mock: { calls: unknown[][] } })
    expect(call).toMatchObject({
      collection: 'pages',
      draft: true,
      limit: 10,
      overrideAccess: false,
      sort: '-updatedAt',
    })
  })

  it('passes a status filter through as a where clause', async () => {
    const request = req()
    await tool('cms_content_status').handler({ collection: 'posts', status: 'draft' }, request)

    const call = firstCallArg(request.payload.find as unknown as { mock: { calls: unknown[][] } })
    expect(call.collection).toBe('posts')
    expect(call.where).toEqual({ _status: { equals: 'draft' } })
  })

  it('answers with a coarse refusal when the read is denied', async () => {
    const denied = reqWith(
      vi.fn(async () => {
        throw new Error('You are not allowed to perform this action.')
      }),
    )

    const body = text(
      await tool('cms_content_status').handler({ collection: 'pages' }, denied),
    )
    expect(body.ok).toBe(false)
    expect(body.error).toMatchObject({ code: 'not_permitted' })
  })
})
