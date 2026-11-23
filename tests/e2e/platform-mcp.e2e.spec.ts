import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, request, test, type APIRequestContext } from '@playwright/test'

const base = 'http://localhost:3000'

const login = async (email: string): Promise<APIRequestContext> => {
  const ctx = await request.newContext({ baseURL: base })
  const response = await ctx.post('/api/users/login', {
    data: { email, password: 'test1234' },
  })
  expect(response.status(), `login as ${email}`).toBe(200)
  return ctx
}

const connect = async (path: string, key: string): Promise<Client> => {
  const client = new Client({ name: 'eshobe-platform-e2e', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  )
  return client
}

test.describe.serial('platform MCP over Streamable HTTP', () => {
  let admin: APIRequestContext
  let acme: APIRequestContext
  let platformKey: string
  let platformKeyId: string
  let siteKey: string
  let siteKeyId: string
  let acmeId: string
  let tenantMcpKeyId: string
  let tenantMcpKey: string
  let platformClient: Client

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')
    acme = await login('acme@eshobe.test')

    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const site = sites.docs.find((doc: { domain: string }) => doc.domain === 'acme.localhost')
    if (!site) throw new Error('acme.localhost missing — run `pnpm seed`')
    acmeId = site.id

    const platformIssued = await (
      await admin.post('/api/api-keys/issue', {
        data: { name: 'e2e platform MCP', role: 'platform' },
      })
    ).json()
    platformKey = platformIssued.key
    platformKeyId = platformIssued.id

    const siteIssued = await (
      await admin.post('/api/api-keys/issue', {
        data: { name: 'e2e platform MCP site denial', role: 'site', siteId: acmeId },
      })
    ).json()
    siteKey = siteIssued.key
    siteKeyId = siteIssued.id

    tenantMcpKey = `e2e-${crypto.randomUUID()}`
    const tenantKeyResponse = await acme.post('/api/payload-mcp-api-keys', {
      data: {
        apiKey: tenantMcpKey,
        label: 'e2e platform endpoint denial',
        pages: { find: true },
        'payload-mcp-tool': { cmsDescribeCapabilities: true },
      },
    })
    expect(tenantKeyResponse.status(), await tenantKeyResponse.text()).toBe(201)
    tenantMcpKeyId = (await tenantKeyResponse.json()).doc.id
    platformClient = await connect('/api/platform/mcp', platformKey)
  })

  test.afterAll(async () => {
    await platformClient?.close()
    for (const id of [platformKeyId, siteKeyId].filter(Boolean)) {
      await admin.post('/api/api-keys/revoke', { data: { id } })
    }
    if (tenantMcpKeyId) await acme.delete(`/api/payload-mcp-api-keys/${tenantMcpKeyId}`)
    await admin?.dispose()
    await acme?.dispose()
  })

  test('registers only platform tools and runs a platform read', async () => {
    const tools = await platformClient.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(['platform_read', 'platform_write'])

    const result = await platformClient.callTool({
      name: 'platform_read',
      arguments: { operation: 'overview.get', query: { days: 30 } },
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain('overview')
  })

  test('runs an allowlisted platform write through the existing site handler', async () => {
    const site = await (await admin.get(`/api/platform/sites/${acmeId}`)).json()
    const result = await platformClient.callTool({
      name: 'platform_write',
      arguments: {
        body: { name: site.site.name },
        operation: 'site.update',
        pathParams: { id: acmeId },
      },
    })
    expect(result.isError).not.toBe(true)
    const content = (result as { content?: Array<{ text?: string; type: string }> }).content ?? []
    const response = content.find((part) => part.type === 'text')
    expect(response?.type).toBe('text')
    if (!response || response.type !== 'text') throw new Error('Platform write returned no text response.')
    expect(JSON.parse(response.text ?? '')).toMatchObject({ ok: true, site: { id: acmeId } })
  })

  test('refuses a site API key on the platform endpoint', async () => {
    await expect(connect('/api/platform/mcp', siteKey)).rejects.toThrow()
  })

  test('refuses a tenant MCP key on the platform endpoint', async () => {
    await expect(connect('/api/platform/mcp', tenantMcpKey)).rejects.toThrow()
  })

  test('refuses a platform API key on the tenant endpoint', async () => {
    await expect(connect('/api/mcp', platformKey)).rejects.toThrow()
  })
})
