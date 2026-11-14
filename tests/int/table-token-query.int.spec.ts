import { describe, expect, it } from 'vitest'

import {
  canonicalizeTableTokenQuery,
  resolveTableTokenQuery,
} from '@/lib/table-token-query'

describe('table QR query contract', () => {
  const token = 'tqr_0123456789abcdefghijklmnopqrstuv'

  it('uses canonical tableToken and accepts legacy t during migration', () => {
    expect(resolveTableTokenQuery({ tableToken: token })).toEqual({
      conflict: false,
      hasLegacy: false,
      token,
      usedLegacy: false,
    })

    expect(resolveTableTokenQuery({ t: token })).toEqual({
      conflict: false,
      hasLegacy: true,
      token,
      usedLegacy: true,
    })
  })

  it('does not reject an old URL when both spellings carry the same token', () => {
    expect(resolveTableTokenQuery({ tableToken: token, t: token })).toEqual({
      conflict: false,
      hasLegacy: true,
      token,
      usedLegacy: false,
    })
  })

  it('rejects conflicting canonical and legacy values instead of choosing one', () => {
    expect(resolveTableTokenQuery({ tableToken: token, t: `${token}x` })).toEqual({
      conflict: true,
      hasLegacy: true,
      token: null,
      usedLegacy: false,
    })
    expect(resolveTableTokenQuery({ tableToken: [token, 'other'] })).toMatchObject({
      conflict: true,
      token: null,
    })
    expect(resolveTableTokenQuery({ tableToken: token, t: '' })).toMatchObject({
      conflict: true,
      token: null,
    })
  })

  it('rewrites only the query key for a legacy QR URL', () => {
    const query = { page: '2', q: 'coffee', t: token }
    const resolved = resolveTableTokenQuery(query)

    expect(canonicalizeTableTokenQuery(query, resolved)).toEqual({
      page: '2',
      q: 'coffee',
      tableToken: token,
    })
  })
})
