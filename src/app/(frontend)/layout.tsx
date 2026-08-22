import type { Metadata } from 'next'

import { Vazirmatn } from 'next/font/google'
import React from 'react'

import { AdminBar } from '@/components/AdminBar'
import { Footer } from '@/Footer/Component'
import { Header } from '@/Header/Component'
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

  return (
    // ponytail: fa/rtl fixed here because there is no locale system yet. Wave 1
    // resolves both per request from the active locale's `rtl` flag (PLAN §3.3).
    <html className={vazirmatn.variable} dir="rtl" lang="fa" suppressHydrationWarning>
      <head>
        <InitTheme />
        <link href="/favicon.ico" rel="icon" sizes="32x32" />
        <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      </head>
      <body>
        <Providers>
          <AdminBar
            adminBarProps={{
              preview: isEnabled,
            }}
          />

          <Header />
          {children}
          <Footer />
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
