import type { PayloadRequest, TaskConfig } from 'payload'

import {
  STORAGE_HEALTH_PATCH_CONTEXT_KEY,
  STORAGE_HEALTH_WRITE_CONTEXT_KEY,
} from '@/collections/hooks/storageConnectionSecrets'

import { clearStorageConnectionCache, getActiveConnection, freshStorageClient } from './connection'
import { runQuickStorageTest } from './health'

/**
 * Lightweight scheduled HeadBucket check for the enabled connection.
 *
 * Full Put/Get/Delete diagnostics run only manually (or before activation).
 */
export const storageHealthCheck = async (req: PayloadRequest): Promise<{ checked: boolean }> => {
  let connection
  try {
    connection = await getActiveConnection(req)
  } catch {
    return { checked: false }
  }

  if (!connection) return { checked: false }

  const result = await runQuickStorageTest(connection, freshStorageClient(connection))
  const now = new Date().toISOString()

  await req.payload.update({
    collection: 'storage-connections',
    context: {
      [STORAGE_HEALTH_PATCH_CONTEXT_KEY]: {
        authenticationOk: result.authenticationOk,
        bucketAccessible: result.bucketAccessible,
        endpointReachable: result.endpointReachable,
        healthStatus: result.ok ? 'healthy' : 'degraded',
        lastCheckedAt: now,
        lastErrorCategory: result.errorCategory ?? null,
        lastErrorCode: result.errorCode ?? null,
        lastErrorMessage: result.errorMessage ?? null,
        ...(result.ok ? { lastHealthyAt: now } : {}),
        latencyMs: result.latencyMs,
      },
      [STORAGE_HEALTH_WRITE_CONTEXT_KEY]: true,
    },
    data: {},
    depth: 0,
    id: connection.id,
    overrideAccess: true,
    req,
  })

  clearStorageConnectionCache()
  return { checked: true }
}

export const storageHealthCheckTask: TaskConfig<'storageHealthCheck'> = {
  slug: 'storageHealthCheck',
  handler: async ({ req }) => {
    const result = await storageHealthCheck(req)
    return { output: result }
  },
  label: 'بررسی سبک ذخیره‌سازی شیء',
  outputSchema: [{ name: 'checked', type: 'checkbox' }],
  schedule: [{ cron: '*/5 * * * *', hooks: {}, queue: 'default' }],
  retries: 0,
}
