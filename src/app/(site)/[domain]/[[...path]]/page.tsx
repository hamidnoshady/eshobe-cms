import type { Metadata } from 'next'

import { draftMode } from 'next/headers'
import { notFound } from 'next/navigation'
import React, { cache } from 'react'

import type { Page } from '@/payload-types'

import { RenderBlocks } from '@/blocks/RenderBlocks'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { RenderHero } from '@/heros/RenderHero'
import { isLocale } from '@/lib/locales'
import { HOME_SLUG } from '@/lib/slug'
import { getSiteContext, getViewer } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'
import { generateMeta } from '@/utilities/generateMeta'

/**
 * Every customer page, on every domain. Middleware rewrites the `Host` into
 * `params.domain`; `getSiteContext()` reads the same `Host` header, so the param is
 * routing bookkeeping and the site is resolved once per request.
 *
 * One optional catch-all rather than a `[locale]` folder: bare `/` has to work on
 * every site, and a `[locale]` segment would need a redirect for it.
 */
type Args = {
  params: Promise<{ domain: string; path?: string[] }>
}

/** `['en', 'about']` → `about`; `[]` → `home`. The locale is `x-locale`'s job. */
const slugFromPath = (path: string[] = []): string => {
  const segments = isLocale(path[0]) ? path.slice(1) : path
  const slug = segments.map(decodeURIComponent).join('/')

  return slug || HOME_SLUG
}

const queryPage = cache(async (slug: string): Promise<Page | null> => {
  const { isEnabled: draft } = await draftMode()
  const { locale, site } = await getSiteContext()

  if (!site) return null

  const { docs } = await findForSite('pages', site.id, {
    draft,
    limit: 1,
    locale,
    pagination: false,
    // Anonymous on a published read. On a draft read the viewer is what lets the
    // plugin narrow to *their* sites — without it a preview link would be a
    // cross-tenant draft reader.
    user: draft ? await getViewer() : null,
    where: { slug: { equals: slug } },
  })

  return docs[0] ?? null
})

/**
 * A locale segment the site does not serve is not a route. Without this,
 * `getSiteContext` quietly falls back to the site's default locale and
 * `studio.localhost/en` would serve studio's Persian home — duplicate content on a
 * URL that should not exist.
 */
const localeIsServed = async (path: string[] = []): Promise<boolean> => {
  if (!isLocale(path[0])) return true

  const { site } = await getSiteContext()

  // Widened on purpose: the needle is an arbitrary URL segment, not a known locale.
  const served: string[] = site?.availableLocales ?? []

  return served.includes(path[0]!)
}

export default async function SitePage({ params }: Args) {
  const { isEnabled: draft } = await draftMode()
  const { path } = await params

  if (!(await localeIsServed(path))) notFound()

  const page = await queryPage(slugFromPath(path))

  if (!page) notFound()

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <RenderHero {...page.hero} />
      <RenderBlocks blocks={page.layout} />
    </article>
  )
}

export async function generateMetadata({ params }: Args): Promise<Metadata> {
  const { path } = await params

  if (!(await localeIsServed(path))) return {}

  return generateMeta({ doc: await queryPage(slugFromPath(path)) })
}
