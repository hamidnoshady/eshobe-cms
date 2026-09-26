import type { PayloadRequest, TaskConfig } from 'payload'

import { flushStorageHours } from '@/billing/meters/storage-account'
import { flushMeterBuffer, foldSamplesIntoOutbox } from '@/billing/usage/fold'
import { publishUsageBatch } from '@/billing/usage/publisher'

/**
 * The single billing worker: persist local samples, close storage hours, fold
 * them into the outbox, then publish one bounded batch.
 *
 * Registered on the jobs queue next to deployment polling. It is not a
 * `setInterval` in every replica — two publishers would still be safe because
 * event ids are idempotent, but the lease and the central call should happen
 * once. `JOBS_AUTORUN` remains the switch.
 */
export const runBillingIntegration = async (req: PayloadRequest): Promise<{ published: number }> => {
  try {
    await flushMeterBuffer(req)
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'billing: meter flush failed' })
  }
  try {
    await flushStorageHours(req)
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'billing: storage hour flush failed' })
  }
  try {
    await foldSamplesIntoOutbox(req)
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'billing: sample fold failed' })
  }
  const stats = await publishUsageBatch(req)
  return { published: stats.accepted + stats.duplicate }
}

export const billingIntegrationTask: TaskConfig = {
  slug: 'billingIntegration',
  handler: async ({ req }) => {
    const result = await runBillingIntegration(req)
    return { output: result }
  },
  label: 'ارسال مصرف به صورت‌حساب مرکزی',
  outputSchema: [{ name: 'published', type: 'number' }],
  retries: 0,
  schedule: [{ cron: '* * * * *', hooks: {}, queue: 'default' }],
}
