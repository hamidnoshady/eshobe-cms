import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, request, test, type APIRequestContext } from '@playwright/test'
import { randomBytes } from 'node:crypto'

/**
 * `/api/mcp` over real Streamable HTTP, driven by the official MCP SDK client.
 *
 * `tests/int/mcp.int.spec.ts` asserts the capability matrix as data and
 * `tests/int/mcp-tools.int.spec.ts` asserts the gate and the custom tools against
 * stubs. Neither can see the three things that actually break an MCP integration:
 *
 *  1. the route and its auth strategy — a wrong endpoint path or a key that does not
 *     resolve answers 401 to every client while every unit test stays green;
 *  2. the tenant scope — every tool calls Payload with `overrideAccess: false`, and
 *     only a real request proves the multi-tenant plugin is in the chain;
 *  3. tool registration — a collection enabled in config but missing a schema
 *     silently contributes no tools.
 *
 * So this spec speaks JSON-RPC through the SDK the clients use (ChatGPT's connector
 * and Bizamiz both speak Streamable HTTP), and it mints its keys with an explicit
 * `apiKey` so the value is known to the test. Run `pnpm seed` first.
 */
const base = 'http://localhost:3000'

const login = async (email: string): Promise<APIRequestContext> => {
  const ctx = await request.newContext({ baseURL: base })
  const res = await ctx.post('/api/users/login', { data: { email, password: 'test1234' } })
  expect(res.status(), `login as ${email}`).toBe(200)
  return ctx
}

interface KeyOverrides {
  apiKey?: string
  expiresAt?: string
  label?: string
}

const createKey = async (
  ctx: APIRequestContext,
  capabilities: Record<string, unknown>,
  overrides: KeyOverrides = {},
): Promise<string> => {
  const apiKey = overrides.apiKey ?? `e2e-${randomBytes(18).toString('hex')}`
  const res = await ctx.post('/api/payload-mcp-api-keys', {
    data: {
      apiKey,
      label: overrides.label ?? 'e2e mcp',
      ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
      ...capabilities,
    },
  })

  expect(res.status(), `create MCP key: ${await res.text()}`).toBe(201)
  return apiKey
}

const connect = async (apiKey: string): Promise<Client> => {
  const client = new Client({ name: 'eshobe-e2e', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  })
  await client.connect(transport)
  return client
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string; type: string }> }).content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
})

