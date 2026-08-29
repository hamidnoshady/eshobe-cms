import React from 'react'

import { formatNumber } from '@/lib/format'
import { getSiteContext } from '@/lib/site-context'
import { uiString } from '@/lib/ui-strings'

/**
 * "نمایش ۱ تا ۴ از ۱۲ نوشته" / "Showing 1 - 4 of 12 posts".
 *
 * Rewritten rather than reused as the template shipped it, for two reasons that are
 * both platform rules rather than taste: the sentence was English-only, and the numbers
 * were interpolated raw — Latin digits on a Persian page, which `CLAUDE.md` forbids for
 * *every* rendered number. So both go through `formatNumber` and the site's locale, and
 * the plural switch is dropped for Persian (Farsi has no two-form plural like English's
 * `post`/`posts`; `itemLabel` is already the right shape for either count).
 */
export const PageRange: React.FC<{
  className?: string
  currentPage?: number
  /** Defaults to the site's "nothing found" line. */
  emptyLabel?: string
  itemLabel?: string
  limit?: number
  totalDocs?: number
}> = async ({ className, currentPage, emptyLabel, itemLabel, limit, totalDocs }) => {
  const { locale } = await getSiteContext()

  const indexStart = (currentPage ? currentPage - 1 : 1) * (limit || 1) + 1
  const start = totalDocs && indexStart > totalDocs ? 0 : indexStart
  const indexEnd = Math.min((currentPage || 1) * (limit || 1), totalDocs ?? Number.MAX_SAFE_INTEGER)

  // `!totalDocs`, not a range comparison: an absent total and a zero total are the same
  // message, and computing "1 – 0 of 0" for an empty result set is the bug the original
  // condition was fiddling around.
  const isEmpty = !totalDocs

  const number = (value: number) => formatNumber(value, locale)

  const sentence = isEmpty
    ? (emptyLabel ?? uiString('noResults', locale))
    : locale === 'fa'
      ? [
          uiString('showing', locale),
          number(start),
          uiString('to', locale),
          number(indexEnd),
          uiString('of', locale),
          number(totalDocs ?? 0),
          itemLabel ?? uiString('posts', locale),
        ].join(' ')
      : `Showing ${number(start)} - ${number(indexEnd)} of ${number(totalDocs ?? 0)} ${
          itemLabel ?? 'posts'
        }`

  return <div className={[className, 'text-sm font-semibold'].filter(Boolean).join(' ')}>{sentence}</div>
}
