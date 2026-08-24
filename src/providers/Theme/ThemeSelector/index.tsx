'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import React, { useState } from 'react'

import type { Theme } from './types'

import { useTheme } from '..'
import { themeLocalStorageKey } from './types'

export const ThemeSelector: React.FC = () => {
  const { setTheme } = useTheme()
  const [value, setValue] = useState('')

  const onThemeChange = (themeToSet: Theme & 'auto') => {
    if (themeToSet === 'auto') {
      setTheme(null)
      setValue('auto')
    } else {
      setTheme(themeToSet)
      setValue(themeToSet)
    }
  }

  React.useEffect(() => {
    const preference = window.localStorage.getItem(themeLocalStorageKey)
    setValue(preference ?? 'auto')
  }, [])

  return (
    <Select onValueChange={onThemeChange} value={value}>
      <SelectTrigger
        aria-label="انتخاب پوسته"
        className="w-auto bg-transparent gap-2 ps-0 md:ps-3 border-none"
      >
        <SelectValue placeholder="پوسته" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">خودکار</SelectItem>
        <SelectItem value="light">روشن</SelectItem>
        <SelectItem value="dark">تیره</SelectItem>
      </SelectContent>
    </Select>
  )
}
