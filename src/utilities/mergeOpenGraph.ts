import type { Metadata } from 'next'

/**
 * No vendor defaults: every value here would otherwise leak "Payload Website
 * Template" and its OG image onto a customer's social cards. Anything the caller
 * does not supply is simply absent.
 */
export const mergeOpenGraph = (og?: Metadata['openGraph']): Metadata['openGraph'] => ({
  type: 'website',
  ...og,
})
