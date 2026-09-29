import clsx from 'clsx'
import React from 'react'

interface Props {
  className?: string
  /** The site's own name — the wordmark until the site has a logo of its own. */
  name?: string
}

/**
 * A text wordmark of the customer's own site name.
 *
 * It used to be Payload's logo, fetched from raw.githubusercontent.com on every page:
 * every customer's header advertised the CMS vendor, and a visitor whose network
 * blocks GitHub saw a broken image on a site that is otherwise self-hosted.
 */
export const Logo = ({ className, name }: Props) => (
  <span className={clsx('text-xl font-bold leading-none tracking-tight', className)}>{name}</span>
)
