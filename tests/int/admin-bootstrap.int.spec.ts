import { describe, expect, it } from 'vitest'

import { bootstrapTokenMatches, roleForUserCreate } from '@/lib/admin-bootstrap'

describe('platform administrator bootstrap boundary', () => {
  it('does not promote a production first user through the public create flow', () => {
    expect(
      roleForUserCreate({
        bootstrapAuthorized: false,
        isProduction: true,
        platformAdminCount: 0,
        requestedRole: undefined,
      }),
    ).toBe('user')
    expect(
      roleForUserCreate({
        bootstrapAuthorized: false,
        isProduction: true,
        platformAdminCount: 0,
        requestedRole: 'platformAdmin',
      }),
    ).toBe('user')
  })

  it('allows exactly one explicitly bootstrapped production administrator', () => {
    expect(
      roleForUserCreate({
        bootstrapAuthorized: true,
        isProduction: true,
        platformAdminCount: 0,
        requestedRole: 'platformAdmin',
      }),
    ).toBe('platformAdmin')
    expect(
      roleForUserCreate({
        bootstrapAuthorized: true,
        isProduction: true,
        platformAdminCount: 1,
        requestedRole: 'platformAdmin',
      }),
    ).toBe('user')
  })

  it('preserves the first-user convenience outside production', () => {
    expect(
      roleForUserCreate({
        bootstrapAuthorized: false,
        isProduction: false,
        platformAdminCount: 0,
        requestedRole: 'user',
      }),
    ).toBe('platformAdmin')
    expect(
      roleForUserCreate({
        bootstrapAuthorized: false,
        isProduction: false,
        platformAdminCount: 1,
        requestedRole: 'user',
      }),
    ).toBe('user')
  })

  it('compares bootstrap tokens without a timing leak and fails closed on missing values', () => {
    expect(bootstrapTokenMatches('an-operator-token', 'an-operator-token')).toBe(true)
    expect(bootstrapTokenMatches('an-operator-token', 'wrong')).toBe(false)
    expect(bootstrapTokenMatches('an-operator-token', undefined)).toBe(false)
    expect(bootstrapTokenMatches(undefined, 'an-operator-token')).toBe(false)
  })
})
