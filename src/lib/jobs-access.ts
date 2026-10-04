import { timingSafeEqual } from 'node:crypto'

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

  const expected = Buffer.from(`Bearer ${cronSecret}`)
  const supplied = Buffer.from(authorization)

  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
