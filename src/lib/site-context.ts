import type { TypedLocale, TypedUser } from 'payload'

import configPromise from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'
import { cache } from 'react'

import type { Site } from '@/payload-types'

import { defaultLocale, dirFor, isLocale } from '@/lib/locales'
import { hostFromHeader } from '@/lib/domains'
import { getSiteHostResolution } from '@/lib/site-query'

/**
 * Who is being served, in what language. Every front-end render starts here.
 *
 * Separate from `site-query.ts` on purpose: this module touches `next/headers`,
 * which throws outside a request, and the query helpers must stay importable from
 * tests and CLI scripts.
 */
export type SiteContext = {
  /** The normalized inbound host, without its development port. */
  host: string
  /** True only when `host` is the site's primary/canonical domain. */
  canonicalHost: boolean
  dir: 'ltr' | 'rtl'
  locale: TypedLocale
  /** The site on this host, whatever its lifecycle state — null on an unknown host. */
  site: Site | null
  /**
   * False when the site is suspended or archived. The site still resolves (the
   * holding page needs its name and locales) but serves no content: every
   * content read requires `serving`, and the shell drops its chrome.
   */
  serving: boolean
}

/** The site's own default, unless the request asked for a locale the site serves. */
const resolveLocale = (site: Site | null, requested: string | null): string => {
  const served: string[] = site?.availableLocales ?? []

  if (requested && isLocale(requested) && served.includes(requested)) return requested

  return site?.defaultLocale ?? defaultLocale
}

export const getSiteContext = cache(async (): Promise<SiteContext> => {
  const headerList = await headers()
  const host = hostFromHeader(headerList.get('host'))
  const resolved = await getSiteHostResolution(host)
  const site = resolved?.site ?? null

  // Set by middleware from the URL's locale segment. Absent on requests that
  // have not been through routing yet, and on an unknown host.
  const locale = resolveLocale(site, headerList.get('x-locale'))

  return {
    canonicalHost: resolved?.canonical ?? false,
    dir: dirFor(locale),
    host,
    locale: locale as TypedLocale,
    site,
    serving: site?.status === 'active',
  }
})

/**
 * A locale segment the site does not serve is not a route.
 *
 * Without this, `getSiteContext()` quietly falls back to the site's default locale and
 * `studio.localhost/en` serves studio's Persian home — duplicate content on a URL that
 * should not exist. Shared by all four site routes (`[[...path]]`, `/posts`,
 * `/posts/[slug]`, `/search`) because a guard copied four times is a guard skipped
 * once.
 */
export const localeIsServed = async (path: string[] = []): Promise<boolean> => {
  if (!isLocale(path[0])) return true

  const { site } = await getSiteContext()

  // Widened on purpose: the needle is an arbitrary URL segment, not a known locale.
  const served: string[] = site?.availableLocales ?? []

  return served.includes(path[0]!)
}

/**
 * Who is asking, from the `payload-token` cookie. Only draft reads need it: a
 * published read is anonymous by design, and `findForSite` passes the viewer to
 * `overrideAccess: false` so the *plugin* decides which sites they may see —
 * being logged in as one customer must not reveal another's drafts.
 */
export const getViewer = cache(async (): Promise<TypedUser | null> => {
  const payload = await getPayload({ config: configPromise })
  const { user } = await payload.auth({ headers: await headers() })

  return user
})
