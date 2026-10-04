import { timingSafeEqual } from 'node:crypto'

export const bootstrapTokenMatches = (configured: string | undefined, supplied: string | undefined): boolean => {
  if (!configured || !supplied) return false

  const expected = Buffer.from(configured)
  const actual = Buffer.from(supplied)

  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * Keep the old first-user convenience in local/test environments, but never let the
 * public first-user flow become a production privilege-escalation mechanism. The
 * one-shot CLI bootstrap is the only production code that sets the context flag, and
 * it must also prove a separate operator token before calling Local API.
 */
export const roleForUserCreate = ({
  bootstrapAuthorized,
  isProduction,
  platformAdminCount,
  requestedRole,
}: {
  bootstrapAuthorized: boolean
  isProduction: boolean
  platformAdminCount: number
  requestedRole: 'platformAdmin' | 'user' | undefined
}): 'platformAdmin' | 'user' => {
  if (isProduction) {
    if (bootstrapAuthorized && platformAdminCount === 0) return 'platformAdmin'
    return requestedRole === 'platformAdmin' ? 'user' : requestedRole ?? 'user'
  }

  if (platformAdminCount === 0) return 'platformAdmin'
  return requestedRole ?? 'user'
}
