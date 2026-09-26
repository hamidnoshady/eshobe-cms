// @vitest-environment node
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { Payload } from 'payload'
import { getPayload } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@/payload.config'
import type { PayloadRequest } from 'payload'
import {
  decryptStorageSecret,
  encryptStorageSecret,
  fingerprintStorageSecret,
} from '@/storage/crypto'
import { clearStorageConnectionCache, getActiveConnection } from '@/storage/connection'
import { normaliseStorageError } from '@/storage/errors'
import { normalizeStorageEndpoint } from '@/storage/endpoint'
import { runFullStorageTest, runQuickStorageTest } from '@/storage/health'
import { sitePrefix } from '@/hooks/mediaPrefix'
import type { StorageConnection } from '@/storage/types'

const sendMock = vi.fn()

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return {
    ...actual,
    S3Client: class MockS3Client {
      send(command: unknown) {
        return sendMock(command)
      }
    },
  }
})

let payload: Payload

const connectionFixture = (): StorageConnection => ({
  accessKeyId: 'AKIATEST',
  bucket: 'test-bucket',
  endpoint: 'https://s3.example.test',
  forcePathStyle: true,
  id: '00000000-0000-4000-8000-000000000099',
  name: 'test',
  provider: 'custom',
  region: 'default',
  secretAccessKey: 'secret',
  storageMode: 'object_storage',
})

beforeAll(async () => {
  payload = await getPayload({ config: await config })
}, 180_000)

afterEach(() => {
  sendMock.mockReset()
  clearStorageConnectionCache()
  vi.unstubAllEnvs()
})

describe('storage crypto', () => {
  it('encrypts, fingerprints, and refuses tampered ciphertext', () => {
    const previous = process.env.OBJECT_STORAGE_KEY
    process.env.OBJECT_STORAGE_KEY = 'dedicated-storage-key-at-least-32-chars-long!!'
    try {
      const encrypted = encryptStorageSecret('my-secret-key')
      expect(encrypted).not.toContain('my-secret-key')
      expect(decryptStorageSecret(encrypted)).toBe('my-secret-key')
      expect(fingerprintStorageSecret('my-secret-key')).toHaveLength(12)
      const corrupted = `${encrypted.slice(0, 12)}XXXX${encrypted.slice(16)}`
      expect(decryptStorageSecret(corrupted)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.OBJECT_STORAGE_KEY
      else process.env.OBJECT_STORAGE_KEY = previous
    }
  })
})

describe('storage endpoint validation', () => {
  it('normalizes and rejects embedded credentials', () => {
    expect(normalizeStorageEndpoint('https://s3.example.test/')).toBe('https://s3.example.test')
    expect(() => normalizeStorageEndpoint('https://key:secret@s3.example.test')).toThrow()
  })
})

describe('storage diagnostics', () => {
  it('quick test succeeds on HeadBucket', async () => {
    sendMock.mockResolvedValue({})
    const result = await runQuickStorageTest(connectionFixture())
    expect(result.ok).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(expect.any(HeadBucketCommand))
  })

  it('full test runs put/get/delete lifecycle', async () => {
    let stored: Buffer | null = null
    sendMock.mockImplementation(async (command: unknown) => {
      const name = (command as { constructor?: { name?: string } })?.constructor?.name
      if (command instanceof HeadBucketCommand || name === 'HeadBucketCommand') return {}
      if (command instanceof PutObjectCommand || name === 'PutObjectCommand') {
        const input = (command as PutObjectCommand).input
        stored = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from('')
        return {}
      }
      if (command instanceof HeadObjectCommand || name === 'HeadObjectCommand') {
        return { ContentLength: stored?.length ?? 0 }
      }
      if (command instanceof GetObjectCommand || name === 'GetObjectCommand') {
        const bytes = stored ?? Buffer.alloc(0)
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array(bytes),
          },
        }
      }
      if (command instanceof DeleteObjectCommand || name === 'DeleteObjectCommand') return {}
      return {}
    })

    const result = await runFullStorageTest(connectionFixture())
    expect(result.steps, JSON.stringify(result)).toBeTruthy()
    expect(result.ok, result.errorMessage ?? JSON.stringify(result.steps)).toBe(true)
    expect(result.writeAccessOk).toBe(true)
    expect(result.readAccessOk).toBe(true)
    expect(result.deleteAccessOk).toBe(true)
  })

  it('maps AccessDenied to permission guidance', () => {
    const normalised = normaliseStorageError({ name: 'AccessDenied', message: 'Access Denied' })
    expect(normalised.category).toBe('PERMISSION')
    expect(normalised.operatorMessage).toContain('PutObject')
  })
})

describe('storage connections collection', () => {
  it('clears the in-process cache when clearStorageConnectionCache is called', async () => {
    const req = { context: {}, payload } as PayloadRequest
    const first = await getActiveConnection(req)
    clearStorageConnectionCache()
    const second = await getActiveConnection(req)
    expect(second?.bucket).toBe(first?.bucket ?? undefined)
  })

  it('blocks deleting an enabled connection', async () => {
    const row = await payload.create({
      collection: 'storage-connections',
      data: {
        accessKeyId: 'A',
        authenticationOk: true,
        bucket: 'del-test',
        bucketAccessible: true,
        deleteAccessOk: true,
        enabled: true,
        endpoint: 'https://s3.ir-thr-at1.arvanstorage.ir',
        healthStatus: 'healthy',
        name: `del-block-${Date.now()}`,
        provider: 'arvancloud',
        readAccessOk: true,
        secretAccessKey: 'secret',
        storageMode: 'object_storage_with_local_mirror',
        writeAccessOk: true,
      },
      overrideAccess: true,
    })

    await expect(
      payload.delete({ collection: 'storage-connections', id: row.id, overrideAccess: true }),
    ).rejects.toThrow(/فعال/)
  })
})

describe('tenant media prefixes', () => {
  it('namespaces by site id', () => {
    expect(sitePrefix('abc')).toBe('sites/abc/media')
    expect(sitePrefix('x')).not.toBe(sitePrefix('y'))
  })
})
