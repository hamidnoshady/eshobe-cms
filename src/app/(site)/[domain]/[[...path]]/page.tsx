import type { Metadata } from 'next'

import { notFound } from 'next/navigation'
import React from 'react'

import { SiteHolding } from '@/components/SiteHolding'
import { POSTS_BASE, PRODUCTS_BASE } from '@/lib/slug'
import { resolveSiteRoute } from '@/lib/site-route'
import { getSiteContext, localeIsServed } from '@/lib/site-context'
import { siteUrl } from '@/lib/site-url'
import { uiString } from '@/lib/ui-strings'
import { generateMeta } from '@/utilities/generateMeta'

import { CheckoutReceipt, checkoutMetadata } from './CheckoutReceipt'
import { PostDetail } from './PostDetail'
import { PostsIndex } from './PostsIndex'
import { ProductDetail } from './ProductDetail'
import { queryPage, queryPost, queryProduct } from './queries'
import { SearchResults } from './SearchResults'
import { SitePage } from './SitePage'

/**
 * Every URL a customer's domain serves, in one resolver.
 *
 * Middleware rewrites the `Host` into `params.domain`; `getSiteContext()` reads the same
 * header, so the param is routing bookkeeping and the site is resolved once per request.
 *
 * One optional catch-all rather than a `[locale]` folder: bare `/` has to work on every
 * site, and a `[locale]` segment would need a redirect for it. And one resolver for the
 * site's *own* routes (`/posts`, `/posts/<slug>`, `/search`, `/checkout/<order>`) rather
 * than sibling folders, for the reason documented in `src/lib/site-route.ts`: a static
 * segment under `[domain]` cannot also sit behind a locale prefix, so `/en/posts` would
 * work only by accident of which route Next matched first.
 */
type Args = {
  params: Promise<{ domain: string; path?: string[] }>
  searchParams: Promise<{ m?: string; page?: string; q?: string; r?: string }>
}

/** `?page=3`, floored at 1 and unbothered by `?page=elephant`. */
const pageNumber = (value: string | string[] | undefined): number => {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0]! : (value ?? '1'), 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export default async function SiteRoute({ params, searchParams }: Args) {
  const { path } = await params
  const { serving, site } = await getSiteContext()

  /**
   * A suspended or archived site answers on *every* path — its lifecycle is a
   * status, not a delete — but with a holding page, not its content. This branch
   * precedes the locale check on purpose: a suspension is site-level, and
   * `/en` on a suspended fa-only site should hold, not 404.
   */
  if (site && !serving) {
    return <SiteHolding siteName={site.name} status={site.status === 'archived' ? 'archived' : 'suspended'} />
  }

  if (!(await localeIsServed(path))) notFound()

  const query = await searchParams
  const route = resolveSiteRoute(path)

  switch (route.kind) {
    case 'checkout':
      return (
        <CheckoutReceipt
          order={route.order}
          outcome={query.m}
          receipt={query.r}
        />
      )

    case 'post':
      return <PostDetail slug={route.slug} />

    case 'posts':
      return <PostsIndex page={pageNumber(query.page)} />

    case 'product':
      return <ProductDetail slug={route.slug} />

    case 'search':
      return <SearchResults page={pageNumber(query.page)} q={query.q} />

    case 'page':
      return <SitePage slug={route.slug} />
  }
}

export async function generateMetadata({ params }: Args): Promise<Metadata> {
  const { path } = await params
  const { serving, site } = await getSiteContext()

  // A holding page must not rank or get cached as the site's answer.
  if (site && !serving) {
    return { robots: { follow: false, index: false }, title: site.name }
  }

  if (!(await localeIsServed(path))) return {}

  const route = resolveSiteRoute(path)

  switch (route.kind) {
    case 'checkout':
      return checkoutMetadata

    case 'post': {
      const post = await queryPost(route.slug)

      // A missing post falls through to `notFound()` in the body; metadata for a 404 is
      // noise, and an empty object is how the template avoids inventing a title.
      if (!post) return {}

      return generateMeta({ base: POSTS_BASE, doc: post })
    }

    case 'posts': {
      const { locale, site } = await getSiteContext()

      return {
        alternates: site
          ? { canonical: siteUrl(site, { base: POSTS_BASE, locale }) }
          : undefined,
        title: [uiString('postsHeading', locale), site?.name].filter(Boolean).join(' | '),
      }
    }

    case 'product': {
      const product = await queryProduct(route.slug)
      if (!product) return {}
      const { locale, site } = await getSiteContext()
      const url = site ? siteUrl(site, { base: PRODUCTS_BASE, locale, slug: product.slug }) : undefined
      return {
        alternates: url ? { canonical: url } : undefined,
        description: product.summary ?? undefined,
        title: [product.title, site?.name].filter(Boolean).join(' | '),
      }
    }

    case 'search': {
      const { locale } = await getSiteContext()

      return {
        // A result page is not content: indexing every `?q=` permutation hands a
        // crawler an infinite set of near-identical pages, and Google has punished
        // sites for less.
        robots: 'noindex, follow',
        title: uiString('searchPosts', locale),
      }
    }

    case 'page':
      return generateMeta({ doc: await queryPage(route.slug) })
  }
}
