// @vitest-environment node
//
// A config-level guard against stale admin URLs — the class of bug where a
// dashboard shortcut or sidebar link points at a resource that does not exist, or
// at the wrong *kind* of resource. The original offender was the customer
// dashboard's «ویرایش پیمایش» button linking to `/globals/header` while `header`
// is a tenant-scoped collection (registered `isGlobal` with the multi-tenant
// plugin), so the link 404'd.
//
// Every customer-facing admin link is now described as a typed `{ type, slug }`
// reference and turned into a URL by the shared `entityHref`/`createHref` helpers.
// This spec proves each such reference resolves against the *built* Payload config
// with the correct type, so a link can never again name a missing slug or spell a
// collection as a global. No database — it reads the static link maps and the
// config, exactly like `admin-visibility.int.spec.ts`.
import { describe, expect, it } from 'vitest'

import configPromise from '@/payload.config'
import {
  CUSTOMER_QUICK_ACTIONS,
  CUSTOMER_STAT_LINKS,
  CUSTOMER_STAT_SLUGS,
} from '@/admin/dashboardLinks'
import {
  createHref,
  CUSTOMER_NAV,
  entityHref,
  PLATFORM_NAV,
  type NavEntityRef,
} from '@/admin/navigation'

const loadConfig = async () => {
  const config = await configPromise
  return {
    collections: new Set((config.collections as { slug: string }[]).map((c) => c.slug)),
    globals: new Set((config.globals as { slug: string }[]).map((g) => g.slug)),
  }
}

/** Assert a reference names a real entity of the type it claims to be. */
const expectResolves = (
  ref: NavEntityRef,
  { collections, globals }: { collections: Set<string>; globals: Set<string> },
) => {
  if (ref.type === 'collection') {
    expect(collections, `collection "${ref.slug}" is not registered`).toContain(ref.slug)
    expect(globals, `"${ref.slug}" is a collection but was referenced as a global`).not.toContain(
      ref.slug,
    )
  } else {
    expect(globals, `global "${ref.slug}" is not registered`).toContain(ref.slug)
    expect(
      collections,
      `"${ref.slug}" is a collection but was referenced as a global`,
    ).not.toContain(ref.slug)
  }
}

describe('customer dashboard links resolve against the real config', () => {
  it('every quick action targets a registered collection', async () => {
    const cfg = await loadConfig()
    for (const action of CUSTOMER_QUICK_ACTIONS) {
      expect(action.entity.type, `${action.label} must link to a collection`).toBe('collection')
      expectResolves(action.entity, cfg)
    }
  })

  it('every stat tile targets a registered collection', async () => {
    const cfg = await loadConfig()
    for (const stat of CUSTOMER_STAT_LINKS) {
      expect(stat.entity.type).toBe('collection')
      expectResolves(stat.entity, cfg)
    }
  })

  it('the «ویرایش پیمایش» shortcut opens the header collection, never /globals/header', async () => {
    const cfg = await loadConfig()
    const nav = CUSTOMER_QUICK_ACTIONS.find((a) => a.entity.slug === 'header')
    expect(nav, 'the navigation shortcut is present').toBeTruthy()
    // Regression: header is a tenant-scoped collection, so its admin URL is
    // /collections/header. This is the exact bug this whole change fixes.
    expect(cfg.collections.has('header')).toBe(true)
    expect(cfg.globals.has('header')).toBe(false)
    expect(entityHref('/admin', nav!.entity)).toBe('/admin/collections/header')
    expect(entityHref('/admin', nav!.entity)).not.toContain('/globals/')
  })

  it('the counted slugs are exactly the stat tiles and are all real collections', async () => {
    const cfg = await loadConfig()
    expect(CUSTOMER_STAT_SLUGS).toEqual(CUSTOMER_STAT_LINKS.map((s) => s.entity.slug))
    for (const slug of CUSTOMER_STAT_SLUGS) expect(cfg.collections).toContain(slug)
  })

  it('createHref only ever builds collection create routes', () => {
    // Globals have no create route; a `create` action on a global would be broken.
    for (const action of CUSTOMER_QUICK_ACTIONS.filter((a) => a.create)) {
      expect(createHref('/admin', action.entity.slug)).toBe(
        `/admin/collections/${action.entity.slug}/create`,
      )
    }
  })
})

describe('every sidebar reference resolves with the correct type', () => {
  it('no CUSTOMER_NAV / PLATFORM_NAV entry names a missing slug or the wrong kind', async () => {
    const cfg = await loadConfig()
    for (const nav of [CUSTOMER_NAV, PLATFORM_NAV]) {
      for (const group of nav) {
        for (const entity of group.entities) expectResolves(entity, cfg)
      }
    }
  })
})
