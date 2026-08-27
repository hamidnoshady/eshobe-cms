import { describe, expect, it, vi } from 'vitest'

import { domainCheck } from '@/endpoints/domainCheck'

const request = (domain: string, docs: unknown[]) => ({
  query: { domain },
  payload: { find: vi.fn().mockResolvedValue({ docs }) },
})

describe('Caddy domain authorization', () => {
  it('authorizes only an active, verified site returned by Payload', async () => {
    const response = await domainCheck.handler!(request('client.example.com', [{ id: '1' }]) as never)
    expect(response.status).toBe(200)
  })

  it.each(['unknown.example.com', 'client.example.com.'])('refuses %s when no verified site matches', async (domain) => {
    const response = await domainCheck.handler!(request(domain, []) as never)
    expect(response.status).toBe(404)
  })

  it.each(['', 'localhost', 'http://client.example.com', 'bad_domain.example.com'])('refuses malformed host %s', async (domain) => {
    const response = await domainCheck.handler!(request(domain, [{ id: '1' }]) as never)
    expect(response.status).toBe(404)
  })
})
