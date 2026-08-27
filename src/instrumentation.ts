/**
 * Starts the jobs queue when the server process starts.
 *
 * This file exists because `autoRun` alone does nothing in a Next.js app. Payload
 * only schedules its cron in `getPayload({ config, cron: true })` — and every
 * `getPayload` call in this codebase is a page render asking for data, none of which
 * passes `cron`. Verified the hard way against the production build: with `autoRun`
 * configured and no `cron: true` anywhere, a `schedulePublish` job whose `waitUntil`
 * had already passed sat in `payload_jobs` untouched (`total_tried: 0`) for as long
 * as it was left there. Scheduled publishing looked configured and never ran.
 *
 * `instrumentation.ts` is Next's one hook that runs once per server process, before
 * traffic — which is exactly the lifetime a cron needs.
 */
export async function register(): Promise<void> {
  // `register` also runs in the edge runtime, which has no database driver, no
  // timers that outlive a request, and no business starting a queue.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  /**
   * Never during `next build`. The production image builds with a placeholder
   * `DATABASE_URL` (there is no database at build time), so connecting here would
   * fail the image build — and a build has no traffic to serve anyway. Payload
   * guards its own cron with the same two signals (`utilities/isNextBuild`).
   */
  if (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.npm_lifecycle_event === 'build'
  )
    return

  const { jobsAutoRunEnabled } = await import('./lib/env')

  // Dev and tests keep the queue out of the process: a cron ticking every minute
  // writes to the same database the tests assert against. `payload jobs:run` and
  // the admin's own "run now" still work there.
  if (!jobsAutoRunEnabled()) return

  const [{ default: config }, { getPayload }] = await Promise.all([
    import('@payload-config'),
    import('payload'),
  ])

  const payload = await getPayload({ config, cron: true })

  payload.logger.info('Jobs queue autoRun started (single replica only — see JOBS_AUTORUN).')
}
