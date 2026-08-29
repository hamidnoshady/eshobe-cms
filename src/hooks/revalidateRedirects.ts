import type { CollectionAfterChangeHook } from 'payload'

import { revalidateTag } from 'next/cache'

import { tryRevalidate } from '@/hooks/revalidate'

export const revalidateRedirects: CollectionAfterChangeHook = ({ doc, req: { payload } }) => {
  payload.logger.info(`Revalidating redirects`)

  tryRevalidate(payload, 'redirects', () => revalidateTag('redirects', 'max'))

  return doc
}
