import { randomBytes } from 'node:crypto'
import type { PayloadRequest } from 'payload'

import type { User } from '@/payload-types'
import { idOf, isUuid } from '@/lib/ids'
import type { RestClient } from '@/lib/wordpress/client'

import { asArray, asRecord, str, type Loose } from './context'
import { recordMigrationAudit, upsertMigrationRecord } from './records'
import { buildSourceClients, findOwnMigrationJob, findOwnMigrationSource } from './source'
import type { SourceClients } from './types'

/**
 * Explicit WordPress staff → Eshobe site-staff invitations.
 *
 * WordPress keeps staff and shoppers in one user table. The importer never
 * turns a source role into a CMS login by implication: this surface first
 * lists staff-role candidates from the authenticated WP users endpoint, then
 * an owner chooses individuals and the Eshobe tenant role. Only a WordPress
 * administrator may be mapped to site owner; every other staff role maps to
 * editor. New accounts receive Payload's normal set-password email — no WP
 * password or hash is copied — and invitation rows are ledgered with
 * `createdByMigration: false`, so migration rollback can never delete a
 * person's account.
 */

export const WORDPRESS_STAFF_ROLES = [
  'administrator',
  'editor',
  'author',
  'contributor',
  'shop_manager',
] as const

export const MAX_STAFF_CANDIDATES = 1_000
export const MAX_STAFF_INVITES = 100

export class StaffInviteError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'StaffInviteError'
    this.status = status
  }
}

export type SiteStaffInviteRole = 'editor' | 'owner'

export type WordPressStaffCandidate = {
  canBeOwner: boolean
  email: string
  name: string
  roles: string[]
  slug: string
  sourceRecordId: string
  suggestedRole: SiteStaffInviteRole
}

export type StaffInviteRequest = {
  resend?: boolean
  role: SiteStaffInviteRole
  sourceRecordId: string
}

export type StaffInviteAction =
  | 'already-member'
  | 'assigned'
  | 'created'
  | 'email-failed'
  | 'platform-admin'
  | 'rejected'

export type StaffInviteResult = {
  action: StaffInviteAction
  email: string
  message?: string
  role: SiteStaffInviteRole
  sourceRecordId: string
  userId?: string
}

export type StaffInviteSender = (args: {
  email: string
  req: PayloadRequest
  userId: string
}) => Promise<void>

const normalizeEmail = (value: unknown): string => str(value).trim().toLowerCase()
const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const sanitizeCandidate = (row: Loose): null | WordPressStaffCandidate => {
  const sourceRecordId = str(row.id ?? row.ID).trim()
  const email = normalizeEmail(row.email)
  const roles = [...new Set((asArray(row.roles) as unknown[]).map((role) => str(role).toLowerCase()))]
    .filter((role) => (WORDPRESS_STAFF_ROLES as readonly string[]).includes(role))
    .sort()

  if (!sourceRecordId || !isEmail(email) || !roles.length) return null

  const canBeOwner = roles.includes('administrator')
  return {
    canBeOwner,
    email,
    name: str(row.name).trim() || str(row.slug).trim() || email,
    roles,
    slug: str(row.slug).trim(),
    sourceRecordId,
    suggestedRole: canBeOwner ? 'owner' : 'editor',
  }
}

export const listWordPressStaffCandidates = async (
  client: RestClient,
): Promise<{ candidates: WordPressStaffCandidate[]; total: number; truncated: boolean }> => {
  const rows = (await client.collect<Loose>('/wp-json/wp/v2/users', {
    context: 'edit',
    order: 'asc',
    orderby: 'id',
    roles: WORDPRESS_STAFF_ROLES.join(','),
  })) as Loose[]
  const byId = new Map<string, WordPressStaffCandidate>()

  for (const row of rows) {
    const candidate = sanitizeCandidate(row)
    if (candidate) byId.set(candidate.sourceRecordId, candidate)
  }

  const candidates = [...byId.values()].sort((a, b) =>
    a.sourceRecordId.localeCompare(b.sourceRecordId, undefined, { numeric: true }),
  )

  return {
    candidates: candidates.slice(0, MAX_STAFF_CANDIDATES),
    total: candidates.length,
    truncated: candidates.length > MAX_STAFF_CANDIDATES,
  }
}

const defaultSendInvite: StaffInviteSender = async ({ email, req }) => {
  await req.payload.forgotPassword({
    collection: 'users',
    data: { email },
    req,
  })
}

