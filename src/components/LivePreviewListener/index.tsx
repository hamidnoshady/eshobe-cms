'use client'
import { RefreshRouteOnSave as PayloadLivePreview } from '@payloadcms/live-preview-react'
import { useRouter } from 'next/navigation'
import React from 'react'

/**
 * Re-renders the page when the editor saves, inside the admin's preview iframe.
 *
 * `serverURL` is the **admin's** origin, not this site's — which is the opposite of
 * what the name suggests and the reason the template's `getClientSideURL()` cannot
 * work here. Two checks in `@payloadcms/live-preview` both compare against it:
 * `isDocumentEvent` drops any message whose `event.origin !== serverURL`, and
 * `ready()` posts to the parent with it as `targetOrigin`. On a single-domain site
 * admin and page share an origin so either value works; on this platform the page
 * is on `acme.localhost` and the admin on `localhost`, so passing our own origin
 * meant the ready message was never delivered and every save event was discarded —
 * a preview pane that loads once and then silently stops updating.
 *
 * `NEXT_PUBLIC_` because this runs in the browser. No fallback: a wrong origin here
 * fails silently, and failing to render is the louder, cheaper bug.
 */
export const LivePreviewListener: React.FC = () => {
  const router = useRouter()
  const serverURL = process.env.NEXT_PUBLIC_SERVER_URL

  if (!serverURL) return null

  return <PayloadLivePreview refresh={router.refresh} serverURL={serverURL} />
}
