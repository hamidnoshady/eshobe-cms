import type { MCPAccessSettings } from '@payloadcms/plugin-mcp'
import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mcpOverrideAuth } from '@/mcp/auth'
import {
  MCP_COLLECTION_CAPABILITIES,
  describeMcpSurface,
  MCP_CUSTOM_TOOL_NAMES,
  toCamelCase,
} from '@/mcp/capabilities'
import { MCP_KEY_CONTEXT } from '@/mcp/context'
import {
  assertBodyWithinLimit,
  consumeMcpRateLimit,
  resetMcpRateLimits,
} from '@/mcp/limits'
import { mcpAuditedCollectionSlugs } from '@/plugins/mcpAudit'
import { MCP_COLLECTION_SLUGS } from '@/plugins/mcp-slugs'

/**
 * The MCP surface and its request gate, without a database.
 *
 * What this file can prove and what it cannot is worth stating: it proves the
 * capability matrix, the rate window, the expiry arithmetic and the shape of a
 * refusal. It cannot prove the endpoint routes, that the auth strategy finds a key,
 * or that the multi-tenant plugin scopes a read — those are properties of the
 * assembled application, and `tests/e2e/mcp.e2e.spec.ts` drives them with the real
 * MCP SDK over HTTP. A green run here with a red e2e is the expected signal when the
 * route or the strategy breaks.
 */

const request = (overrides: Partial<PayloadRequest> = {}): PayloadRequest =>
  ({
    context: {},
    headers: new Headers(),
    payload: { logger: { error: vi.fn() } },
    ...overrides,
  }) as unknown as PayloadRequest

const keySettings = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'key-1',
    label: 'editorial assistant',
    pages: { create: false, find: true, update: false },
    'payload-mcp-tool': { cmsDescribeCapabilities: true },
    user: { id: 'user-1' },
    ...overrides,
  }) as unknown as MCPAccessSettings

describe('MCP capability matrix', () => {
  it('describes exactly the allowlisted collections and never a delete', () => {
    const surface = describeMcpSurface()

    expect(surface.collections.map((entry) => entry.collection)).toEqual([...MCP_COLLECTION_SLUGS])
    expect(surface.globals).toEqual([])
    expect(surface.tools).toEqual([...MCP_CUSTOM_TOOL_NAMES])

    for (const entry of surface.collections) {
      expect(entry.operations).not.toContain('delete')
      expect(entry.operations.length).toBeGreaterThan(0)
    }
  })

  it('keeps the matrix and the slug allowlist in step, in both directions', () => {
    expect(Object.keys(MCP_COLLECTION_CAPABILITIES).sort()).toEqual([...MCP_COLLECTION_SLUGS].sort())
  })

  it('audits every collection a key can write', () => {
    const writable = (
      Object.entries(MCP_COLLECTION_CAPABILITIES) as Array<[string, Record<string, boolean>]>
    )
      .filter(([, capability]) => capability.create === true || capability.update === true)
      .map(([slug]) => slug)
      .sort()

    expect(mcpAuditedCollectionSlugs()).toEqual(writable)
  })

  it('camel-cases capability groups the way the plugin stores them', () => {
    // These three are the shapes an MCP key row actually contains; a mismatch here
    // makes every granted operation read as absent, which looks like a permissions bug.
    expect(toCamelCase('site-branding')).toBe('siteBranding')
    expect(toCamelCase('payload-folders')).toBe('payloadFolders')
    expect(toCamelCase('pages')).toBe('pages')
  })
})

describe('MCP rate limit', () => {
  beforeEach(() => {
    resetMcpRateLimits()
  })

  it('allows the window, then refuses without waiting for a clock', () => {
    const now = 1_000_000

    for (let index = 0; index < 3; index += 1) {
      expect(consumeMcpRateLimit('key-a', now, 3).allowed).toBe(true)
    }

    const refused = consumeMcpRateLimit('key-a', now, 3)
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    expect(refused.retryAfterMs).toBe(60_000)
  })

  it('forgets a window after it elapses', () => {
    const now = 1_000_000
    expect(consumeMcpRateLimit('key-b', now, 1).allowed).toBe(true)
    expect(consumeMcpRateLimit('key-b', now, 1).allowed).toBe(false)
    expect(consumeMcpRateLimit('key-b', now + 60_001, 1).allowed).toBe(true)
  })

  it('buckets per key, so one runaway client cannot exhaust another', () => {
    const now = 1_000_000
    expect(consumeMcpRateLimit('key-c', now, 1).allowed).toBe(true)
    expect(consumeMcpRateLimit('key-c', now, 1).allowed).toBe(false)
    expect(consumeMcpRateLimit('key-d', now, 1).allowed).toBe(true)
  })
})

describe('MCP body cap', () => {
  it('refuses a declared oversize body with 413', () => {
    let thrown: unknown
    try {
      assertBodyWithinLimit('4096', 1024)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(APIError)
    expect((thrown as APIError).status).toBe(413)
  })

  it('passes an absent or in-limit Content-Length', () => {
    expect(() => assertBodyWithinLimit(null, 1024)).not.toThrow()
    expect(() => assertBodyWithinLimit('1024', 1024)).not.toThrow()
  })
})

describe('mcpOverrideAuth', () => {
  beforeEach(() => {
    resetMcpRateLimits()
  })

  it('refuses an expired key', async () => {
    const resolve = vi.fn(async () => keySettings({ expiresAt: '2020-01-01T00:00:00.000Z' }))

    await expect(mcpOverrideAuth(request(), resolve)).rejects.toMatchObject({ status: 401 })
  })

  it('treats an unparseable expiry as expired', async () => {
    const resolve = vi.fn(async () => keySettings({ expiresAt: 'not-a-date' }))

    await expect(mcpOverrideAuth(request(), resolve)).rejects.toMatchObject({ status: 401 })
  })

  it('accepts a key with no expiry, and puts only the allowlisted facts on the request', async () => {
    const req = request()
    const settings = keySettings({
      apiKeyIndex: 'hashed-index-must-not-travel',
      user: { id: 'user-1', email: 'owner@example.test' },
    })

    const resolved = await mcpOverrideAuth(req, vi.fn(async () => settings))

    expect(resolved).toBe(settings)

    const context = (req.context as Record<string, Record<string, unknown>>)[MCP_KEY_CONTEXT]
    expect(context).toMatchObject({ id: 'key-1', label: 'editorial assistant' })
    expect(context.capabilities).not.toHaveProperty('apiKeyIndex')
    expect(context.capabilities).not.toHaveProperty('user')
    // The capability groups survive, because a discovery tool reads them.
    expect(context.capabilities).toHaveProperty('pages', { create: false, find: true, update: false })
    expect(context.capabilities).toHaveProperty('payload-mcp-tool')
  })

  it('refuses an oversized body before resolving the key', async () => {
    const resolve = vi.fn(async () => keySettings())
    const req = request({
      headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
    })

    await expect(mcpOverrideAuth(req, resolve)).rejects.toMatchObject({ status: 413 })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses past the per-key limit', async () => {
    const resolve = vi.fn(async () => keySettings())
    const previous = process.env.MCP_RATE_LIMIT
    process.env.MCP_RATE_LIMIT = '1'

    try {
      await mcpOverrideAuth(request(), resolve)
      await expect(mcpOverrideAuth(request(), resolve)).rejects.toMatchObject({ status: 429 })
    } finally {
      if (previous === undefined) delete process.env.MCP_RATE_LIMIT
      else process.env.MCP_RATE_LIMIT = previous
    }
  })
})
