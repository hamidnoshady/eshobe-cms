// @vitest-environment node
//
// This spec is all Local-API reads and writes — no DOM. It must NOT run under
// jsdom: vitest's jsdom sandbox splits realms, and jose's JWT signing (used by
// local `login`/`resetPassword`) rejects the `Uint8Array` the other realm's
// `TextEncoder` returns. Under `node` the invite runs end to end.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPayload, createLocalReq } from 'payload'
import { ValidationError } from 'payload'

import config from '@/payload.config'
import { provisionSite, type ProvisionSiteInput } from '@/provisioning/provisionSite'
import { starterNav, starterPages } from '@/provisioning/starter-content'
import { findForSite, findGlobalForSite, getSiteByHost } from '@/lib/site-query'

/**
 * The Wave 5 gate. "A new client site goes from nothing to editable, themed and
 * populated in one action" — so the whole action is tested, not its parts: the
 * site doc, the seeded pages in every locale, the per-type theme, the nav, the
 * form, the invites, and the all-or-nothing rollback that keeps a failed run
 * from leaving a half-built site behind.
 *
 * Nothing here mocks Payload except where a *failure* must be forced: the writes
 * run against real access control and real SQL, which is what they do in
 * production. Run `pnpm seed` first.
 */
const DOMAIN = 'provisioned.localhost'
const OWNER_EMAIL = 'client-owner@eshobe.test'
const EDITOR_EMAIL = 'client-editor@eshobe.test'
const EXISTING_EMAIL = 'client-existing@eshobe.test'

let payload: Payload

const idOf = (value: unknown): string =>
  typeof value === 'object' && value !== null ? String((value as { id: string }).id) : String(value)

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    // `resetPasswordToken` is a hidden auth field — without this it is stripped
    // from every read, and the invite spec would test against `undefined`.
    showHiddenFields: true,
    where: { email: { equals: email } },
  })

  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)

  return docs[0]
}

/** A local req carrying the given user — the Local API's version of a session. */
const reqAs = async (user: TypedUser): Promise<PayloadRequest> =>
  createLocalReq({ user: { ...user, collection: 'users' } }, payload)

/** Deletes whatever the specs created: the site, its content, and its users. */
const teardown = async () => {
  const noRevalidate = { disableRevalidate: true }
  const req = await reqAs(await userByEmail('admin@eshobe.test'))

  // The users go first: their `tenants` rows reference the site, and the
  // multi-tenant plugin's own cleanup hook is deliberately off (CLAUDE.md), so a
  // site with assigned users refuses to delete — through a confusing
  // aborted-transaction error on `payload_preferences`, because Payload swallows
  // the per-doc FK failure inside the delete.
  await payload.delete({
    collection: 'users',
    req,
    where: { email: { in: [OWNER_EMAIL, EDITOR_EMAIL, EXISTING_EMAIL] } },
  })

  const { docs: sites } = await payload.find({
    collection: 'sites',
    where: { domain: { equals: DOMAIN } },
  })

  for (const site of sites) {
    for (const collection of ['pages', 'header', 'footer', 'theme', 'forms'] as const) {
      await payload.delete({
        collection,
        context: noRevalidate,
        req,
        where: { site: { equals: site.id } },
      })
    }
  }

  const { docs, errors } = await payload.delete({
    collection: 'sites',
    req,
    where: { domain: { equals: DOMAIN } },
  })

  if (errors.length) throw new Error(`Teardown failed to delete the site: ${errors[0]?.message}`)
  if (docs.length > 1) throw new Error(`Teardown deleted ${docs.length} sites — more than one matched ${DOMAIN}`)
}

/** The input the happy-path specs share: bilingual business site, owner + editor. */
const baseInput = (): ProvisionSiteInput => ({
  defaultLocale: 'fa' as const,
  domain: DOMAIN,
  locales: ['fa', 'en'] as ('fa' | 'en')[],
  name: 'شرکت نمونه',
  type: 'business' as const,
  users: [
    { email: OWNER_EMAIL, role: 'owner' as const },
    { email: EDITOR_EMAIL, role: 'editor' as const },
  ],
})

beforeAll(async () => {
  payload = await getPayload({ config: await config })
})

