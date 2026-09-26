import type { StorageConnection } from './types'

export type StorageMode = 'local' | 'object_storage' | 'object_storage_with_local_mirror'

export const isStorageMode = (value: unknown): value is StorageMode =>
  value === 'local' || value === 'object_storage' || value === 'object_storage_with_local_mirror'

/** Whether the adapter should talk to S3 for this resolved connection. */
export const shouldUseObjectStorage = (connection: StorageConnection | null): boolean => {
  if (!connection) return false
  if (connection.storageMode === 'local') return false
  return true
}

/** Whether Payload's local mirror should be removed after a successful object upload. */
export const shouldDropLocalMirrorAfterUpload = (connection: StorageConnection): boolean =>
  connection.storageMode === 'object_storage'
