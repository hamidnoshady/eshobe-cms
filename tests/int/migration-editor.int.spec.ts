// @vitest-environment node
//
// Issue #236, asserted against the *built* Payload config rather than a browser.
//
// Three properties are checked here, and all three are config, not CSS:
//
//  1. The «منشأ و مهاجرت» provenance group is `admin.hidden` on every collection
//     that carries it — so no create/edit view renders it, not even collapsed.
//  2. `source` is write-protected (`access.create`/`access.update` are false).
//     Payload deletes a denied field from the incoming data and, on update,
//     restores the stored value, so an ordinary save — admin or REST — can
//     never rewrite an import's origin. The import engine still writes it with
//     `overrideAccess: true`.
//  3. Every such collection pairs it with the read-only, conditional
//     `migrationDetails` ui field, so imported records keep an on-demand view
//     and native records show nothing.
//
// The runtime half (a real update preserving `source`) is exercised by the
// Postgres-backed migration/tenancy suites in CI; this spec needs no database.
import { describe, expect, it } from 'vitest'

import type { Field } from 'payload'

import { resolveNavGroups } from '@/admin/navigation'
import configPromise from '@/payload.config'

type Loose = Record<string, unknown>

const fieldList = (fields: unknown): Field[] => (Array.isArray(fields) ? (fields as Field[]) : [])

/** Depth-first through every container a `Field` can nest in. */
const walk = (fields: unknown, visit: (field: Field) => void): void => {
  for (const field of fieldList(fields)) {
    visit(field)
    const nested = field as Loose & { fields?: unknown; blocks?: { fields?: unknown }[] }
    if (nested.fields) walk(nested.fields, visit)
    if (Array.isArray(nested.blocks)) {
      for (const block of nested.blocks) walk(block?.fields, visit)
    }
  }
}

const findNamed = (fields: unknown, name: string): Field | undefined => {
  let found: Field | undefined
  walk(fields, (field) => {
    if (!found && 'name' in field && (field as { name?: string }).name === name) found = field
  })
  return found
}

const asLoose = (field: Field): Loose => field as unknown as Loose

describe('provenance is import metadata, not an editor field', () => {
  it('hides «منشأ و مهاجرت» and denies ordinary writes on every collection that carries it', async () => {
    const config = await configPromise
    const withProvenance: string[] = []

    for (const collection of config.collections) {
      const source = findNamed(collection.fields, 'source')
      if (!source || (source as { label?: string }).label !== 'منشأ و مهاجرت') continue
      withProvenance.push(collection.slug)

      expect(source.type, `${collection.slug}.source must be a group`).toBe('group')
      expect(asLoose(source).admin, `${collection.slug}.source admin`).toMatchObject({
        hidden: true,
      })

      const access = asLoose(source).access as {
        create?: (args: unknown) => unknown
        update?: (args: unknown) => unknown
      }
      // A caller with no privileges, and a caller with a tenant user — neither
      // may write provenance. `overrideAccess` is the service door.
      expect(access.create?.({ req: { user: null } }), `${collection.slug} create`).toBe(false)
      expect(access.create?.({ req: { user: { id: 'u', role: 'editor' } } }), `${collection.slug} create (staff)`).toBe(false)
      expect(access.update?.({ req: { user: { id: 'u', role: 'editor' } } }), `${collection.slug} update`).toBe(false)

      // `rawPayload` keeps its staff-only read; nothing here widens it.
      const raw = findNamed(asLoose(source).fields, 'rawPayload')
      expect(raw, `${collection.slug}.source.rawPayload`).toBeDefined()
      const rawRead = asLoose(raw!).access as { read?: (args: unknown) => unknown }
      expect(rawRead.read?.({ req: { user: null } })).toBe(false)
      expect(rawRead.read?.({ req: { user: { id: 'u' } } })).toBe(true)

      // The on-demand replacement travels with the hidden group.
      const details = findNamed(collection.fields, 'migrationDetails')
      expect(details, `${collection.slug} must pair source with migrationDetails`).toBeDefined()
      expect(details!.type).toBe('ui')
      expect(asLoose(details!).admin).toMatchObject({
        components: { Field: '@/admin/fields/MigrationDetails#MigrationDetails' },
      })
    }

    // Every normal content editor the issue named, and no silent regressions
    // where the group was removed instead of hidden.
    for (const slug of [
      'pages',
      'posts',
      'products',
      'media',
      'categories',
      'menus',
      'taxonomy-definitions',
      'taxonomy-terms',
      'content-entries',
    ]) {
      expect(withProvenance, `${slug} keeps its provenance group`).toContain(slug)
    }
  })

  it('shows migration details only for imported records', async () => {
    const config = await configPromise
    const pages = config.collections.find((collection) => collection.slug === 'pages')
    const details = findNamed(pages?.fields, 'migrationDetails')
    const condition = (asLoose(details!).admin as { condition?: (data: Loose) => boolean }).condition

    expect(condition, 'migrationDetails must be conditional').toBeTypeOf('function')
    expect(condition!({})).toBe(false)
    expect(condition!({ source: { system: 'eshobe' } })).toBe(false)
    expect(condition!({ source: { system: 'wordpress' } })).toBe(true)
    expect(condition!({ source: { system: 'woocommerce' } })).toBe(true)
  })
})

describe('one Imports entry', () => {
  it('puts the WordPress/WooCommerce manager under ابزارها and nothing else', async () => {
    const config = await configPromise
    const editor = { email: 'editor@site.test', id: 'editor', role: 'editor' }

    const groups = resolveNavGroups({
      adminRoute: '/admin',
      siteType: 'store',
      user: editor,
      visible: {
        collections: config.collections
          .filter((collection) => {
            const hidden = (collection.admin as { hidden?: unknown } | undefined)?.hidden
            return typeof hidden === 'function'
              ? !(hidden as (args: { user: unknown }) => boolean)({ user: editor })
              : !hidden
          })
          .map((collection) => collection.slug),
        globals: [],
      },
    })

    const tools = groups.find((group) => group.label === 'ابزارها')
    expect(tools, 'the customer nav must have one ابزارها group').toBeDefined()
    const imports = tools!.entities.filter((entity) => entity.slug === 'migration-center')
    expect(imports).toHaveLength(1)
    expect(imports[0].label).toBe('درون‌ریزی (وردپرس / ووکامرس)')
    expect(imports[0].href).toBe('/admin/migration-center')

    // No competing import surface anywhere in the sidebar.
    const all = groups.flatMap((group) => group.entities.map((entity) => entity.slug))
    expect(all.filter((slug) => /import|migration-(center|hub|manager)|wordpress-import/.test(slug))).toEqual([
      'migration-center',
    ])
  })
})
