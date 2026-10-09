import { cookies } from 'next/headers'
import React from 'react'

import { EMBED_MARKER_COOKIE } from '@/lib/embed'

/**
 * Registered as `admin.components.header`. Renders nothing for a normal admin session.
 *
 * Inside the POS's edit modal the marker cookie (set by `/api/embed/enter`) makes it
 * emit a stylesheet that removes the sidebar, its toggle and the app header, so the
 * frame shows the document and nothing else. Server-rendered from the cookie, so the
 * sidebar never flashes. This is chrome, not a boundary: the embed user's access is
 * the tenant role it holds.
 */
const EmbedChrome = async (): Promise<React.ReactNode> => {
  const jar = await cookies()
  if (jar.get(EMBED_MARKER_COOKIE)?.value !== '1') return null

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
