import { cookies, draftMode } from 'next/headers'
import { getPayload } from 'payload'

import configPromise from '@payload-config'

export async function GET(): Promise<Response> {
  const payload = await getPayload({ config: configPromise })
  const draft = await draftMode()

  draft.disable()
  // The hand-off in `next/preview` left the editor's token on this domain, so
  // exiting has to clear it too — otherwise "exit preview" only stops the draft
  // reads and leaves a session behind on a domain the editor never visited.
  ;(await cookies()).delete(`${payload.config.cookiePrefix}-token`)

  return new Response('Draft mode is disabled')
}
