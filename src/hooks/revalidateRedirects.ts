import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  Payload,
} from 'payload'

import { revalidateTag } from 'next/cache'

import { tryRevalidate } from '@/hooks/revalidate'
import { idOf } from '@/lib/ids'
import { siteTag } from '@/lib/site-cache'

const revalidate = (doc: unknown, payload: Payload): void => {
  payload.logger.info(`Revalidating redirects`)

  // The generic tag is the contract external themes already cache against.
  tryRevalidate(payload, 'redirects', () => revalidateTag('redirects', 'max'))

  // The built-in renderer caches through `findForSite`, whose tag is scoped
  // to the one tenant whose routing table actually changed.
  const siteId = idOf((doc as undefined | { site?: unknown })?.site)
  if (siteId) {
    const tag = siteTag(siteId, 'redirects')
    tryRevalidate(payload, tag, () => revalidateTag(tag, 'max'))
  }
}

export const revalidateRedirects: CollectionAfterChangeHook = ({ doc, req: { payload } }) => {
  revalidate(doc, payload)

  return doc
}

export const revalidateRedirectsDelete: CollectionAfterDeleteHook = ({
  doc,
  req: { payload },
}) => {
  revalidate(doc, payload)

  return doc
}
