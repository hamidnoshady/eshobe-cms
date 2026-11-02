import type { RestClient } from '@/lib/wordpress/client'

/** A raw WP/Woo REST record before mapping. Values stay `unknown`-shaped on purpose. */
export type RawRecord = Record<string, unknown>

export type MigrationOperation =
  | 'cutover'
  | 'discover'
  | 'dry-run'
  | 'import'
  | 'reconcile'
  | 'rollback'
  | 'sync'

/**
 * The operator-reviewed settings one job runs under. Money fields are
 * explicit because converting a Woo decimal string without knowing the
 * source currency/decimals — and, for IRR→IRT, without a human confirming
 * the unit — is how a catalogue gets 10× prices. `resolveMigrationSettings`
 * fills these from the job row plus the site's own store currency.
 */
export type MigrationSettings = {
  applyRedirects: boolean
  confirmedRialToToman: boolean
  includeContent: boolean
  includeCoupons: boolean
  includeCustomers: boolean
  includeMedia: boolean
  includeOrders: boolean
  includeProducts: boolean
  locale: string
  sourceCurrency: string
  sourceDecimals: number
  targetCurrency: string
}

export type SourceClients = {
  woo: null | RestClient
  wp: RestClient
}

/** One downloaded source file, as the media importer hands it to Payload. */
export type DownloadedFile = { data: Buffer; mimetype: string; name: string }

export type MediaDownloader = (url: string) => Promise<DownloadedFile>

/** Injectable seams: production builds real clients; tests drive fixture-backed fakes. */
export type MigrationEngineOptions = {
  clients?: SourceClients
  download?: MediaDownloader
  /** Override the resource page size (tests exercise multi-page checkpoints with 1–2). */
  perPage?: number
}

export type MigrationCounts = {
  archived: number
  blocked: number
  errors: number
  imported: number
  seen: number
  unchanged: number
  updated: number
}

export const emptyCounts = (): MigrationCounts => ({
  archived: 0,
  blocked: 0,
  errors: 0,
  imported: 0,
  seen: 0,
  unchanged: 0,
  updated: 0,
})

export const addCounts = (into: MigrationCounts, from: Partial<MigrationCounts>): MigrationCounts => {
  for (const key of Object.keys(into) as (keyof MigrationCounts)[]) {
    into[key] += from[key] ?? 0
  }

  return into
}

export type RecordDisposition =
  | 'archived'
  | 'blocked'
  | 'deleted'
  | 'error'
  | 'imported'
  | 'planned'
  | 'rolled-back'
  | 'unchanged'
  | 'updated'
