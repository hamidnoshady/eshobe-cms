// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const { deleteCdnRecords, syncCdnZone } = vi.hoisted(() => ({
  deleteCdnRecords: vi.fn(),
  syncCdnZone: vi.fn(),
}))
vi.mock('@/cdn/service', async (original) => ({
  ...(await original<typeof import('@/cdn/service')>()),
  deleteCdnRecords,
  syncCdnZone,
}))

import { encryptCdnSecret } from '@/cdn/crypto'
import { syncRequestedCdnZones } from '@/cdn/task'

process.env.CDN_INTEGRATIONS_KEY ??= 'this-is-a-dedicated-test-key-with-at-least-32-characters'

const requestedAt = '2026-10-28T08:00:00.000Z'

/** `snapshot` is what the task reads before the provider calls; `current` is the
 * row as it stands afterwards — a tenant may have saved in between. */
const harness = (snapshot: Record<string, unknown>, current: Record<string, unknown>) => {
  const payload = {
    create: vi.fn().mockResolvedValue({}),
    find: vi.fn(async ({ select }: { select?: Record<string, unknown> }) =>
      select ? { docs: [{ id: 'z1' }] } : { docs: [snapshot] },
    ),
    findByID: vi.fn(async () => current),
    logger: { error: vi.fn(), warn: vi.fn() },
    update: vi.fn().mockResolvedValue({}),
  }
  return { payload, req: { context: {}, payload } }
}

const zone = (overrides: Record<string, unknown> = {}) => ({
  credentials: { apiToken: encryptCdnSecret('zone-token') },
  dnsRecords: [{ id: 'r1', name: '@', source: 'platform', type: 'A' }],
  id: 'z1',
  pendingRecordDeletes: [{ providerRecordId: 'gone-1' }],
  provider: 'arvancloud',
  syncRequestedAt: requestedAt,
  zoneName: 'acme.ir',
  ...overrides,
})

describe('cdnZoneSync task', () => {
  it('deletes what the tenant removed, then clears the marker it was asked to serve', async () => {
    deleteCdnRecords.mockResolvedValue([{ name: 'dns-delete:gone-1', state: 'applied' }])
    syncCdnZone.mockResolvedValue({
      actions: [],
      externalIds: { 'dns:r1': 'remote-r1' },
      status: 'pending',
    })
    const { payload, req } = harness(zone(), zone())

    await expect(syncRequestedCdnZones(req as never)).resolves.toEqual({ synced: 1 })
    expect(deleteCdnRecords).toHaveBeenCalledWith(expect.anything(), ['gone-1'])
    const { data } = payload.update.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(data).toMatchObject({
      lastSyncOk: true,
      pendingRecordDeletes: [],
      syncRequestedAt: null,
    })
    expect(data.dnsRecords).toEqual([
      expect.objectContaining({ id: 'r1', providerRecordId: 'remote-r1' }),
    ])
  })

  it('writes onto the current row and keeps a newer request queued', async () => {
    deleteCdnRecords.mockResolvedValue([])
    syncCdnZone.mockResolvedValue({ actions: [], externalIds: { 'dns:r1': 'remote-r1' } })
    // While the provider calls ran, the tenant added r2 and asked again.
    const current = zone({
      dnsRecords: [
        { id: 'r1', name: '@', source: 'platform', type: 'A' },
        { id: 'r2', name: 'mail', source: 'tenant', type: 'MX' },
      ],
      syncRequestedAt: '2026-10-28T08:00:30.000Z',
    })
    const { payload, req } = harness(zone(), current)

    await syncRequestedCdnZones(req as never)
    const { data } = payload.update.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(data.dnsRecords).toHaveLength(2)
    expect(data).not.toHaveProperty('syncRequestedAt')
  })

  it('records a failure and stops retrying it every minute', async () => {
    deleteCdnRecords.mockResolvedValue([])
    syncCdnZone.mockRejectedValue(new Error('provider said no'))
    const { payload, req } = harness(
      zone({ pendingRecordDeletes: [] }),
      zone({ pendingRecordDeletes: [] }),
    )

    await expect(syncRequestedCdnZones(req as never)).resolves.toEqual({ synced: 0 })
    const { data } = payload.update.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(data).toMatchObject({
      lastSyncDetail: 'provider said no',
      lastSyncOk: false,
      syncRequestedAt: null,
    })
    expect(payload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'cdn-events',
        data: expect.objectContaining({ ok: false }),
      }),
    )
  })
})
