import { NextResponse } from 'next/server'

/**
 * Release fingerprint for diagnosing stale containers and cached admin bundles.
 * It reports only a public Git commit SHA baked into the published Docker image,
 * never deployment secrets or runtime configuration.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export const GET = () => {
  const build = process.env.ESHOBE_BUILD_SHA || 'unknown'
  return NextResponse.json(
    { build },
    {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Eshobe-Build': build,
      },
    },
  )
}