describe('site provisioning', () => {
  let adminReq: PayloadRequest

  beforeAll(async () => {
    const admin = await userByEmail('admin@eshobe.test')

    // The whole suite depends on the caller being a platform admin; if the seed
    // ever stops creating one, every "refuses" spec below passes vacuously.
    expect(admin.role).toBe('platformAdmin')

    adminReq = await reqAs(admin)
  })

  afterAll(teardown)

  describe('access', () => {
    it('refuses a caller who is not a platform admin', async () => {
      const acmeOwner = await userByEmail('acme@eshobe.test')

      expect(acmeOwner.role).toBe('user')

      await expect(
        provisionSite({ input: baseInput(), payload, req: await reqAs(acmeOwner) }),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('validation', () => {
    /** Every case must leave the database untouched — the checks run pre-transaction. */
    const sitesWithFixtureDomain = async (): Promise<number> =>
      (await payload.count({ collection: 'sites', where: { domain: { equals: DOMAIN } } })).totalDocs

    /**
     * Runs provisioning expecting it to fail, and hands back the error so each
     * spec can assert on its fields. A success is itself a failure.
     */
    const rejection = async (input: ProvisionSiteInput): Promise<ValidationError> =>
      provisionSite({ input, payload, req: adminReq }).then(
        () => {
          throw new Error('provisioning unexpectedly succeeded')
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(ValidationError)
          return error as ValidationError
        },
      )

    it('rejects a missing name, with the field named', async () => {
      const error = await rejection({ ...baseInput(), name: '  ' })

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.data.errors).toContainEqual(expect.objectContaining({ path: 'name' }))
      expect(await sitesWithFixtureDomain()).toBe(0)
    })

    it('rejects a domain with a protocol or path', async () => {
      const error = await rejection({ ...baseInput(), domain: 'https://client.ir/pricing' })

      expect(error.data.errors).toContainEqual(expect.objectContaining({ path: 'domain' }))
      expect(await sitesWithFixtureDomain()).toBe(0)
    })

    it('rejects a default locale outside the site’s own locales', async () => {
      const error = await rejection({
        ...baseInput(),
        defaultLocale: 'en' as const,
        locales: ['fa'] as ('fa' | 'en')[],
      })

      expect(error.data.errors).toContainEqual(expect.objectContaining({ path: 'defaultLocale' }))
      expect(await sitesWithFixtureDomain()).toBe(0)
    })

    it('rejects an invalid invite email, naming the row', async () => {
      const error = await rejection({
        ...baseInput(),
        users: [{ email: 'not-an-email', role: 'owner' }],
      })

      expect(error.data.errors).toContainEqual(expect.objectContaining({ path: 'users.0.email' }))
      expect(await sitesWithFixtureDomain()).toBe(0)
    })

    it('rejects the same email twice in one invite list', async () => {
      const error = await rejection({
        ...baseInput(),
        users: [
          { email: OWNER_EMAIL, role: 'owner' },
          { email: OWNER_EMAIL, role: 'editor' },
        ],
      })

      expect(error.data.errors).toContainEqual(expect.objectContaining({ path: 'users.1.email' }))
    })

    it('rejects a domain another site already owns, before creating anything', async () => {
      const error = await rejection({ ...baseInput(), domain: 'acme.localhost' })

      expect(error.data.errors).toContainEqual(expect.objectContaining({ path: 'domain' }))

      // Still exactly one acme — and nothing provisioned under the fixture name.
      const { totalDocs } = await payload.count({
        collection: 'sites',
        where: { domain: { equals: 'acme.localhost' } },
      })

      expect(totalDocs).toBe(1)
      expect(await sitesWithFixtureDomain()).toBe(0)
    })
  })

  describe('a failed run leaves nothing behind', () => {
    it('rolls the whole provisioning back when a write fails mid-flow', async () => {
      const counts = async () => ({
        forms: (await payload.count({ collection: 'forms' })).totalDocs,
        pages: (await payload.count({ collection: 'pages' })).totalDocs,
        sites: (await payload.count({ collection: 'sites' })).totalDocs,
        users: (await payload.count({ collection: 'users' })).totalDocs,
      })

      const before = await counts()

      // Fail on the *header* create: by then the site, theme, form and every page
      // already exist, so this is the strongest rollback claim a test can make —
      // nothing from before the failure survives either.
      const originalCreate = payload.create.bind(payload)
      const create = vi.spyOn(payload, 'create').mockImplementation(
        (async (options: { collection?: string }) => {
          if (options?.collection === 'header') throw new Error('simulated failure')

          return originalCreate(options as never)
        }) as typeof payload.create,
      )

      await expect(provisionSite({ input: baseInput(), payload, req: adminReq })).rejects.toThrow(
        'simulated failure',
      )

      create.mockRestore()

      expect(await counts()).toEqual(before)
    })
  })

  describe('the one action', () => {
    let result: Awaited<ReturnType<typeof provisionSite>>

    beforeAll(async () => {
      // An account that predates the site: inviting it must *assign*, not duplicate.
      await payload.create({
        collection: 'users',
        data: { email: EXISTING_EMAIL, password: 'test1234', role: 'user' },
        depth: 0,
        req: adminReq,
      })

      result = await provisionSite({
        input: {
          ...baseInput(),
          users: [...baseInput().users, { email: EXISTING_EMAIL, role: 'editor' }],
        },
        payload,
        req: adminReq,
      })
    })

    it('creates the sites doc with type, domain, locales and default locale', () => {
      const { site } = result

      expect(site.domain).toBe(DOMAIN)
      expect(site.type).toBe('business')
      expect(site.availableLocales).toEqual(['fa', 'en'])
      expect(site.defaultLocale).toBe('fa')
      expect(site.status).toBe('active')
      // Persian name → Persian slug, via the platform slugify (not Payload's ASCII one).
      expect(site.slug).toBe('شرکت-نمونه')
    })

    it('seeds the per-type theme', () => {
      expect(result.theme.primary).toBe('#0f766e')
      expect(result.theme.accent).toBe('#f59e0b')
      expect(result.theme.radius).toBe('sm')
      expect(idOf(result.theme.site)).toBe(String(result.site.id))
    })

    it('seeds the starter pages, published, in the default locale', async () => {
      const { docs } = await findForSite('pages', String(result.site.id), {
        locale: 'fa',
        pagination: false,
      })

      expect(docs.map((doc) => doc.slug).sort()).toEqual(['about', 'contact', 'home', 'services'])
      expect(docs.every((doc) => doc._status === 'published')).toBe(true)
    })

    it('seeds content in each of the site’s other locales, without rewriting the default one', async () => {
      const fa = await findForSite('pages', String(result.site.id), {
        locale: 'fa',
        where: { slug: { equals: 'home' } },
      })
      const en = await findForSite('pages', String(result.site.id), {
        locale: 'en',
        where: { slug: { equals: 'home' } },
      })

      // One document per locale, not one per language.
      expect(fa.docs[0]?.id).toBe(en.docs[0]?.id)
      expect(fa.docs[0]?.title).toBe('خانه')
      expect(en.docs[0]?.title).toBe('Home')

      // The §3.7 regression: `layout` is not localized, so the English pass had to
      // preserve every row id — the Persian copy must still be there, byte for byte.
      expect(fa.docs[0]?.layout[0]?.blockType).toBe('content')
      expect(JSON.stringify(fa.docs[0]?.layout[0])).toContain('نخستین پاراگراف سایت شماست')
      expect(en.docs[0]?.layout[0]?.blockType).toBe('content')
      expect(JSON.stringify(en.docs[0]?.layout[0])).toContain('first paragraph of your website')

      // …and they are the *same* rows — a translation, not a rewrite.
      expect(fa.docs[0]?.layout[0]?.id).toBe(en.docs[0]?.layout[0]?.id)
    })

    it('uses the blocks the site type allows', async () => {
      const services = await findForSite('pages', String(result.site.id), {
        locale: 'fa',
        where: { slug: { equals: 'services' } },
      })

      const blockTypes = services.docs[0]?.layout.map(({ blockType }) => blockType)

      expect(blockTypes).toContain('pricing')
      expect(blockTypes).toContain('faq')
    })

    it('links the CTA blocks at the contact page it created', async () => {
      const home = await findForSite('pages', String(result.site.id), {
        depth: 1,
        locale: 'fa',
        where: { slug: { equals: 'home' } },
      })

      const cta = home.docs[0]?.layout.find(({ blockType }) => blockType === 'cta')

      expect(cta).toBeDefined()
      expect(
        cta && 'links' in cta ? idOf(cta.links?.[0]?.link.reference?.value) : null,
      ).toBe(String(result.pages.find((page) => page.slug === 'contact')?.id))
    })

    it('seeds the header and footer nav, referencing the created pages', async () => {
      for (const collection of ['header', 'footer'] as const) {
        const nav = await findGlobalForSite(collection, String(result.site.id), {
          depth: 1,
          locale: 'fa',
        })

        expect(nav?.navItems?.map(({ link }) => link.label)).toEqual(['درباره ما', 'خدمات', 'تماس'])
        expect(nav?.navItems?.every(({ link }) => link.type === 'reference')).toBe(true)

        const targets = nav?.navItems?.map(({ link }) =>
          typeof link.reference?.value === 'object' && link.reference?.value !== null
            ? link.reference.value.slug
            : null,
        )

        expect(targets).toEqual(['about', 'services', 'contact'])
      }
    })

    it('translates the nav labels for the site’s other locale without losing the references', async () => {
      const nav = await findGlobalForSite('header', String(result.site.id), { depth: 1, locale: 'en' })
      const faNav = await findGlobalForSite('header', String(result.site.id), { depth: 1, locale: 'fa' })

      expect(nav?.navItems?.map(({ link }) => link.label)).toEqual(['About us', 'Services', 'Contact'])

      // Same rows — the label was translated in place, the references untouched.
      expect(nav?.navItems?.map(({ id }) => id)).toEqual(faNav?.navItems?.map(({ id }) => id))
      expect(nav?.navItems?.every(({ link }) => link.type === 'reference')).toBe(true)
    })

    it('seeds a contact form and translates its labels', async () => {
      const faForm = await findGlobalForSite('forms', String(result.site.id), { locale: 'fa' })
      const enForm = await findGlobalForSite('forms', String(result.site.id), { locale: 'en' })

      const label = (field: NonNullable<typeof faForm>['fields'] extends (infer T)[] | null | undefined ? T : never) =>
        'label' in field ? field.label : null

      expect(faForm?.fields?.map(label)).toEqual(['نام', 'رایانامه', 'پیام'])
      expect(faForm?.submitButtonLabel).toBe('ارسال پیام')
      expect(enForm?.fields?.map(label)).toEqual(['Name', 'Email', 'Message'])
      expect(enForm?.submitButtonLabel).toBe('Send message')

      // The field rows are shared, not rebuilt: `name` is the form's own identity.
      expect(faForm?.fields?.[0]).toMatchObject({ name: 'name' })
      expect(enForm?.fields?.[0]).toMatchObject({ name: 'name' })
    })

    it('invites new users with a per-site role and a set-password token', async () => {
      const owner = await userByEmail(OWNER_EMAIL)
      const editor = await userByEmail(EDITOR_EMAIL)

      expect(owner.role).toBe('user')
      expect(owner.tenants).toEqual([
        { id: expect.any(String), role: 'owner', tenant: String(result.site.id) },
      ])
      expect(editor.tenants).toEqual([
        { id: expect.any(String), role: 'editor', tenant: String(result.site.id) },
      ])

      // The invite is a reset token — the emailed link lets the client set their
      // own password, and no password was ever handed to the operator.
      expect(typeof owner.resetPasswordToken).toBe('string')
    })

    it('assigns a pre-existing account to the site instead of duplicating it', async () => {
      const existing = await userByEmail(EXISTING_EMAIL)

      expect(result.users.find(({ email }) => email === EXISTING_EMAIL)?.isNew).toBe(false)
      expect(existing.tenants).toEqual([
        { id: expect.any(String), role: 'editor', tenant: String(result.site.id) },
      ])
    })

    it('completes the invite: token → new password → login', async () => {
      const owner = await userByEmail(OWNER_EMAIL)

      await payload.resetPassword({
        collection: 'users',
        data: { password: 'a-brand-new-password', token: owner.resetPasswordToken as string },
        overrideAccess: true,
      })

      const login = await payload.login({
        collection: 'users',
        data: { email: OWNER_EMAIL, password: 'a-brand-new-password' },
      })

      expect(login.user?.email).toBe(OWNER_EMAIL)
    })

    it('gives the invited owner publish rights on their site only', async () => {
      const ownerReq = await reqAs(await userByEmail(OWNER_EMAIL))

      // Seeded pages are already published; a title edit with `_status:
      // 'published'` is the exact operation `writeUnlessPublishing` gates.
      const homeId = result.pages.find((page) => page.slug === 'home')?.id as string

      const updated = await payload.update({
        id: homeId,
        collection: 'pages',
        context: { disableRevalidate: true },
        data: { _status: 'published', title: 'خانهٔ ویرایش‌شده' },
        overrideAccess: false,
        req: ownerReq,
      })

      expect(updated._status).toBe('published')

      // …and no reach beyond their own site: the other tenants' pages stay invisible.
      const { docs } = await payload.find({
        collection: 'pages',
        overrideAccess: false,
        pagination: false,
        req: ownerReq,
      })

      expect(docs.length).toBeGreaterThan(0)
      expect(docs.map((doc) => idOf(doc.site))).toEqual(docs.map(() => String(result.site.id)))
    })
  })

  describe('the seeded starter set is internally consistent', () => {
    const refs = { contactEmail: 'x@y.test', contactPageId: 'p', formId: 'f', siteName: 's' }

    it('nav slugs exist among the pages, for every type and locale', () => {
      for (const type of ['business', 'portfolio', 'store'] as const) {
        for (const locale of ['fa', 'en'] as const) {
          const pageSlugs = starterPages(type, locale).map(({ slug }) => slug)
          const navSlugs = starterNav(type).map(({ slug }) => slug)

          for (const slug of navSlugs) {
            expect(pageSlugs, `${type}/${locale}: ${slug}`).toContain(slug)
          }
        }
      }
    })

    it('builds the same block sequence for both locales', () => {
      // The translation pass pairs rows by index — this is the invariant it leans on.
      for (const type of ['business', 'portfolio', 'store'] as const) {
        for (const [index, faPage] of starterPages(type, 'fa').entries()) {
          const enPage = starterPages(type, 'en')[index]

          expect(faPage.build(refs).map(({ blockType }) => blockType)).toEqual(
            enPage?.build(refs).map(({ blockType }) => blockType),
          )
        }
      }
    })
  })
})

describe('site lifecycle (the holding page’s data)', () => {
  /**
   * Wave 5: suspended/archived sites serve a holding page rather than 500ing.
   * The page component itself is verified over HTTP in
   * `tests/e2e/provisioning.e2e.spec.ts`; here the contract it stands on is
   * asserted — the host still resolves to the site, so the route can tell
   * "suspended" apart from an unknown domain.
   */
  let siteId: string
  let adminReq: PayloadRequest

  beforeAll(async () => {
    adminReq = await reqAs(await userByEmail('admin@eshobe.test'))

    const { site } = await provisionSite({ input: baseInput(), payload, req: adminReq })

    siteId = String(site.id)
  })

  afterEach(async () => {
    // Whatever status a spec leaves the site in, the next one starts from active.
    await payload.update({
      id: siteId,
      collection: 'sites',
      data: { status: 'active' },
      req: adminReq,
    })
  })

  afterAll(teardown)

  it('resolves an active site by host, port and all', async () => {
    expect(idOf(await getSiteByHost(`${DOMAIN}:3000`))).toBe(siteId)
  })

  it('still resolves a suspended site — the holding page needs to know it exists', async () => {
    await payload.update({
      id: siteId,
      collection: 'sites',
      data: { status: 'suspended' },
      req: adminReq,
    })

    const site = await getSiteByHost(DOMAIN)

    expect(idOf(site)).toBe(siteId)
    expect(site?.status).toBe('suspended')
  })

  it('still resolves an archived site', async () => {
    await payload.update({
      id: siteId,
      collection: 'sites',
      data: { status: 'archived' },
      req: adminReq,
    })

    expect((await getSiteByHost(DOMAIN))?.status).toBe('archived')
  })

  it('does not resolve an unknown host', async () => {
    expect(await getSiteByHost('nobody.localhost')).toBeNull()
  })
})
