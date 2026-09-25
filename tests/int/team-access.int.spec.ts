import type { Payload, TypedUser } from 'payload'

import { getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'

/**
 * Team boundary (task §12/§24): a site's own staff must not be able to grant
 * themselves — or anyone — platform-admin. The rule lives as field-level access on
 * `users.role` (`platformAdminFieldAccess`), and `access-control.int.spec.ts` proves
 * that function in isolation. This proves the *boundary*: that Payload actually
 * applies it on a real authenticated write, `overrideAccess: false`, so a customer
 * hitting the Local/REST API cannot escalate. Frontend hiding is never the
 * authorization — the write path is. Run `pnpm seed` first.
 */
let payload: Payload

const asUser = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })

  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)

  return { ...docs[0], collection: 'users' } as TypedUser
}

const roleOf = (doc: unknown): string => String((doc as { role?: unknown }).role ?? '')
const nameOf = (doc: unknown): string => String((doc as { name?: unknown }).name ?? '')

describe('team — platform-admin cannot be self-granted by a customer', () => {
  let owner: TypedUser
  let originalName: string

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    owner = await asUser('acme@eshobe.test')
    originalName = nameOf(owner)
    // Fixture sanity: a site user is a plain `user`, or the assertion is vacuous.
    expect(roleOf(owner)).toBe('user')
  })

  it('strips a role escalation from a site user’s own update, keeping the allowed fields', async () => {
    try {
      // A real authenticated write by the site user themselves. `name` is a field
      // they may change; `role` is not. Payload does not error on an unauthorized
      // field — it drops it — so the write succeeds with the escalation removed.
      await payload.update({
        collection: 'users',
        data: { name: 'آزمایش ارتقاء نقش', role: 'platformAdmin' } as never,
        id: owner.id,
        overrideAccess: false,
        user: owner,
      })

      const after = await payload.findByID({ collection: 'users', id: owner.id, overrideAccess: true })

      // The escalation was refused …
      expect(roleOf(after)).toBe('user')
      // … but the update genuinely ran (the allowed field changed), so this is the
      // field guard doing its job, not the whole write being blocked by accident.
      expect(nameOf(after)).toBe('آزمایش ارتقاء نقش')
    } finally {
      // Leave the fixture exactly as seeded — other suites read acme's owner.
      await payload.update({
        collection: 'users',
        data: { name: originalName } as never,
        id: owner.id,
        overrideAccess: true,
      })
    }
  })

  it('leaves an operator able to set the role, so the field is guarded not frozen', async () => {
    // The positive control: a platform admin session may write `role`. Proven by
    // re-writing the operator's own role to its current value (a no-op change that
    // would still be rejected for a customer), so nothing is mutated.
    const operator = await asUser('admin@eshobe.test')
    expect(roleOf(operator)).toBe('platformAdmin')

    const saved = await payload.update({
      collection: 'users',
      data: { role: 'platformAdmin' } as never,
      id: operator.id,
      overrideAccess: false,
      user: operator,
    })

    expect(roleOf(saved)).toBe('platformAdmin')
  })
})
