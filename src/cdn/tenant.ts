/**
 * Pure rules for tenant self-service on the shared CDN account
 * (`POST|PUT|DELETE /api/site/cdn/*`). Nothing here talks to a provider or the
 * database, so every boundary is unit-testable on its own.
 *
 * The shape of the boundary:
 * - a tenant may put **its own** hostnames behind the platform's account, and the
 *   proxied records that do so are written by the platform, pointing at the
 *   platform's origin only — a tenant cannot route a third-party origin through the
 *   operator's CDN bill;
 * - a tenant may keep DNS-only records of its own (mail, verification TXT, a
 *   subdomain elsewhere) in the same zone, because a full-DNS zone otherwise breaks
 *   its email the moment the nameservers move;
 * - TLS, cache, WAF, security rules and the provider token stay operator-only.
 */
import { originRecordType } from '@/collections/hooks/cdnAccountSecrets'
import { isValidDomain, normalizeDomain, siteHostnames } from '@/lib/domains'

import type { CdnDnsRecord, CdnRecordType } from './types'

export const TENANT_RECORD_TYPES: readonly CdnRecordType[] = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'CAA',
]
export const MAX_TENANT_RECORDS = 50

export type ZoneRecord = CdnDnsRecord & { source?: 'platform' | 'tenant' | null }

type SiteLike = Parameters<typeof siteHostnames>[0]

export class TenantCdnRefusal extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'TenantCdnRefusal'
  }
}

const inZone = (hostname: string, zone: string): boolean =>
  hostname === zone || hostname.endsWith(`.${zone}`)

/**
 * Which zone may this site create? Exactly one of its own hostnames, or that
 * hostname's immediate parent (`www.acme.ir` → `acme.ir`). Never a broader parent:
 * a zone controls every name under it, so `acme.ir` for a site that only holds
 * `shop.acme.ir` is fine, but `ir` or `co.ir` is somebody else's namespace.
 *
 * `otherSitesHostnames` is every hostname of every *other* site that falls inside
 * the zone; any one of them is a refusal, because the zone's owner could otherwise
 * rewrite another customer's DNS.
 */
export const assertZoneBelongsToSite = (
  site: SiteLike,
  zoneNameInput: unknown,
  otherSitesHostnames: string[],
): string => {
  const zoneName = typeof zoneNameInput === 'string' ? normalizeDomain(zoneNameInput) : ''
  if (!zoneName || !isValidDomain(zoneName) || zoneName.split('.').length < 2)
    throw new TenantCdnRefusal('نام دامنه معتبر نیست.')

  const own = siteHostnames(site).filter(Boolean)
  const allowed = new Set<string>()
  for (const hostname of own) {
    allowed.add(hostname)
    const parent = hostname.split('.').slice(1).join('.')
    if (parent.split('.').length >= 2) allowed.add(parent)
  }
  if (!allowed.has(zoneName))
    throw new TenantCdnRefusal(
      'این دامنه به این سایت تعلق ندارد. ابتدا آن را به دامنه‌های سایت اضافه کنید.',
      403,
    )

  if (otherSitesHostnames.some((hostname) => inZone(normalizeDomain(hostname), zoneName)))
    throw new TenantCdnRefusal('بخشی از این دامنه به سایت دیگری تعلق دارد.', 409)

  return zoneName
}

const relativeName = (hostname: string, zone: string): string =>
  hostname === zone ? '@' : hostname.slice(0, -(zone.length + 1))

/** The platform's proxied records: every hostname of this site inside the zone,
 * pointing at the operator's origin. */
export const templateRecords = (
  site: SiteLike,
  zoneName: string,
  originTarget: string,
): ZoneRecord[] => {
  const type = originRecordType(originTarget)
  if (!type) throw new TenantCdnRefusal('مقصد origin پلتفرم تنظیم نشده است.', 409)
  const names = [...new Set(siteHostnames(site).filter((hostname) => inZone(hostname, zoneName)))]
  return names.map((hostname) => ({
    content: originTarget,
    name: relativeName(hostname, zoneName),
    proxied: true,
    source: 'platform',
    ttl: 1,
    type,
  }))
}

