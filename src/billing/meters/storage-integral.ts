/**
 * Time-weighted storage. A byte present for a fraction of an hour contributes
 * that fraction, so the number does not depend on the moment a cron happened
 * to look.
 *
 * The state is pure. Persistence lives in `billing-storage-accounts`; this
 * function is what the tests reproduce without a database.
 */

const HOUR_MS = 3_600_000n

export type StorageClock = {
  /** Byte-milliseconds accumulated inside `openHourStart` and not yet emitted. */
  accruedByteMs: bigint
  /** Current stored bytes. Piecewise constant between changes. */
  bytes: bigint
  /** When `bytes` was last known to be current. */
  accountedAt: number
  /** UTC hour this accrual belongs to, epoch ms. */
  openHourStart: number
}

export type ClosedStorageHour = {
  byteHours: bigint
  hourStart: number
}

const hourStartOf = (at: number): number => Math.floor(at / Number(HOUR_MS)) * Number(HOUR_MS)

export const emptyStorageClock = (at: number, bytes = 0n): StorageClock => ({
  accruedByteMs: 0n,
  accountedAt: at,
  bytes: bytes < 0n ? 0n : bytes,
  openHourStart: hourStartOf(at),
})

/**
 * Advance the clock to `now` and, if `nextBytes` is set, change the level
 * after accruing the previous level. Completed UTC hours are returned and
 * removed from the clock; the hour still in progress stays accrued.
 */
export const advanceStorageClock = (
  state: StorageClock,
  now: number,
  nextBytes?: bigint,
): { closed: ClosedStorageHour[]; state: StorageClock } => {
  if (now < state.accountedAt) return { closed: [], state }
  let accrued = state.accruedByteMs
  let cursor = state.accountedAt
  let open = state.openHourStart
  const bytes = state.bytes < 0n ? 0n : state.bytes
  const closed: ClosedStorageHour[] = []

  while (cursor < now) {
    const hourEnd = open + Number(HOUR_MS)
    const sliceEnd = Math.min(now, hourEnd)
    accrued += bytes * BigInt(sliceEnd - cursor)
    cursor = sliceEnd
    if (cursor >= hourEnd && now >= hourEnd) {
      closed.push({ byteHours: accrued / HOUR_MS, hourStart: open })
      accrued = 0n
      open = hourEnd
    }
  }

  const level = nextBytes === undefined ? bytes : nextBytes < 0n ? 0n : nextBytes
  return {
    closed,
    state: { accruedByteMs: accrued, accountedAt: now, bytes: level, openHourStart: open },
  }
}

/** Sum of original file bytes plus generated image sizes. Missing sizes add nothing. */
export const storedObjectBytes = (doc: {
  filesize?: unknown
  sizes?: Record<string, { filesize?: unknown } | null> | null
}): number => {
  const original = Number(doc.filesize ?? 0)
  let total = Number.isFinite(original) && original > 0 ? Math.trunc(original) : 0
  const sizes = doc.sizes
  if (!sizes || typeof sizes !== 'object') return total
  for (const size of Object.values(sizes)) {
    const n = Number(size?.filesize ?? 0)
    if (Number.isFinite(n) && n > 0) total += Math.trunc(n)
  }
  return total
}