test.describe.serial('MCP over Streamable HTTP', () => {
  let admin: APIRequestContext
  let acme: APIRequestContext
  let acmeSiteId: string
  let studioSiteId: string
  let studioPageId: string
  let apiKey: string
  let client: Client

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')
    acme = await login('acme@eshobe.test')

    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const byDomain = (domain: string): string => {
      const site = sites.docs.find((doc: { domain: string }) => doc.domain === domain)
      if (!site) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)
      return site.id as string
    }
    acmeSiteId = byDomain('acme.localhost')
    studioSiteId = byDomain('studio.localhost')

    const studioPages = await (
      await admin.get(
        `/api/pages?limit=1&depth=0&where[site][equals]=${byDomain('studio.localhost')}`,
      )
    ).json()
    studioPageId = studioPages.docs[0]?.id
    expect(studioPageId, 'studio has at least one page').toBeTruthy()
  })

  test.afterAll(async () => {
    await client?.close()
    await admin.dispose()
    await acme.dispose()
  })

  test('refuses a request with no credential', async () => {
    const res = await fetch(`${base}/api/mcp`, {
      body: initializeBody,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      method: 'POST',
    })

    // The plugin's resolver throws UnauthorizedError before any tool exists.
    expect(res.status).toBe(401)
  })

  test('refuses an expired key', async () => {
    const expired = await createKey(acme, {}, {
      expiresAt: '2020-01-01T00:00:00.000Z',
      label: 'e2e expired',
    })

    await expect(connect(expired)).rejects.toThrow()
  })

  test('refuses a key of another site when reading across tenants', async () => {
    // A key belonging to acme cannot see studio's page, even by exact id. The read
    // goes through the collection's access, not through a tool-level site check.
    apiKey = await createKey(acme, {
      categories: { create: true, find: true, update: true },
      orders: { find: true },
      pages: { find: true },
      sites: { find: true },
      theme: { find: true },
      'payload-mcp-tool': {
        cmsContentStatus: true,
        cmsDescribeCapabilities: true,
        cmsSiteContext: true,
      },
    })

    client = await connect(apiKey)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)

    expect(names).toEqual(
      expect.arrayContaining([
        'findPages',
        'findCategories',
        'createCategories',
        'updateCategories',
        'findOrders',
        'findSites',
        'findTheme',
        'cms_describe_capabilities',
        'cms_content_status',
        'cms_site_context',
      ]),
    )

    // Nothing destructive, nothing platform-wide, nothing ungranted.
    for (const forbidden of [
      'deletePages',
      'deleteCategories',
      'createPages',
      'updatePages',
      'findUsers',
      'findPaymentGateways',
      'findApiKeys',
      'findAuditLog',
      'updateSites',
      'updateOrders',
      'deleteOrders',
    ]) {
      expect(names, `${forbidden} must not be registered`).not.toContain(forbidden)
    }

    const own = await client.callTool({ arguments: { limit: 20 }, name: 'findPages' })
    const ownText = textOf(own)
    expect(ownText).toContain(acmeSiteId)
    expect(ownText).not.toContain(studioPageId)

    const foreign = await client.callTool({
      arguments: { id: studioPageId },
      name: 'findPages',
    })
    const foreignText = textOf(foreign)
    // The refusal echoes the id the caller already supplied and nothing else: no
    // title, no site, no document body.
    expect(foreignText).toContain('not found')
    expect(foreignText).not.toContain('"title"')
  })

  test('calling a tool that was never registered fails', async () => {
    const result = (await client.callTool({
      arguments: { id: 'x' },
      name: 'deletePages',
    })) as { content: Array<{ text: string }>; isError?: boolean }

    // The SDK surfaces an unknown tool as an MCP error result rather than a
    // transport failure, so the assertion is on the payload, not on a rejection.
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not found')
  })

  test('writes are validated by the collection, not by the tool', async () => {
    // `categories` requires a title and a slug. Passing neither is refused by the
    // generated schema and then by Payload's validation, which is the point: the MCP
    // path does not re-implement the rules.
    const refused = await client.callTool({ arguments: {}, name: 'createCategories' })
    expect(textOf(refused).toLowerCase()).toMatch(/error|required/)
  })

  test('refuses a write aimed at another site', async () => {
    // The generated schema carries the multi-tenant `site` field, so a model can name
    // one. The tenant plugin refuses a site the key's owner does not belong to — this
    // is the write-side counterpart of the read assertion above.
    const foreign = await client.callTool({
      arguments: {
        site: studioSiteId,
        slug: `forbidden-${Date.now()}`,
        title: `ممنوع ${Date.now()}`,
      },
      name: 'createCategories',
    })

    expect(textOf(foreign).toLowerCase()).toContain('error')
  })

  test('reports only the sites this key may act on', async () => {
    const context = await client.callTool({ arguments: {}, name: 'cms_site_context' })
    const body = JSON.parse(textOf(context)) as {
      data: { sites: Array<{ domain: string; id: string; name: string }> }
      ok: boolean
    }

    expect(body.ok).toBe(true)
    expect(body.data.sites.map((site) => site.id)).toEqual([acmeSiteId])
    expect(body.data.sites.map((site) => site.domain)).not.toContain('studio.localhost')
    // The sites document carries billing and deployment links; none may travel.
    expect(Object.keys(body.data.sites[0]!).sort()).toEqual([
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

  test('creates, updates and audits a document as the key', async () => {
    const title = `دستهٔ MCP ${Date.now()}`
    const created = await client.callTool({
      arguments: { site: acmeSiteId, slug: `mcp-category-${Date.now()}`, title },
      name: 'createCategories',
    })
    const createdText = textOf(created)
    expect(createdText).toContain('Resource created successfully')

    // The tool answers with a sentence, then the document. Take the outermost braces
    // rather than assuming a line layout the plugin does not promise.
    const payload = JSON.parse(
      createdText.slice(createdText.indexOf('{'), createdText.lastIndexOf('}') + 1),
    ) as {
      id: string
      site: string
      title: string
    }
    expect(payload.title).toBe(title)
    // The tenant was taken from the key, never from an argument.
    expect(payload.site).toBe(acmeSiteId)

    const updated = await client.callTool({
      arguments: { id: payload.id, title: `${title} (ویرایش)` },
      name: 'updateCategories',
    })
    expect(textOf(updated)).toContain('Document updated successfully')

    // The audit row names the key, not the person who minted it, and carries no
    // document body.
    const audit = await (
      await admin.get(`/api/audit-log?limit=20&where[targetId][equals]=${payload.id}`)
    ).json()

    const mutation = audit.docs.find(
      (doc: { action: string }) => doc.action === 'mcp.contentChanged',
    )
    expect(mutation, 'an audit row for the MCP write').toBeTruthy()
    expect(mutation.actorType).toBe('apiKey')
    expect(String(mutation.actorEmail)).toMatch(/^mcp:/)
    expect(mutation.targetCollection).toBe('categories')
    expect(mutation.actorEmail).not.toContain('acme@eshobe.test')
  })

  test('delete is a per-key grant, not a blanket capability', async () => {
    // The first key was minted without `categories.delete`, so the tool is absent
    // from its catalogue even though the deployment supports the operation.
    const withoutDelete = (await client.listTools()).tools.map((tool) => tool.name)
    expect(withoutDelete).not.toContain('deleteCategories')

    const deletingKey = await createKey(acme, {
      categories: { create: true, delete: true, find: true },
      'payload-mcp-tool': { cmsDescribeCapabilities: true },
    })
    const deleting = await connect(deletingKey)

    try {
      expect((await deleting.listTools()).tools.map((tool) => tool.name)).toContain('deleteCategories')

      const created = await deleting.callTool({
        arguments: {
          site: acmeSiteId,
          slug: `mcp-delete-${Date.now()}`,
          title: `حذف ${Date.now()}`,
        },
        name: 'createCategories',
      })
      const createdText = textOf(created)
      const createdDoc = JSON.parse(
        createdText.slice(createdText.indexOf('{'), createdText.lastIndexOf('}') + 1),
      ) as { id: string }

      const removed = await deleting.callTool({
        arguments: { id: createdDoc.id },
        name: 'deleteCategories',
      })
      expect(textOf(removed)).toContain('Document deleted successfully')

      const gone = await deleting.callTool({
        arguments: { id: createdDoc.id },
        name: 'findCategories',
      })
      expect(textOf(gone)).toContain('not found')

      // The deletion is audited like any other MCP mutation.
      const audit = await (
        await admin.get(`/api/audit-log?limit=20&where[targetId][equals]=${createdDoc.id}`)
      ).json()
      expect(
        audit.docs.some(
          (doc: { action: string; targetCollection: string }) =>
            doc.action === 'mcp.contentChanged' && doc.targetCollection === 'categories',
        ),
      ).toBe(true)
    } finally {
      await deleting.close()
    }
  })

  test('describes this key’s grants, not the whole deployment', async () => {
    const described = await client.callTool({ arguments: {}, name: 'cms_describe_capabilities' })
    const body = JSON.parse(textOf(described)) as {
      data: {
        collections: Array<{
          collection: string
          grantedOperations: string[]
          toolNames: string[]
        }>
        tools: string[]
      }
      ok: boolean
    }

    expect(body.ok).toBe(true)
    const categories = body.data.collections.find((entry) => entry.collection === 'categories')
    expect(categories?.grantedOperations.sort()).toEqual(['create', 'find', 'update'])
    expect(categories?.toolNames.sort()).toEqual([
      'createCategories',
      'findCategories',
      'updateCategories',
    ])

    const pages = body.data.collections.find((entry) => entry.collection === 'pages')
    expect(pages?.grantedOperations).toEqual(['find'])

    expect(body.data.tools.sort()).toEqual([
      'cmsContentStatus',
      'cmsDescribeCapabilities',
      'cmsSiteContext',
    ])
  })

  test('reports publishing state through the read-only tool', async () => {
    const status = await client.callTool({
      arguments: { collection: 'pages', limit: 5 },
      name: 'cms_content_status',
    })
    const body = JSON.parse(textOf(status)) as {
      data: { collection: string; documents: Array<{ id: string; status: string }> }
      ok: boolean
    }

    expect(body.ok).toBe(true)
    expect(body.data.collection).toBe('pages')
    for (const doc of body.data.documents) {
      expect(['draft', 'published']).toContain(doc.status)
    }
  })

  test('refuses an unknown key with 401 rather than a server error', async () => {
    // What a rotated or deleted credential looks like to a client.
    const res = await fetch(`${base}/api/mcp`, {
      body: initializeBody,
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer e2e-${randomBytes(18).toString('hex')}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    })

    expect(res.status).toBe(401)
  })
})
