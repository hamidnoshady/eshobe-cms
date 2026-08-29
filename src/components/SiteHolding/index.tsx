import React from 'react'

/**
 * What a suspended or archived site serves on every path (Wave 5). Lifecycle is
 * a status, not a delete: the domain still resolves, so it must answer with
 * something deliberate — not a 404 with the site's chrome missing, and never a
 * 500 from a render that assumed an active site.
 *
 * Rendered inside the site layout with no header, footer or theme: those are the
 * suspended site's own content, and a suspension that still serves the site's
 * nav is not a suspension.
 *
 * It answers 200 rather than 503 because a Next.js page cannot set an arbitrary
 * status code — and `robots: noindex` (set by the route's metadata) keeps search
 * engines from indexing a page that must not rank. For a *temporary* suspension
 * 200-with-noindex is the safer answer anyway: 503-with-retry invites crawlers
 * to hammer a site whose problem may be load.
 */
const COPY = {
  archived: {
    en: {
      line: 'This site has been archived and is no longer available.',
      title: 'Site archived',
    },
    fa: {
      line: 'این سایت بایگانی شده و دیگر در دسترس نیست.',
      title: 'سایت بایگانی شد',
    },
  },
  suspended: {
    en: {
      line: 'This site is temporarily unavailable. Please check back soon.',
      title: 'Temporarily unavailable',
    },
    fa: {
      line: 'این سایت موقتاً در دسترس نیست. لطفاً بعداً دوباره سر بزنید.',
      title: 'موقتاً در دسترس نیست',
    },
  },
} as const

export const SiteHolding: React.FC<{
  /** The site's own name — not localized, so it renders in every locale. */
  siteName: string
  status: 'archived' | 'suspended'
}> = ({ siteName, status }) => {
  const fa = status === 'archived' ? COPY.archived.fa : COPY.suspended.fa
  const en = status === 'archived' ? COPY.archived.en : COPY.suspended.en

  return (
    // Both languages, always: a suspended site still resolves its own locales,
    // but a visitor following an old link may land on any path, and one line of
    // the other language costs nothing next to a visitor who understands neither.
    // `dir="auto"` per line: each picks its direction from its own first strong
    // character, so the Persian reads correctly even on an LTR page — and the
    // page's `dir` still belongs to the active locale, not this block.
    <main className="container flex min-h-[60vh] flex-col items-center justify-center gap-4 py-24 text-center">
      <h1 className="text-3xl font-bold">{siteName}</h1>
      <p className="max-w-xl text-lg leading-[1.8] text-muted-foreground" dir="auto">
        {fa.title}
      </p>
      <p className="max-w-xl leading-[1.8] text-muted-foreground" dir="auto">
        {fa.line}
      </p>
      <p className="max-w-xl text-sm leading-[1.8] text-muted-foreground" dir="ltr">
        {en.title} — {en.line}
      </p>
    </main>
  )
}
