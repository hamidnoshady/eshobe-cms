import { draftMode } from 'next/headers'
import { cache } from 'react'

import type { Redirect, Site } from '@/payload-types'

import { normalizeRedirectPath } from '@/lib/migration/redirects'
import { getSiteContext, getViewer } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'
import { POSTS_BASE } from '@/lib/slug'
import { siteUrl } from '@/lib/site-url'

/**
 * The built-in renderer's half of the `redirects` collection.
 *
 * Payload's redirects plugin is only a table; without this lookup an editor
 * (or the Migration Center applying a verified WordPress URL inventory) can
 * save a rule that the public site never answers. The lookup is deliberately
 * one hop: chains advance one request at a time, a self-rule is ignored, and
 * reconciliation — not request handling — is where cycles are reported.
 */

const pathFromSegments = (path: string[] | undefined): string =>
  normalizeRedirectPath(path?.length ? `/${path.join('/')}` : '/')

const sourceCandidates = (path: string[] | undefined): { candidates: string[]; normalized: string } => {
  const normalized = pathFromSegments(path)
  const encoded = path?.length
    ? `/${path.map((segment) => encodeURIComponent(segment)).join('/')}`
    : '/'
  const candidates = new Set([
    normalized,
    encoded,
    normalized.replace(/^\//, ''),
    encoded.replace(/^\//, ''),
  ])

  if (normalized !== '/') {
    candidates.add(`${normalized}/`)
    candidates.add(`${encoded}/`)
  }

  return { candidates: [...candidates].filter(Boolean), normalized }
}

const withIncomingQuery = (target: string, search: string): string => {
  if (!search || target.includes('?')) return target

  const hashIndex = target.indexOf('#')
  if (hashIndex === -1) return `${target}?${search}`

  return `${target.slice(0, hashIndex)}?${search}${target.slice(hashIndex)}`
}

const encodePath = (path: string): string =>
  path === '/'
    ? path
    : `/${path
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`

const referencedSlug = async (
  siteId: string,
  locale: Parameters<typeof findForSite>[2]['locale'],
  reference: NonNullable<NonNullable<Redirect['to']>['reference']>,
): Promise<null | string> => {
  if (typeof reference.value === 'object' && reference.value !== null) {
    return typeof reference.value.slug === 'string' ? reference.value.slug : null
  }

  if (typeof reference.value !== 'string' || !reference.value) return null

  const { docs } = await findForSite(reference.relationTo, siteId, {
    cachePublic: true,
    depth: 0,
    limit: 1,
    locale,
    pagination: false,
    select: { slug: true },
    where: { id: { equals: reference.value } },
  })
  const slug = (docs[0] as undefined | { slug?: unknown })?.slug

  return typeof slug === 'string' ? slug : null
}

const targetFor = async ({
  locale,
  redirect,
  site,
}: {
  locale: Parameters<typeof findForSite>[2]['locale']
  redirect: Redirect
  site: Site
}): Promise<null | string> => {
  const to = redirect.to
  if (!to) return null

  if (to.type === 'reference' && to.reference) {
    const slug = await referencedSlug(site.id, locale, to.reference)
    if (!slug) return null

    return to.reference.relationTo === 'posts'
      ? siteUrl(site, { base: POSTS_BASE, locale, slug })
      : siteUrl(site, { locale, slug })
  }

  const raw = typeof to.url === 'string' ? to.url.trim() : ''
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw

  const suffixIndex = raw.search(/[?#]/)
  const suffix = suffixIndex === -1 ? '' : raw.slice(suffixIndex)
  const targetPath = encodePath(normalizeRedirectPath(raw))

  return `${targetPath}${suffix}`
}

export const querySiteRedirect = cache(
  async (path: string[] | undefined, search = ''): Promise<null | string> => {
    const { locale, serving, site } = await getSiteContext()
    if (!site || !serving) return null

    // A signed-in editor previewing a draft is trying to see the document at
    // this path, not be sent along the public retirement rule for it.
    const { isEnabled: draft } = await draftMode()
    if (draft && (await getViewer())) return null

    const { candidates, normalized } = sourceCandidates(path)
    const { docs } = await findForSite('redirects', site.id, {
      cachePublic: true,
      depth: 1,
      limit: candidates.length,
      locale,
      pagination: false,
      select: {
        from: true,
        to: { reference: true, type: true, url: true },
      },
      where: { from: { in: candidates } },
    })
    const redirect = docs.find((doc) => normalizeRedirectPath(doc.from) === normalized)
    if (!redirect) return null

    const target = await targetFor({ locale, redirect, site })
    if (!target) return null

    // A rule whose destination is this same site path would be an infinite
    // browser loop. External targets and localized reference URLs are not
    // reduced to a path here; only the exact internal self-rule is ignored.
    if (target.startsWith('/') && normalizeRedirectPath(target) === normalized) return null

    return withIncomingQuery(target, search)
  },
)
