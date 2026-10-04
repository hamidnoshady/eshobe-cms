import { describe, expect, it } from 'vitest'

import { mayRunPayloadJobs } from '@/lib/jobs-access'

const secret = 'cron-secret-for-tests-with-enough-entropy'

const canRun = (user: null | { role?: unknown }, authorization?: string | null) =>
  mayRunPayloadJobs({ authorization: authorization ?? null, cronSecret: secret, user })

describe('global Payload job runner authorization', () => {
  it('allows platform administrators and refuses tenant owners and editors', () => {
    expect(canRun({ role: 'platformAdmin' })).toBe(true)
    expect(canRun({ role: 'user' })).toBe(false)
    expect(canRun(null)).toBe(false)
  })

  it('allows only an exact cron bearer secret for machine callers', () => {
    expect(canRun(null, `Bearer ${secret}`)).toBe(true)
    expect(canRun(null, `bearer ${secret}`)).toBe(false)
    expect(canRun(null, `Bearer ${secret}x`)).toBe(false)
    expect(canRun(null, 'Bearer wrong')).toBe(false)
    expect(
      mayRunPayloadJobs({ authorization: `Bearer ${secret}`, cronSecret: undefined, user: null }),
    ).toBe(false)
  })

  it('does not let an ordinary authenticated user run global work without the machine secret', () => {
    expect(canRun({ role: 'user' }, 'Bearer wrong')).toBe(false)
  })
})
