import { featureNote, supportsFeature } from './capabilities'
import type { CdnRemoteState, CdnZoneInput } from './types'

/**
 * Read → diff → apply → verify. This is the **read** and **diff** half of sync:
 * given the desired CMS state and the authoritative remote state read back by
 * `discoverCdnZone`, produce a per-item comparison that says what a subsequent
 * apply would do — without mutating anything.
 *
 * The diff never claims a setting is applied when the provider does not support
 * it: an unsupported control is reported `unsupported` with the provider's note,
 * and a foreign remote record is reported `external` (present, not owned, not
 * touched) rather than silently overwritten.
 */
export type CdnDiffStatus = 'external' | 'in-sync' | 'drifted' | 'new' | 'unsupported'

export interface CdnDiffItem {
  detail?: string
  kind: 'dns' | 'setting'
  name: string
  /** Remote value for drifted/external/unsupported items. */
  remote?: unknown
  /** Desired value for drifted/new items. */
  desired?: unknown
  status: CdnDiffStatus
}

export interface CdnDiffResult {
  items: CdnDiffItem[]
  summary: Record<CdnDiffStatus, number>
}

const EMPTY_SUMMARY = (): Record<CdnDiffStatus, number> => ({
  external: 0,
  'in-sync': 0,
  drifted: 0,
  new: 0,
  unsupported: 0,
})

/** Relative record name inside the zone: `@` for the apex, `www` for `www.zone`. */
const relativeName = (name: string, zone: string): string => {
  const n = name.trim().toLowerCase()
  if (n === zone) return '@'
  if (n.endsWith(`.${zone}`)) return n.slice(0, -(zone.length + 1))
  return n
}

const dnsKey = (type: string, name: string, zone: string): string =>
  `${type}:${relativeName(name, zone)}`

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Compare desired CMS state against authoritative remote state. Pure function:
 * no provider calls, no mutation. Feed it the output of `discoverCdnZone`.
 */
export const diffCdnZone = (zone: CdnZoneInput, remote: CdnRemoteState): CdnDiffResult => {
  const items: CdnDiffItem[] = []
  const summary = EMPTY_SUMMARY()
  const add = (item: CdnDiffItem) => {
    items.push(item)
    summary[item.status] += 1
  }

  /* ------------------------------------------------------------------ */
  /* DNS records                                                         */
  /* ------------------------------------------------------------------ */
  const desired = zone.dnsRecords ?? []
  const remoteByKey = new Map(
    remote.dnsRecords.map((record) => [dnsKey(record.type, record.name, zone.zoneName), record]),
  )

  for (const record of desired) {
    const key = dnsKey(record.type, record.name, zone.zoneName)
    const name = relativeName(record.name, zone.zoneName)
    const remoteRecord = remoteByKey.get(key)
    if (!remoteRecord) {
      add({
        kind: 'dns',
        name,
        status: 'new',
        desired: record.content,
        detail: record.proxied ? 'proxied' : 'dns-only',
      })
      continue
    }
    // A remote record is CMS-owned only when its provider id matches the one the
    // CMS recorded when it created it. A same-name foreign record is never
    // adopted silently — it is reported external, not overwritten.
    const owned =
      Boolean(record.providerRecordId) && remoteRecord.providerRecordId === record.providerRecordId
    if (!owned) {
      add({
        kind: 'dns',
        name,
        status: 'external',
        remote: remoteRecord.content,
        detail: 'foreign record with the same name; not adopted',
      })
      continue
    }
    if (same(remoteRecord.content, record.content) && same(remoteRecord.proxied, Boolean(record.proxied)))
      add({ kind: 'dns', name, status: 'in-sync' })
    else
      add({
        kind: 'dns',
        name,
        status: 'drifted',
        desired: record.content,
        remote: remoteRecord.content,
      })
  }

  // Remote records the CMS does not manage are listed as external so the admin
  // can see them; sync never deletes or overwrites them.
  for (const remoteRecord of remote.dnsRecords) {
    const key = dnsKey(remoteRecord.type, remoteRecord.name, zone.zoneName)
    if (!desired.some((record) => dnsKey(record.type, record.name, zone.zoneName) === key)) {
      add({
        kind: 'dns',
        name: relativeName(remoteRecord.name, zone.zoneName),
        status: 'external',
        remote: remoteRecord.content,
        detail: 'remote record not managed by CMS',
      })
    }
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */
  const setting = (
    feature: Parameters<typeof supportsFeature>[1],
    name: string,
    desiredValue: unknown,
    remoteValue: unknown,
  ): void => {
    if (!supportsFeature(zone.provider, feature)) {
      add({
        kind: 'setting',
        name,
        status: 'unsupported',
        desired: desiredValue,
        detail: featureNote(zone.provider, feature),
      })
      return
    }
    if (desiredValue === undefined || desiredValue === null) return
    if (same(desiredValue, remoteValue)) {
      add({ kind: 'setting', name, status: 'in-sync', desired: desiredValue })
    } else {
      add({ kind: 'setting', name, status: 'drifted', desired: desiredValue, remote: remoteValue })
    }
  }

  setting('ssl.mode', 'ssl.mode', zone.ssl?.mode, remote.settings.mode)
  setting('ssl.minimumTls', 'ssl.minimumTls', zone.ssl?.minimumTls, remote.settings.minimumTls)
  setting('hsts', 'hsts.enabled', zone.hsts?.enabled, remote.settings.hsts?.enabled)
  setting(
    'security.level',
    'security.securityLevel',
    zone.security?.securityLevel,
    remote.settings.securityLevel,
  )
  setting('security.waf', 'security.wafMode', zone.security?.wafMode, remote.settings.wafMode)

  return { items, summary }
}

/** Human-readable one-line summary of a diff, for logs and audit records. */
export const formatCdnDiff = (result: CdnDiffResult): string =>
  result.items.map((item) => `[${item.status}] ${item.kind}:${item.name}`).join('\n')
