'use client'

import React, { createContext, useContext } from 'react'

import { defaultLocale, localeHref } from '@/lib/locales'

type Value = { locale: string; siteDefault: string }

const LocaleContext = createContext<Value>({ locale: defaultLocale, siteDefault: defaultLocale })

export const LocaleProvider: React.FC<Value & { children: React.ReactNode }> = ({
  children,
  ...value
}) => <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>

/**
 * Builds locale-correct hrefs in client components, which cannot call
 * `getSiteContext()`. Without it every nav link drops the locale segment and sends
 * an English visitor back to the Persian page.
 */
export const useLocaleHref = (): ((path: string) => string) => {
  const { locale, siteDefault } = useContext(LocaleContext)

  return (path) => localeHref(path, locale, siteDefault)
}
