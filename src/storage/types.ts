/** A decrypted, usable ArvanCloud object-storage connection. Resolved from the
 * `storage-connections` collection, never from environment variables. */
export interface StorageConnection {
  accessKeyId: string
  bucket: string
  endpoint: string
  forcePathStyle: boolean
  id: string
  name: string
  region: string
  secretAccessKey: string
}

/** The subset of `StorageConnection` that determines which S3 client to build — used as the
 * cache key so a client is only rebuilt when something it depends on actually changes. */
export type StorageClientKey = Omit<StorageConnection, 'id' | 'name'>

/** A platform-admin entered connection before the secret is decrypted. */
export interface StorageConnectionRow {
  accessKeyId?: string | null
  bucket?: string | null
  enabled?: boolean | null
  endpoint?: string | null
  forcePathStyle?: boolean | null
  id: string
  name?: string | null
  region?: string | null
  secretAccessKey?: string | null
}
