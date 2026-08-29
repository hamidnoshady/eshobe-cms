import type { TypedLocale } from 'payload'

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { ImageResponse } from 'next/og'

import type { Site } from '@/payload-types'

import { dirFor } from '@/lib/locales'
import { HOME_SLUG } from '@/lib/slug'
import { getSiteContext } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'

/**
 * `https://acme.com/og?slug=about&locale=en` — the social card for one document, on
 * one site, in one locale.
 *
 * Per locale because the card *is* the document's title: the Persian and English
 * versions of a page are different words, in different scripts, reading in opposite
 * directions. A single card per document would show one of them to everybody.
 *
 * The title is read from the database by slug rather than taken from the query
 * string. A `?title=` parameter would let anyone render arbitrary text on the
 * customer's branded card and post the link as if the site had published it.
 */

/**
 * Vazirmatn, vendored as `.woff` next to this route.
 *
 * Satori cannot use the fonts `next/font` downloads: those are `woff2`, which it
 * does not decode. It also has no system fonts, so a missing face is not a fallback
 * but a card full of blank boxes — on a Persian-first platform, that is every card.
 * The arabic and latin subsets are both loaded at each weight because a title can
 * mix scripts, and each subset only carries its own. They are registered under
 * *different family names*, with `fontFamily` listing both: satori keys a face by
 * name + weight + style, so two files sharing a name is one face — the second is
 * dropped, and every Latin character in a title silently disappears (an English
 * "About" renders as "A"). A family list is a per-glyph fallback chain instead.
 *
 * `new URL(…, import.meta.url)` is what puts the file in the route's output trace,
 * so the standalone image contains it. Three details are load-bearing:
 *
 * - The URL argument is a **literal per file**. A template (`./fonts/${name}`) makes
 *   the bundler trace the whole directory and hand back a path to whichever file it
 *   mapped first — here that was `LICENSE`, and satori answered "Unsupported
 *   OpenType signature Copy" (as in `Copyright…`).
 * - Read with `fs`, not `fetch`: Node's fetch rejects `file:` URLs, and this route
 *   runs on the Node runtime because it queries the database.
 * - The subarray is copied into its own `ArrayBuffer`: `Buffer` is a view into a
 *   shared pool, and handing satori `buffer.buffer` hands it the whole pool.
 */
const fontFile = async (url: URL): Promise<ArrayBuffer> => {
  const buffer = await readFile(fileURLToPath(url))

  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

const fonts = Promise.all(
  [
    [new URL('./fonts/vazirmatn-arabic-400-normal.woff', import.meta.url), 400, 'Vazirmatn'],
    [new URL('./fonts/vazirmatn-arabic-700-normal.woff', import.meta.url), 700, 'Vazirmatn'],
    [new URL('./fonts/vazirmatn-latin-400-normal.woff', import.meta.url), 400, 'VazirmatnLatin'],
    [new URL('./fonts/vazirmatn-latin-700-normal.woff', import.meta.url), 700, 'VazirmatnLatin'],
  ].map(async ([url, weight, name]) => ({
    data: await fontFile(url as URL),
    name: name as string,
    style: 'normal' as const,
    weight: weight as 400 | 700,
  })),
)

const SIZE = { height: 630, width: 1200 }

type Doc = { meta?: { title?: null | string } | null; title?: null | string }

const findDoc = async (site: Site, locale: string, slug: string): Promise<Doc | null> => {
  const { docs } = await findForSite('pages', String(site.id), {
    depth: 0,
    limit: 1,
    locale: locale as TypedLocale,
    pagination: false,
    select: { meta: true, title: true },
    where: { slug: { equals: slug } },
  })

  return (docs[0] as Doc | undefined) ?? null
}

export async function GET(request: Request): Promise<Response> {
  const { site } = await getSiteContext()

  if (!site) return new Response('Not found', { status: 404 })

  const params = new URL(request.url).searchParams
  const requested = params.get('locale')
  const served: string[] = site.availableLocales ?? []

  // A locale the site does not serve is not a card, for the same reason it is not a
  // page: it would render content under a URL that 404s.
  const locale = requested && served.includes(requested) ? requested : site.defaultLocale

  const doc = await findDoc(site, locale, params.get('slug') || HOME_SLUG)

  if (!doc) return new Response('Not found', { status: 404 })

  const title = doc.meta?.title || doc.title || site.name
  const rtl = dirFor(locale) === 'rtl'

  return new ImageResponse(
    <div
      style={{
        backgroundColor: '#0b0f1a',
        color: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Vazirmatn, VazirmatnLatin',
        height: '100%',
        justifyContent: 'space-between',
        padding: 80,
        width: '100%',
      }}
    >
      <div
        style={{
          alignSelf: rtl ? 'flex-end' : 'flex-start',
          backgroundColor: '#38bdf8',
          borderRadius: 8,
          height: 12,
          width: 160,
        }}
      />
      <div
        style={{
          display: 'flex',
          /**
           * The row is a plain LTR box and the text inside it is the RTL part.
           * Keeping the two apart is deliberate: with `direction: 'rtl'` on the
           * flex container itself, satori moved the line for neither
           * `justifyContent` value nor `alignSelf` — a Persian title stayed pinned
           * to the left edge. Flipping the *container's* justification instead is
           * plain LTR flexbox, which it does honour.
           */
          justifyContent: rtl ? 'flex-end' : 'flex-start',
          width: '100%',
        }}
      >
        <div
          style={{
            direction: rtl ? 'rtl' : 'ltr',
            display: 'flex',
            fontSize: 68,
            fontWeight: 700,
            // Persian needs the extra leading (CLAUDE.md), and a long title has to
            // stop somewhere: satori has no `text-overflow`, so it is clamped here.
            lineHeight: 1.5,
            maxWidth: '100%',
          }}
        >
          {title.length > 110 ? `${title.slice(0, 110)}…` : title}
        </div>
      </div>
      <div
        style={{
          alignItems: 'center',
          color: '#94a3b8',
          display: 'flex',
          flexDirection: rtl ? 'row-reverse' : 'row',
          fontSize: 32,
          justifyContent: 'space-between',
          width: '100%',
        }}
      >
        <span>{site.name}</span>
        <span>{site.domain}</span>
      </div>
    </div>,
    {
      ...SIZE,
      fonts: await fonts,
      headers: {
        // Immutable per `?v=` (the document's `updatedAt`, added by `generateMeta`),
        // so a re-share after an edit fetches a new URL instead of a stale card.
        'Cache-Control': 'public, max-age=0, s-maxage=86400',
      },
    },
  )
}
