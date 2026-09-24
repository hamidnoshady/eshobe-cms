import { getTranslation } from '@payloadcms/translations'
import { RenderServerComponent } from '@payloadcms/ui/elements/RenderServerComponent'
import React from 'react'
import type { ServerProps } from 'payload'

import { resolveNavGroups, type ResolvedNavGroup } from '../navigation'
import { EshobeNavClient } from './EshobeNav.client'

type NavServerProps = ServerProps & {
  documentSubViewType?: unknown
  viewType?: unknown
  visibleEntities?: { collections: string[]; globals: string[] }
}

/**
 * Eshobe's audience-aware sidebar, registered as `admin.components.Nav`.
 *
 * Payload's default nav groups entities by their static `admin.group`, which
 * cannot give a shared collection two labels or model product-oriented grouping.
 * This resolves the sidebar from `src/admin/navigation.ts` instead, then hands a
 * serializable group list to the client half. `admin.hidden` still decides *what*
 * is visible (`visibleEntities`); this only decides *where* and *how* it reads.
 *
 * The `beforeNav` slot (where the multi-tenant plugin injects the site selector)
 * is re-rendered here so replacing the default nav does not drop it.
 */
const EshobeNav = async (props: NavServerProps): Promise<React.ReactNode> => {
  const { i18n, locale, params, payload, permissions, searchParams, user, visibleEntities } = props

  if (!payload?.config) return null

  const adminRoute = payload.config.routes?.admin ?? '/admin'
  const visible = visibleEntities ?? { collections: [], globals: [] }

  const groups = resolveNavGroups({ adminRoute, user, visible })

  // Fill any label the map left to the config (leftovers/escape-hatch entities).
  const collectionLabel = (slug: string): string => {
    const c = payload.config.collections.find((x) => x.slug === slug)
    return c ? getTranslation(c.labels?.plural ?? c.slug, i18n) : slug
  }
  const globalLabel = (slug: string): string => {
    const g = payload.config.globals.find((x) => x.slug === slug)
    return g ? getTranslation(g.label ?? g.slug, i18n) : slug
  }

  const resolved: ResolvedNavGroup[] = groups.map((group) => ({
    label: group.label,
    entities: group.entities.map((e) => ({
      ...e,
      label: e.label ?? (e.type === 'collection' ? collectionLabel(e.slug) : globalLabel(e.slug)),
    })),
  }))

  const beforeNav = payload.config.admin?.components?.beforeNav
  const RenderedBeforeNav = beforeNav
    ? RenderServerComponent({
        clientProps: { documentSubViewType: props.documentSubViewType, viewType: props.viewType },
        Component: beforeNav,
        importMap: payload.importMap,
        serverProps: { i18n, locale, params, payload, permissions, searchParams, user },
      })
    : null

  return <EshobeNavClient beforeNav={RenderedBeforeNav} groups={resolved} />
}

export default EshobeNav
