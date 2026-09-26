import type { StorageMode } from './mode'
import type { StorageHealthStatus } from './health'
import type { StorageProviderId } from './providers'
import type { StorageErrorCategory } from './errors'

/** A decrypted, usable S3-compatible object-storage connection. */
export interface StorageConnection {
  accessKeyId: string
  bucket: string
  endpoint: string
  forcePathStyle: boolean
  id: string
  name: string
  provider: StorageProviderId
  region: string
  secretAccessKey: string
  storageMode: StorageMode
}

/** The subset of `StorageConnection` that determines which S3 client to build — used as the
 * cache key so a client is only rebuilt when something it depends on actually changes. */
export type StorageClientKey = Omit<StorageConnection, 'id' | 'name'>

/** A platform-admin entered connection before the secret is decrypted. */
export interface StorageConnectionRow {
  accessKeyId?: string | null
  authenticationOk?: boolean | null
  bucket?: string | null
  bucketAccessible?: boolean | null
  deleteAccessOk?: boolean | null
  enabled?: boolean | null
  endpoint?: string | null
  endpointReachable?: boolean | null
  forcePathStyle?: boolean | null
  healthStatus?: StorageHealthStatus | null
  id: string
  lastCheckedAt?: string | null
  lastErrorCategory?: StorageErrorCategory | null
  lastErrorCode?: string | null
  lastErrorMessage?: string | null
  lastHealthyAt?: string | null
  lastSelfTestAt?: string | null
  lastSelfTestDetail?: string | null
  lastSelfTestOk?: boolean | null
  latencyMs?: number | null
  name?: string | null
  provider?: StorageProviderId | null
  readAccessOk?: boolean | null
  region?: string | null
  secretAccessKey?: string | null
  storageMode?: StorageMode | null
  writeAccessOk?: boolean | null
}
