import { notFound } from 'next/navigation'
import React from 'react'

import { ContentTermArchive, ContentTypeArchive, TaxonomyIndex } from './ContentArchives'
import { ContentEntryDetail } from './ContentEntryDetail'
import { queryContentRoute } from './contentQueries'

/**
 * The custom-content half of the page route (issue #166 §3).
 *
 * Reached only when the CMS page lookup missed — pages keep priority over
 * every archive base, so an editor's page can never be shadowed by a content
 * type claiming its first segment. What remains is matched against the
 * site's own definitions (`matchContentRoute`); no match is an honest 404,
 * exactly where an unknown slug always ended.
 */
export const ContentFallback: React.FC<{ page?: number; slug: string }> = async ({
  page = 1,
  slug,
}) => {
  const match = await queryContentRoute(slug.split('/').filter(Boolean))

  if (!match) notFound()

  switch (match.kind) {
    case 'entry':
      return <ContentEntryDetail match={match} />

    case 'taxonomy-index':
      return <TaxonomyIndex match={match} />

    case 'term-archive':
      return <ContentTermArchive match={match} page={page} />

    case 'type-archive':
      return <ContentTypeArchive match={match} page={page} />
  }
}
