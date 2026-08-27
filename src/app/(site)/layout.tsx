import type { Metadata } from 'next'

import { Vazirmatn } from 'next/font/google'
import React from 'react'

import { AdminBar } from '@/components/AdminBar'
import { Footer } from '@/Footer/Component'
import { Header } from '@/Header/Component'
import { getSiteContext } from '@/lib/site-context'
import { defaultLocale } from '@/lib/locales'
import { findGlobalForSite } from '@/lib/site-query'
import { themeCss } from '@/lib/theme'
import { Providers } from '@/providers'
import { InitTheme } from '@/providers/Theme/InitTheme'
import { mergeOpenGraph } from '@/utilities/mergeOpenGraph'
import { draftMode } from 'next/headers'

import './globals.css'
import { getServerSideURL } from '@/utilities/getURL'

// One family for both scripts — no per-script font switching on bilingual pages.
// Self-hosted at build time by next/font, so no external request, no layout shift.
const vazirmatn = Vazirmatn({
  display: 'swap',
  subsets: ['arabic', 'latin'],
  variable: '--font-vazirmatn',
})

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { isEnabled } = await draftMode()
  const { dir, locale, serving, site } = await getSiteContext()

  // The site's own tokens and chrome render only while it serves: a suspended or
  // archived site shows the holding page, and a suspension that still paints the
  // site's nav, footer and colours is not a suspension.
  const theme =
    site && serving
      ? themeCss(await findGlobalForSite('theme', String(site.id), { depth: 0, locale }))
      : ''

  return (
    <html className={vazirmatn.variable} dir={dir} lang={locale} suppressHydrationWarning>
      <head>
        <InitTheme />
        <link href="/favicon.ico" rel="icon" sizes="32x32" />
        <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
        {theme ? <style>{theme}</style> : null}
      </head>
      <body>
        <Providers locale={locale} siteDefault={site?.defaultLocale ?? defaultLocale}>
          <AdminBar
            adminBarProps={{
              preview: isEnabled,
            }}
          />

          {serving && <Header />}
          {children}
          {serving && <Footer />}
        </Providers>
      </body>
    </html>
  )
}

export const metadata: Metadata = {
  metadataBase: new URL(getServerSideURL()),
  openGraph: mergeOpenGraph(),
  twitter: {
    card: 'summary_large_image',
  },
}
