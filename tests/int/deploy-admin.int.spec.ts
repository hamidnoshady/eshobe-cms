import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { DeployTargets } from '@/collections/DeployTargets'
import { Sites } from '@/collections/Sites'
import { ThemePackages } from '@/collections/ThemePackages'

/**
 * The admin wiring for the Wave 11 operator surface.
 *
 * Config assertions rather than rendering, because the failure these guard against is
 * a *config* one and it is completely silent: a document view whose tab omits `href`
 * still renders fine at its own URL, so every manual check passes — while the only
 * link to it points at the document root. It was found by curling the real page and
 * reading the emitted anchor, and nothing else would have caught it.
 *
 * `DefaultDocumentTab` in `@payloadcms/next` reads `tab.href` and nothing else; the
 * view's own `path` is used only for route *matching*. `DocumentTabLink` then joins
 * them as `docPath + href`, which is why the value here is a bare suffix and not an
 * absolute URL.
 */

type ViewRecord = Record<string, { Component?: unknown; path?: string; tab?: Record<string, unknown> }>

const sitesViews = Sites.admin?.components?.views as Record<string, unknown> | undefined
const editViews = sitesViews?.edit as ViewRecord | undefined

describe('the deployment document view on sites', () => {
  it('is registered as an edit view at /deployment', () => {
    expect(editViews?.deployment?.path).toBe('/deployment')
    expect(editViews?.deployment?.Component).toBe('@/deploy/admin/DeploymentView')
  })

  it('gives its tab an href, without which the tab silently points at the document root', () => {
    const tab = editViews?.deployment?.tab

    expect(tab?.href).toBe('/deployment')
    // A relative suffix, because `DocumentTabLink` concatenates it onto the document
    // path. An absolute '/admin/...' here would produce '/admin/collections/sites/:id/admin/...'.
    expect(String(tab?.href).startsWith('/admin')).toBe(false)
  })

  it('hides the tab from anyone who is not platform staff', () => {
    const condition = editViews?.deployment?.tab?.condition as
      | ((args: unknown) => boolean)
      | undefined

    expect(typeof condition).toBe('function')
    expect(condition?.({ req: { user: { role: 'platformAdmin' } } })).toBe(true)
    expect(condition?.({ req: { user: { role: 'user' } } })).toBe(false)
    // An anonymous request must not throw its way past the check.
    expect(condition?.({ req: {} })).toBe(false)
    expect(condition?.({})).toBe(false)
  })
})

describe('the catalogue action panels', () => {
  const uiField = (collection: { fields: unknown[] }, name: string) =>
    (collection.fields as Record<string, unknown>[]).find((field) => field.name === name)

  it('puts the sync/publish panel on theme-packages', () => {
    const field = uiField(ThemePackages, 'actions') as
      | undefined
      | { admin?: { components?: { Field?: unknown } }; type?: string }

    expect(field?.type).toBe('ui')
    expect(field?.admin?.components?.Field).toBe('@/deploy/admin/ThemePackageActions')
  })

  it('puts the self-test panel on deploy-targets', () => {
    const field = uiField(DeployTargets, 'actions') as
      | undefined
      | { admin?: { components?: { Field?: unknown } }; type?: string }

    expect(field?.type).toBe('ui')
    expect(field?.admin?.components?.Field).toBe('@/deploy/admin/DeployTargetActions')
  })

  it('passes the document id in the self-test POST body', () => {
    // Silent failure: ActionButton without `body` → empty POST → 400 about an
    // invalid id, which operators read as Coolify's serverUuid being wrong.
    // The endpoint needs the Payload document id; Coolify ids are nanoid-style.
    const source = readFileSync('src/deploy/admin/DeployTargetActions.tsx', 'utf8')

    expect(source).toContain('/api/deploy-targets/self-test')
    expect(source).toMatch(/body=\{\{\s*id\s*\}\}/)
  })

  it('keeps both panels first, so the action is above the fields it acts on', () => {
    // Not cosmetic: the sync button rewrites the manifest-derived fields below it, and
    // an operator who has to scroll past twenty read-only inputs to find the button
    // that populates them will reasonably conclude the form is broken.
    expect((ThemePackages.fields[0] as { name?: string }).name).toBe('actions')
    expect((DeployTargets.fields[0] as { name?: string }).name).toBe('actions')
  })
})
