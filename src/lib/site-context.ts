import type { TypedLocale, TypedUser } from 'payload'

import configPromise from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'
import { cache } from 'react'

import type { Site } from '@/payload-types'

import { defaultLocale, dirFor, isLocale } from '@/lib/locales'
import { getSiteByHost } from '@/lib/site-query'

/**
 * Who is being served, in what language. Every front-end render starts here.
 *
 * Separate from `site-query.ts` on purpose: this module touches `next/headers`,
 * which throws outside a request, and the query helpers must stay importable from
 * tests and CLI scripts.
 */
export type SiteContext = {
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

  const site = await getSiteByHost(headerList.get('host'))
  // Set by middleware from the URL's locale segment. Absent on requests that
  // have not been through routing yet, and on an unknown host.
  const locale = resolveLocale(site, headerList.get('x-locale'))

  return {
    dir: dirFor(locale),
    locale: locale as TypedLocale,
    site,
    serving: site?.status === 'active',
  }
})

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
