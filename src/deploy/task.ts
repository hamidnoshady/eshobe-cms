import type { PayloadRequest, TaskConfig } from 'payload'

import { pollDeployment, verifyDeployment } from './service'

/**
 * The queue task that walks in-flight deployments forward.
 *
 * Without it, `building` only advances when somebody presses a button. A Coolify
 * build finishing at 2am should make the site live at 2am, and a CMS restart
 * mid-build must pick the deployment back up rather than leave it `building`
 * forever — that stuck row is the failure this exists to prevent, and it is the one
 * that looks like the feature simply not working.
 *
 * ## Why it is registered as a task and not a `setInterval`
 *
 * `payload.config`'s `jobs` block already carries the cron, the access rule and the
 * single-replica caveat (`JOBS_AUTORUN`, `src/instrumentation.ts`). A timer started
 * at module scope would run in every dev server, every test process and both web
 * replicas — the exact multiplication CLAUDE.md warns about for `schedulePublish`.
 *
 * ## Bounded, always
 *
 * `POLL_LIMIT` rows per tick. A fleet with two hundred queued deployments should take
 * several minutes to work through them, not open two hundred simultaneous HTTP calls
 * to one Coolify instance and get rate-limited into a fleet-wide failure.
 */

const POLL_LIMIT = 10

/**
 * How long a deployment may sit in a non-terminal state before it is called dead.
 *
 * A build that has not moved in an hour is not slow, it is gone — the Coolify build
 * was cancelled out from under us, or the instance was replaced. Leaving it
 * `building` means the row lies indefinitely; failing it means an operator sees a red
 * status and a retry button.
 */
const STALE_AFTER_MS = 60 * 60 * 1000

export const advanceDeployments = async (req: PayloadRequest): Promise<{ advanced: number }> => {
  const { docs } = await req.payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit: POLL_LIMIT,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'updatedAt',
    where: { status: { in: ['creating', 'building', 'verifying'] } },
  })

  let advanced = 0

  for (const row of docs as unknown as Record<string, unknown>[]) {
    const id = String(row.id)
    const updatedAt = Date.parse(String(row.updatedAt ?? ''))

    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_AFTER_MS) {
      await req.payload.update({
        collection: 'site-deployments',
        data: {
          lastError: 'استقرار بیش از یک ساعت بدون تغییر ماند و ناموفق در نظر گرفته شد.',
          status: 'failed',
        },
        depth: 0,
        id,
        overrideAccess: true,
        req,
      })
      advanced += 1
      continue
    }

    try {
      if (row.status === 'verifying') {
        await verifyDeployment(req, id)
        advanced += 1
        continue
      }

      const polled = await pollDeployment(req, id)
      if (polled.changed) advanced += 1
      // A build that just finished is verified on the same tick rather than waiting a
      // full minute for the next one — the gap between "built" and "serving" is the
      // part a watching operator experiences as the feature being slow.
      if (polled.status === 'verifying') await verifyDeployment(req, id)
    } catch (error) {
      // One bad row must not stop the queue for the other nine.
      req.payload.logger.error({ err: error as Error, msg: `deployment ${id} poll failed` })
    }
  }

  return { advanced }
}

export const advanceDeploymentsTask: TaskConfig<'advanceDeployments'> = {
  slug: 'advanceDeployments',
  handler: async ({ req }) => {
    const result = await advanceDeployments(req)
    return { output: result }
  },
  label: 'پیگیری استقرارهای در جریان',
  outputSchema: [{ name: 'advanced', type: 'number' }],
  /**
   * Once a minute, on the same `default` queue `autoRun` already drains — so this
   * needs no second cron and inherits the single-replica caveat already documented
   * there rather than introducing a new one.
   */
  schedule: [{ cron: '* * * * *', hooks: {}, queue: 'default' }],
  // A poll that failed is retried by the next tick with fresher state; stacking
  // Payload's own retries on top would multiply calls against Coolify for no gain.
  retries: 0,
}
