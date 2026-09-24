// @vitest-environment node
//
// The pure, request-shaped access predicates the whole platform layers on top of.
// These take a user (or a `{ req: { user } }`) and return a boolean or a Where
// filter — no database — so they are unit-testable directly. The DB-backed,
// tenant-scoped access (siteRead, siteApiKey, publish) is exercised against real
// requests in `tenancy.int.spec.ts`, `api-keys.int.spec.ts` and
// `platform-saas.int.spec.ts`; this file locks the predicates those build on.
import { describe, expect, it } from 'vitest'

import { anyone } from '@/access/anyone'
import { authenticated } from '@/access/authenticated'
import { authenticatedOrPublished } from '@/access/authenticatedOrPublished'
import {
  isPlatformAdmin,
  platformAdmin,
  platformAdminFieldAccess,
} from '@/access/platformAdmin'

const operator = { id: 'op', role: 'platformAdmin' }
const siteAdmin = { id: 'a', role: 'user', tenants: [{ role: 'owner', tenant: 'siteA' }] }
const siteEditor = { id: 'e', role: 'user', tenants: [{ role: 'editor', tenant: 'siteA' }] }

// Access functions read `req.user`; build the minimal shape they touch.
const req = (user: unknown) => ({ req: { user } }) as never

describe('isPlatformAdmin', () => {
  it('is true only for the platformAdmin role', () => {
    expect(isPlatformAdmin(operator)).toBe(true)
    expect(isPlatformAdmin(siteAdmin)).toBe(false)
    expect(isPlatformAdmin(siteEditor)).toBe(false)
    expect(isPlatformAdmin(null)).toBe(false)
    expect(isPlatformAdmin(undefined)).toBe(false)
    expect(isPlatformAdmin({ role: 'admin' })).toBe(false)
  })
})

describe('platformAdmin access', () => {
  it('admits only a platform admin, and never a customer or anonymous caller', () => {
    expect(platformAdmin(req(operator))).toBe(true)
    expect(platformAdmin(req(siteAdmin))).toBe(false)
    expect(platformAdmin(req(siteEditor))).toBe(false)
    expect(platformAdmin(req(null))).toBe(false)
  })

  it('gates field access the same way', () => {
    expect(platformAdminFieldAccess(req(operator))).toBe(true)
    expect(platformAdminFieldAccess(req(siteAdmin))).toBe(false)
    expect(platformAdminFieldAccess(req(null))).toBe(false)
  })
})

describe('authenticated access', () => {
  it('admits any signed-in user and refuses anonymous', () => {
    expect(authenticated(req(operator))).toBe(true)
    expect(authenticated(req(siteEditor))).toBe(true)
    expect(authenticated(req(null))).toBe(false)
    expect(authenticated(req(undefined))).toBe(false)
  })
})

describe('authenticatedOrPublished access', () => {
  it('lets a signed-in user read anything', () => {
    expect(authenticatedOrPublished(req(operator))).toBe(true)
  })

  it('narrows an anonymous read to published documents only', () => {
    expect(authenticatedOrPublished(req(null))).toEqual({ _status: { equals: 'published' } })
  })
})

describe('anyone access', () => {
  it('always admits', () => {
    expect(anyone(req(null))).toBe(true)
    expect(anyone(req(operator))).toBe(true)
  })
})
