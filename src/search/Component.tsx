'use client'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Search as SearchIcon } from 'lucide-react'
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
        className="relative"
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
          className="pe-10"
        />
        <button
          type="submit"
          className="absolute inset-y-0 end-0 flex items-center justify-center px-3 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={uiString('submit', locale)}
        >
          <SearchIcon className="size-4" />
        </button>
      </form>
    </div>
  )
}
