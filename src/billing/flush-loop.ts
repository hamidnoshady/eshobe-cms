/**
 * Persist this process's usage buffer. Publishing stays on the jobs queue.
 * Samples are additive, so every web replica may flush its own memory.
 */

export const startBillingFlushLoop = (): void => {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return
  const timer = setInterval(() => {
    void (async () => {
      const [{ default: config }, { createLocalReq, getPayload }] = await Promise.all([
        import('@payload-config'),
        import('payload'),
      ])
      const payload = await getPayload({ config })
      const req = await createLocalReq({}, payload)
      const { flushMeterBuffer } = await import('./usage/fold')
      const { flushStorageHours } = await import('./meters/storage-account')
      await flushMeterBuffer(req).catch((error: unknown) => {
        payload.logger.error({ err: error as Error, msg: 'billing: meter flush failed' })
      })
      await flushStorageHours(req).catch((error: unknown) => {
        payload.logger.error({ err: error as Error, msg: 'billing: storage hour flush failed' })
      })
    })()
  }, 60_000)
  timer.unref?.()
}
