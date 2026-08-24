'use client'

import { Button, type ButtonProps } from '@/components/ui/button'
import { useLocaleHref } from '@/providers/Locale'
import { pagePath } from '@/lib/slug'
import { cn } from '@/utilities/ui'
import Link from 'next/link'
import React from 'react'

import type { Page, Post } from '@/payload-types'

type CMSLinkType = {
  appearance?: 'inline' | ButtonProps['variant']
  children?: React.ReactNode
  className?: string
  label?: string | null
  newTab?: boolean | null
  reference?: {
    relationTo: 'pages' | 'posts'
    value: Page | Post | string | number
  } | null
  size?: ButtonProps['size'] | null
  type?: 'custom' | 'reference' | null
  url?: string | null
}

export const CMSLink: React.FC<CMSLinkType> = (props) => {
  const {
    type,
    appearance = 'inline',
    children,
    className,
    label,
    newTab,
    reference,
    size: sizeFromProps,
    url,
  } = props

  const localeHref = useLocaleHref()

  const target =
    type === 'reference' && typeof reference?.value === 'object' && reference.value.slug
      ? reference.relationTo === 'pages'
        ? // `pagePath`, not `/${slug}`: a nav item pointing at the home page has to
          // render `/`, or the site grows a second URL for its own front page.
          pagePath(reference.value.slug)
        : `/${reference.relationTo}/${reference.value.slug}`
      : url

  // Site-relative links carry the active locale, or an English visitor clicking
  // through the nav lands back on the Persian page.
  const href = target ? localeHref(target) : target

  if (!href) return null

  const size = appearance === 'link' ? 'clear' : sizeFromProps
  const newTabProps = newTab ? { rel: 'noopener noreferrer', target: '_blank' } : {}

  /* Ensure we don't break any styles set by richText */
  if (appearance === 'inline') {
    return (
      <Link className={cn(className)} href={href || url || ''} {...newTabProps}>
        {label && label}
        {children && children}
      </Link>
    )
  }

  return (
    <Button asChild className={className} size={size} variant={appearance}>
      <Link className={cn(className)} href={href || url || ''} {...newTabProps}>
        {label && label}
        {children && children}
      </Link>
    </Button>
  )
}
