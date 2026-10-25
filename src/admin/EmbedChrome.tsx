import { cookies, headers } from 'next/headers'
import React from 'react'

import { isTopLevelNavigation } from '@/lib/adminFrame'
import { EMBED_MARKER_COOKIE } from '@/lib/embed'

/**
 * Registered as `admin.components.header`. Renders nothing for a normal admin session.
 *
 * Inside the POS's edit modal the marker cookie (set by `/api/embed/enter`) makes it
 * emit a stylesheet that removes the sidebar, its toggle and the app header, so the
 * frame shows the document and nothing else. The `full` marker (the dashboard view) keeps
 * the admin's own chrome. Server-rendered from the cookie, so the
 * sidebar never flashes. This is chrome, not a boundary: the embed user's access is
 * the tenant role it holds.
 */
const EmbedChrome = async (): Promise<React.ReactNode> => {
  const jar = await cookies()
  if (jar.get(EMBED_MARKER_COOKIE)?.value !== '1') return null
  // A top-level page is never the modal, whatever cookies it carries: on a shared
  // registrable domain the frame's partitioned marker reaches `/admin` opened in a tab,
  // and hiding the sidebar there left the operator with no navigation and no logout.
  // `src/proxy.ts` clears the leaked cookies; this keeps the chrome if that could not.
  if (isTopLevelNavigation(await headers())) return null

  return (
    <style
      // Static string, no interpolation.
      dangerouslySetInnerHTML={{
        __html: `
.template-default{grid-template-columns:1fr !important}
.template-default .nav,
.template-default__nav-toggler-wrapper,
.template-default .app-header{display:none !important}
`,
      }}
    />
  )
}

export default EmbedChrome