const findUserByEmail = async (
  req: PayloadRequest,
  email: string,
): Promise<null | (User & Loose)> => {
  const { docs } = await req.payload.find({
    collection: 'users',
    depth: 0,
    limit: 10,
    overrideAccess: true,
    req,
    where: { email: { equals: email } },
  })

  return (
    ((docs as unknown as (User & Loose)[]).find(
      (doc) => normalizeEmail(doc.email) === email,
    ) as (User & Loose) | undefined) ?? null
  )
}

const tenantRows = (user: Loose): Loose[] => asArray(user.tenants) as Loose[]

const strongerRole = (current: unknown, requested: SiteStaffInviteRole): SiteStaffInviteRole =>
  current === 'owner' || requested === 'owner' ? 'owner' : 'editor'

const recordStaffInvite = async (
  req: PayloadRequest,
  {
    action,
    candidate,
    installation,
    jobId,
    role,
    siteId,
    sourceId,
    user,
  }: {
    action: StaffInviteAction
    candidate: WordPressStaffCandidate
    installation: string
    jobId: string
    role: SiteStaffInviteRole
    siteId: string
    sourceId: string
    user: Loose
  },
): Promise<void> => {
  await upsertMigrationRecord(req, {
    // Account lifecycle is deliberately outside migration rollback. Even a
    // user row created by this invitation remains a person's CMS account.
    createdByMigration: false,
    destinationCollection: 'users',
    destinationId: String(user.id),
    destinationUpdatedAt: typeof user.updatedAt === 'string' ? user.updatedAt : null,
    disposition:
      action === 'created' || action === 'email-failed'
        ? 'imported'
        : action === 'assigned'
          ? 'updated'
          : 'unchanged',
    installation,
    jobId,
    metadata: {
      staffInvite: {
        action,
        role,
        sourceRoles: candidate.roles,
      },
    },
    raw: {
      id: candidate.sourceRecordId,
      name: candidate.name,
      roles: candidate.roles,
      slug: candidate.slug,
    },
    resource: 'wp-users',
    siteId,
    sourceId,
    sourceRecordId: candidate.sourceRecordId,
  }).catch(() => undefined)
}

