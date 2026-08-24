import React from 'react'

import { HeaderThemeProvider } from './HeaderTheme'
import { LocaleProvider } from './Locale'
import { ThemeProvider } from './Theme'

export const Providers: React.FC<{
  children: React.ReactNode
  locale: string
  siteDefault: string
}> = ({ children, locale, siteDefault }) => {
  return (
    <ThemeProvider>
      <LocaleProvider locale={locale} siteDefault={siteDefault}>
        <HeaderThemeProvider>{children}</HeaderThemeProvider>
      </LocaleProvider>
    </ThemeProvider>
  )
}
