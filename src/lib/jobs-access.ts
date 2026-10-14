import { createHash, timingSafeEqual } from 'node:crypto'

import { isPlatformAdmin } from '@/access/platformAdmin'

/**
 * The global Payload job runner can execute deployment, billing, storage and publish
 * tasks. It is not a tenant operation: only a platform-admin session or the machine
 * secret used by the scheduler may invoke it.
 */
export const mayRunPayloadJobs = ({
  authorization,
  cronSecret,
  user,
}: {
  authorization: null | string
  cronSecret: null | string | undefined
  user: null | { role?: unknown }
}): boolean => {
  if (isPlatformAdmin(user)) return true
  if (!cronSecret || !authorization) return false

  // Security: Hash before comparing to avoid length-based timing leaks
  // and ensure timingSafeEqual receives buffers of exactly equal length.
  const expected = createHash('sha256').update(`Bearer ${cronSecret}`).digest()
  const supplied = createHash('sha256').update(authorization).digest()

  return timingSafeEqual(supplied, expected)
}