export const inviteWordPressStaff = async (
  req: PayloadRequest,
  {
    clients,
    invites,
    jobId,
    sendInvite = defaultSendInvite,
    siteId,
    sourceId,
  }: {
    clients?: SourceClients
    invites: StaffInviteRequest[]
    jobId: string
    sendInvite?: StaffInviteSender
    siteId: string
    sourceId: string
  },
): Promise<{
  results: StaffInviteResult[]
  summary: Record<StaffInviteAction, number>
}> => {
  if (!isUuid(siteId) || !isUuid(sourceId) || !isUuid(jobId)) {
    throw new StaffInviteError('شناسه سایت، مبدأ یا کار مهاجرت معتبر نیست.', 400)
  }
  if (!invites.length || invites.length > MAX_STAFF_INVITES) {
    throw new StaffInviteError('در هر نوبت میان ۱ تا ۱۰۰ دعوت کارکنان ممکن است.', 400)
  }

  const seen = new Set<string>()
  for (const invite of invites) {
    const sourceRecordId = str(invite.sourceRecordId).trim()
    if (
      !sourceRecordId ||
      !['editor', 'owner'].includes(invite.role) ||
      seen.has(sourceRecordId)
    ) {
      throw new StaffInviteError('فهرست دعوت کارکنان ناقص یا تکراری است.', 400)
    }
    seen.add(sourceRecordId)
  }

  const [source, job] = await Promise.all([
    findOwnMigrationSource(req, sourceId, siteId),
    findOwnMigrationJob(req, jobId, siteId),
  ])
  if (!source) throw new StaffInviteError('مبدأ مهاجرت در این سایت یافت نشد.', 404)
  if (!job) throw new StaffInviteError('کار مهاجرت در این سایت یافت نشد.', 404)
  if (idOf(job.source) !== sourceId) {
    throw new StaffInviteError('کار مهاجرت به این مبدأ تعلق ندارد.', 409)
  }

  const resolvedClients = clients ?? (await buildSourceClients(req, source))
  const { candidates } = await listWordPressStaffCandidates(resolvedClients.wp)
  const bySourceId = new Map(candidates.map((candidate) => [candidate.sourceRecordId, candidate]))
  const results: StaffInviteResult[] = []

  for (const invite of invites) {
    const candidate = bySourceId.get(invite.sourceRecordId)
    if (!candidate) {
      results.push({
        action: 'rejected',
        email: '',
        message: 'این شناسه در فهرست تازه کاربران کارکنان وردپرس نیست.',
        role: invite.role,
        sourceRecordId: invite.sourceRecordId,
      })
      continue
    }
    if (invite.role === 'owner' && !candidate.canBeOwner) {
      results.push({
        action: 'rejected',
        email: candidate.email,
        message: 'فقط مدیر وردپرس (administrator) می‌تواند مالک سایت شود.',
        role: invite.role,
        sourceRecordId: invite.sourceRecordId,
      })
      continue
    }

    let user = await findUserByEmail(req, candidate.email)
    let action: StaffInviteAction
    let shouldSend = false

    if (user?.role === 'platformAdmin') {
      action = 'platform-admin'
    } else if (user) {
      const rows = tenantRows(user)
      const existingIndex = rows.findIndex((row) => idOf(row.tenant) === siteId)
      let changed = false
      let nextRows = rows

      if (existingIndex === -1) {
        nextRows = [...rows, { role: invite.role, tenant: siteId }]
        changed = true
      } else {
        const nextRole = strongerRole(rows[existingIndex]?.role, invite.role)
        if (nextRole !== rows[existingIndex]?.role) {
          nextRows = rows.map((row, index) =>
            index === existingIndex ? { ...row, role: nextRole } : row,
          )
          changed = true
        }
      }

      if (changed) {
        user = (await req.payload.update({
          id: user.id,
          collection: 'users',
          data: { tenants: nextRows } as never,
          depth: 0,
          overrideAccess: true,
          req,
        })) as User & Loose
        action = 'assigned'
      } else {
        action = 'already-member'
      }
      shouldSend = invite.resend === true
    } else {
      user = (await req.payload.create({
        collection: 'users',
        data: {
          email: candidate.email,
          name: candidate.name,
          password: randomBytes(24).toString('base64url'),
          role: 'user',
          tenants: [{ role: invite.role, tenant: siteId }],
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as User & Loose
      action = 'created'
      shouldSend = true
    }

    if (shouldSend) {
      try {
        await sendInvite({ email: candidate.email, req, userId: String(user.id) })
      } catch (error) {
        req.payload.logger.error(
          `Staff invite email failed for WordPress user ${candidate.sourceRecordId}: ${String(error)}`,
        )
        action = 'email-failed'
      }
    }

    await recordStaffInvite(req, {
      action,
      candidate,
      installation: String(source.installation),
      jobId,
      role: invite.role,
      siteId,
      sourceId,
      user,
    })
    results.push({
      action,
      email: candidate.email,
      ...(action === 'email-failed'
        ? { message: 'حساب ساخته/منتسب شد اما ایمیل تعیین گذرواژه ارسال نشد.' }
        : {}),
      role: invite.role,
      sourceRecordId: invite.sourceRecordId,
      userId: String(user.id),
    })
  }

  const summary: Record<StaffInviteAction, number> = {
    'already-member': 0,
    assigned: 0,
    created: 0,
    'email-failed': 0,
    'platform-admin': 0,
    rejected: 0,
  }
  for (const result of results) summary[result.action] += 1

  await recordMigrationAudit(req, {
    action: 'staff.invite',
    actorId: idOf(req.user),
    details: {
      results: results.map(({ action, role, sourceRecordId, userId }) => ({
        action,
        role,
        sourceRecordId,
        ...(userId ? { userId } : {}),
      })),
      summary,
    },
    jobId,
    siteId,
    sourceId,
    summary: 'دعوت/انتساب صریح کارکنان وردپرس به نقش‌های این سایت انجام شد.',
  }).catch(() => undefined)

  return { results, summary }
}

export const sanitizeStaffInviteRequests = (value: unknown): StaffInviteRequest[] =>
  (asArray(value) as Loose[]).flatMap((row) => {
    const record = asRecord(row)
    const sourceRecordId = str(record.sourceRecordId).trim().slice(0, 100)
    const role = str(record.role)
    if (!sourceRecordId || !['editor', 'owner'].includes(role)) return []
    return [
      {
        resend: record.resend === true,
        role: role as SiteStaffInviteRole,
        sourceRecordId,
      },
    ]
  })
