import type { TaskConfig } from 'payload'

import { runQueuedMigrationJobs } from './engine'

/**
 * The once-a-minute migration runner.
 *
 * The wizard never runs an import inside its HTTP request: queueing stamps
 * `runRequestedAt` on the job (`queueMigrationOperation`), and this task is
 * what picks it up. The batch is deliberately small — one job can be a whole
 * store — and each run claims its own lock before touching a source, so two
 * overlapping ticks cannot import the same catalogue twice.
 */
export const migrationJobsTask: TaskConfig<'migrationJobs'> = {
  slug: 'migrationJobs',
  handler: async ({ req }) => {
    const jobs = await runQueuedMigrationJobs(req, { limit: 3 })

    return { output: { processed: jobs.length } }
  },
  label: 'اجرای کارهای صف مهاجرت وردپرس',
  outputSchema: [{ name: 'processed', type: 'number' }],
  retries: 0,
  schedule: [{ cron: '* * * * *', hooks: {}, queue: 'default' }],
}