const NAME =
  /^(?:@|\*|(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*)$/
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/

const contentValid = (type: CdnRecordType, content: string): boolean => {
  switch (type) {
    case 'A':
      return IPV4.test(content)
    case 'AAAA':
      return originRecordType(content) === 'AAAA'
    case 'CNAME':
    case 'MX':
      return isValidDomain(content)
    case 'TXT':
      return content.length <= 2048 && PRINTABLE.test(content)
    case 'CAA':
      return content.length <= 255 && PRINTABLE.test(content)
  }
}

/**
 * Validate a tenant's full desired list of its own records. Every row comes out
 * DNS-only (`proxied: false`) whatever was sent, and none may share a name with a
 * platform record — a tenant `CNAME www` would otherwise shadow the proxied
 * record that serves its site, and a tenant `A @` would split the apex.
 */
export const parseTenantRecords = (
  input: unknown,
  zoneName: string,
  platformRecords: ZoneRecord[],
): ZoneRecord[] => {
  if (!Array.isArray(input)) throw new TenantCdnRefusal('records باید آرایه باشد.')
  if (input.length > MAX_TENANT_RECORDS)
    throw new TenantCdnRefusal(`حداکثر ${MAX_TENANT_RECORDS} رکورد مجاز است.`)

  const reserved = new Set(platformRecords.map((record) => record.name))
  return input.map((raw, index) => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const where = `رکورد ${index + 1}`
    const type = row.type as CdnRecordType
    if (!TENANT_RECORD_TYPES.includes(type))
      throw new TenantCdnRefusal(`${where}: نوع رکورد مجاز نیست.`)

    let name = typeof row.name === 'string' ? normalizeDomain(row.name) : ''
    if (name === zoneName) name = '@'
    else if (name.endsWith(`.${zoneName}`)) name = name.slice(0, -(zoneName.length + 1))
    if (!name || !NAME.test(name)) throw new TenantCdnRefusal(`${where}: نام رکورد معتبر نیست.`)
    if (reserved.has(name))
      throw new TenantCdnRefusal(
        `${where}: «${name}» توسط پلتفرم برای سایت شما مدیریت می‌شود.`,
        409,
      )

    const content = typeof row.content === 'string' ? row.content.trim() : ''
    if (
      !content ||
      !contentValid(type, type === 'TXT' || type === 'CAA' ? content : normalizeDomain(content))
    )
      throw new TenantCdnRefusal(`${where}: مقدار رکورد برای نوع ${type} معتبر نیست.`)

    const ttl = row.ttl === undefined || row.ttl === null ? null : Number(row.ttl)
    if (ttl !== null && !(Number.isInteger(ttl) && (ttl === 1 || (ttl >= 60 && ttl <= 86400))))
      throw new TenantCdnRefusal(`${where}: TTL باید ۱ (خودکار) یا بین ۶۰ تا ۸۶۴۰۰ باشد.`)

    let priority: null | number = null
    if (type === 'MX') {
      priority = row.priority === undefined || row.priority === null ? 10 : Number(row.priority)
      if (!Number.isInteger(priority) || priority < 0 || priority > 65535)
        throw new TenantCdnRefusal(`${where}: اولویت MX معتبر نیست.`)
    }

    return {
      ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
      content: type === 'TXT' || type === 'CAA' ? content : normalizeDomain(content),
      name,
      priority,
      proxied: false,
      source: 'tenant' as const,
      ttl,
      type,
    }
  })
}

/**
 * Replace the tenant's rows and keep the platform's untouched. A tenant row that
 * matches a stored one by `id` keeps its `providerRecordId` (so it is updated in
 * place, not duplicated); a stored tenant row that is gone and was already created
 * remotely is returned for deletion. An `id` that names a platform row or nothing
 * at all is simply a new row: ids are never trusted to reach across ownership.
 */
export const mergeTenantRecords = (
  stored: ZoneRecord[],
  tenant: ZoneRecord[],
): { dnsRecords: ZoneRecord[]; removedProviderRecordIds: string[] } => {
  const platform = stored.filter((record) => record.source !== 'tenant')
  const previous = new Map(
    stored
      .filter((record) => record.source === 'tenant' && record.id)
      .map((record) => [record.id as string, record]),
  )
  const kept = new Set<string>()
  const next = tenant.map((record) => {
    const match = record.id ? previous.get(record.id) : undefined
    if (!match) {
      const { id: _ignored, ...fresh } = record
      return fresh
    }
    kept.add(match.id as string)
    return { ...record, providerRecordId: match.providerRecordId ?? null }
  })
  const removedProviderRecordIds = [...previous.values()]
    .filter((record) => !kept.has(record.id as string) && record.providerRecordId)
    .map((record) => record.providerRecordId as string)
  return { dnsRecords: [...platform, ...next], removedProviderRecordIds }
}
