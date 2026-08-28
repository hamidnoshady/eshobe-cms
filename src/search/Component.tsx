'use client'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import React, { useState, useEffect } from 'react'
import { useDebounce } from '@/utilities/useDebounce'
import { useRouter } from 'next/navigation'

import { SEARCH_PATH } from '@/lib/slug'
import { uiString } from '@/lib/ui-strings'
import { useLocale, useLocaleHref } from '@/providers/Locale'

export const Search: React.FC = () => {
  const [value, setValue] = useState('')
  const router = useRouter()
  const locale = useLocale()
  const localeHref = useLocaleHref()

  const debouncedValue = useDebounce(value)

  /**
   * `localeHref(SEARCH_PATH)`, not `/search`: the bare path drops the segment, so an
   * English reader typing in the box would be bounced to the Persian results — the URL
   * changes, the language silently does not.
   */
  useEffect(() => {
    const href = localeHref(SEARCH_PATH)

    router.push(`${href}${debouncedValue ? `?q=${debouncedValue}` : ''}`)
  }, [debouncedValue, localeHref, router])

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
        }}
      >
        <Label htmlFor="search" className="sr-only">
          {uiString('search', locale)}
        </Label>
        <Input
          id="search"
          onChange={(event) => {
            setValue(event.target.value)
          }}
          placeholder={uiString('search', locale)}
        />
        <button type="submit" className="sr-only">
          submit
        </button>
      </form>
    </div>
  )
}
