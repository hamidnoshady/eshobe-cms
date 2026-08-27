import type { Payload } from 'payload'

/**
 * Runs a `revalidatePath`/`revalidateTag` call that might not be in a request.
 *
 * Next's cache primitives read a per-request "static generation store" and throw
 * `Invariant: static generation store missing in revalidatePath` when there is none.
 * A write from an admin form always has one; three kinds of write do not:
 *
 * - **The jobs queue.** `autoRun` fires from a timer inside the server process, not
 *   a request, so a scheduled publish's `payload.update` runs storeless. Left
 *   unguarded the hook throws, the task fails, Payload retries it to its limit and
 *   the document stays a draft — the publish silently never happens, which is the
 *   whole feature.
 * - **CLI scripts** (`payload run`, seeds, migrations).
 * - **Any future worker container.**
 *
 * A cache hint is best-effort by nature: the page it would refresh is rendered
 * dynamically anyway (`getSiteContext` reads `headers()`), so failing to send one
 * costs a stale entry at worst. Failing the *write* costs the publish. Hence the
 * catch — logged, never swallowed silently, so a genuine revalidation bug is still
 * visible in the logs.
 */
export const tryRevalidate = (payload: Payload, what: string, revalidate: () => void): void => {
  try {
    revalidate()
  } catch (error) {
    payload.logger.warn(
      { err: error },
      `Revalidation of ${what} skipped — no request context (jobs queue, CLI or worker).`,
    )
  }
}
