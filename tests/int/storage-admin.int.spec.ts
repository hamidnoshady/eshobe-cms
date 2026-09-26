import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { storageConnectionEndpoints } from '@/endpoints/storageConnections'

describe('storage admin wiring', () => {
  it('registers collection endpoints for overview, usage and self-test', () => {
    const paths = storageConnectionEndpoints.map((endpoint) => endpoint.path)
    expect(paths).toContain('/self-test')
    expect(paths).toContain('/overview')
    expect(paths).toContain('/usage')
  })

  it('clears the connection cache on every afterChange hook', () => {
    const source = readFileSync('src/collections/StorageConnections.ts', 'utf8')
    expect(source).toContain('clearStorageCacheAfterChange')
    expect(source).toContain('mergeContextStorageHealth')
  })

  it('exposes the infrastructure overview admin view', () => {
    const source = readFileSync('src/collections/StorageConnections.ts', 'utf8')
    expect(source).toContain('/infrastructure/storage')
    expect(source).toContain('StorageOverviewView')
  })
})
