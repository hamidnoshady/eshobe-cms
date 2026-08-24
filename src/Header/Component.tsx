import React from 'react'

import { findGlobalForSite } from '@/lib/site-query'
import { getSiteContext } from '@/lib/site-context'
import { HeaderClient } from './Component.client'

export async function Header() {
  const { locale, site } = await getSiteContext()

  const headerData = site
    ? await findGlobalForSite('header', site.id, { depth: 1, locale })
    : null

  return <HeaderClient data={headerData} />
}
