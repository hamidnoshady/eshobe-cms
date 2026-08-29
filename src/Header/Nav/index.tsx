'use client'

import React from 'react'

import type { Header as HeaderType } from '@/payload-types'

import { CMSLink } from '@/components/Link'
import { SEARCH_PATH } from '@/lib/slug'
import { uiString } from '@/lib/ui-strings'
import { useLocale, useLocaleHref } from '@/providers/Locale'
import Link from 'next/link'

export const HeaderNav: React.FC<{ data: HeaderType | null }> = ({ data }) => {
  const navItems = data?.navItems || []
  const locale = useLocale()
  const localeHref = useLocaleHref()

  return (
    <nav className="flex gap-3 items-center">
      {navItems.map(({ link }, i) => {
        return <CMSLink key={i} {...link} appearance="link" />
      })}
      {/* The route exists, so the link does too — site-relative through
          `useLocaleHref`, or an English page searches in Persian. */}
      <Link className="text-sm font-medium hover:underline" href={localeHref(SEARCH_PATH)}>
        {uiString('search', locale)}
      </Link>
    </nav>
  )
}
