import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { ValidationError } from 'payload'

import config from '@/payload.config'
import { findForSite, findGlobalForSite, getSiteByHost } from '@/lib/site-query'

/**
 * The Wave 1 gate. Tenant isolation is the security boundary of the whole
 * platform, so it is tested rather than smoke-checked. Run `pnpm seed` first.
 *
 * Nothing here mocks Payload: a leak that only shows up against real access
 * control and real SQL is exactly the leak worth catching.
 */
let payload: Payload

const idOf = (value: unknown): string =>
  typeof value === 'object' && value !== null ? String((value as { id: string }).id) : String(value)

const site = async (domain: string) => {
  const { docs } = await payload.find({
    collection: 'sites',
    limit: 1,
    where: { domain: { equals: domain } },
  })

  if (!docs[0]) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)

  return docs[0]
}

/**
 * The multi-tenant plugin keys its access constraint off `req.user.collection`.
 * `createLocalReq` backfills that from `admin.user`, so a bare document works — but
 * spelling it out keeps the fixture shaped like a real authenticated request.
 */
const owner = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    limit: 1,
    where: { email: { equals: email } },
  })

  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)

  return { ...docs[0], collection: 'users' }
}

describe('multi-tenancy', () => {
  let acme: Awaited<ReturnType<typeof site>>
  let studio: Awaited<ReturnType<typeof site>>
  let acmeOwner: TypedUser
  let acmeEditor: TypedUser
  let studioPageId: string

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    acme = await site('acme.localhost')
    studio = await site('studio.localhost')
    acmeOwner = await owner('acme@eshobe.test')
    acmeEditor = await owner('acme-editor@eshobe.test')

    const { docs } = await payload.find({
      collection: 'pages',
      limit: 1,
      where: { and: [{ site: { equals: studio.id } }, { slug: { equals: 'about' } }] },
    })
    studioPageId = String(docs[0]?.id)
    expect(studioPageId).toBeTruthy()
  })

  describe('a tenant user', () => {
    it('is not a platform admin', () => {
      // `userHasAccessToAllTenants` short-circuits every constraint below, so if the
      // seed ever hands an owner `platformAdmin` this whole suite passes vacuously.
      expect(acmeOwner.role).toBe('user')
    })

    it('lists only their own site’s pages', async () => {
      const { docs } = await payload.find({
        collection: 'pages',
        overrideAccess: false,
        pagination: false,
        user: acmeOwner,
      })

      expect(docs.length).toBeGreaterThan(0)
      expect(docs.map((doc) => idOf(doc.site))).toEqual(docs.map(() => String(acme.id)))
    })

    it('cannot read another site’s page by id', async () => {
      const doc = await payload.findByID({
        id: studioPageId,
        collection: 'pages',
        disableErrors: true,
        overrideAccess: false,
        user: acmeOwner,
      })

      expect(doc).toBeNull()
    })

    it('cannot update another site’s page', async () => {
      await expect(
        payload.update({
          id: studioPageId,
          collection: 'pages',
          data: { title: 'ربوده‌شده' },
          overrideAccess: false,
          user: acmeOwner,
        }),
      ).rejects.toThrow()
    })

    it('cannot delete another site’s page', async () => {
      await expect(
        payload.delete({
          id: studioPageId,
          collection: 'pages',
          overrideAccess: false,
          user: acmeOwner,
        }),
      ).rejects.toThrow()
    })

    it('sees only their own site in the sites collection', async () => {
      const { docs } = await payload.find({
        collection: 'sites',
        overrideAccess: false,
        pagination: false,
        user: acmeOwner,
      })

      expect(docs.map((doc) => String(doc.id))).toEqual([String(acme.id)])
    })
  })

  describe('public rendering', () => {
    it('resolves a host to its site, ignoring the port', async () => {
      expect(idOf(await getSiteByHost('acme.localhost:3000'))).toBe(String(acme.id))
      expect(await getSiteByHost('nobody.localhost')).toBeNull()
      expect(await getSiteByHost(null)).toBeNull()
    })

    it('returns one site’s pages and no drafts', async () => {
      const { docs } = await findForSite('pages', String(acme.id), {
        locale: 'fa',
        pagination: false,
      })

      expect(docs.length).toBeGreaterThan(0)
      expect(docs.map((doc) => idOf(doc.site))).toEqual(docs.map(() => String(acme.id)))
      expect(docs.map((doc) => doc.slug)).not.toContain('coming-soon')
    })

    it('is the reason findForSite exists: access control alone does not scope anonymous reads', async () => {
      // The plugin adds a tenant constraint from the *user's* assigned sites, so an
      // anonymous request gets none at all. If this ever starts returning a single
      // site, the explicit `where` in findForSite has become redundant — until then
      // it is the only thing standing between two customers.
      const { docs } = await payload.find({
        collection: 'pages',
        overrideAccess: false,
        pagination: false,
      })

      expect(new Set(docs.map((doc) => idOf(doc.site))).size).toBeGreaterThan(1)
    })

    it('keeps per-site singletons separate', async () => {
      const acmeTheme = await findGlobalForSite('theme', String(acme.id), {})
      const studioTheme = await findGlobalForSite('theme', String(studio.id), {})

      expect(acmeTheme?.primary).toBe('#0f766e')
      expect(studioTheme?.primary).toBe('#7c3aed')
    })
  })

  describe('slugs', () => {
    it('are shareable across sites', async () => {
      const { totalDocs } = await payload.count({
        collection: 'pages',
        where: { slug: { equals: 'about' } },
      })

      expect(totalDocs).toBe(2)
    })

    it('collide within one site and locale', async () => {
      const error = await payload
        .create({
          collection: 'pages',
          data: {
            hero: { type: 'none' },
            layout: [{ blockType: 'content', columns: [] }],
            site: acme.id,
            slug: 'about',
            title: 'درباره ما (تکراری)',
          },
          locale: 'fa',
        })
        .then(() => null)
        .catch((err: unknown) => err as ValidationError)

      // Payload flattens the top-level message to "The following field is invalid",
      // so the message an editor actually reads is the per-field one.
      expect(error?.data?.errors?.[0]).toMatchObject({
        message: expect.stringContaining('از قبل استفاده شده'),
        path: 'slug',
      })
    })

    it('are generated from a Persian title, not stripped to nothing', async () => {
      const page = await payload.create({
        collection: 'pages',
        // `draft` only because `slug` is `required` in the generated types and the
        // whole point here is that the hook fills it in.
        data: {
          hero: { type: 'none' },
          layout: [{ blockType: 'content', columns: [] }],
          site: acme.id,
          title: 'تماس با ما',
        },
        draft: true,
        locale: 'fa',
      })

      expect(page.slug).toBe('تماس-با-ما')

      // `revalidatePath` throws outside a Next request scope.
      await payload.delete({
        collection: 'pages',
        context: { disableRevalidate: true },
        id: page.id,
      })
    })
  })

  describe('publishing', () => {
    /**
     * PLAN §8.7. Payload has no separate publish permission: it asks `update` access
     * with `_status: 'published'` and hides the Publish button when the answer is
     * false. So these two tests cover the admin button and the API in one.
     */
    let draftId: string

    beforeEach(async () => {
      const doc = await payload.create({
        collection: 'pages',
        context: { disableRevalidate: true },
        data: {
          _status: 'draft',
          hero: { type: 'none' },
          layout: [{ blockType: 'content', columns: [] }],
          site: acme.id,
          slug: 'publish-gate',
          title: 'آزمون انتشار',
        },
        locale: 'fa',
      })

      draftId = String(doc.id)
    })

    afterEach(async () => {
      await payload.delete({
        collection: 'pages',
        context: { disableRevalidate: true },
        id: draftId,
      })
    })

    const publishAs = (user: TypedUser) =>
      payload.update({
        id: draftId,
        collection: 'pages',
        context: { disableRevalidate: true },
        data: { _status: 'published' },
        overrideAccess: false,
        user,
      })

    it('is allowed for a site owner', async () => {
      expect((await publishAs(acmeOwner))._status).toBe('published')
    })

    it('is refused for a site editor', async () => {
      await expect(publishAs(acmeEditor)).rejects.toThrow()

      const doc = await payload.findByID({ collection: 'pages', id: draftId })
      expect(doc._status).toBe('draft')
    })

    it('leaves an editor able to save a draft', async () => {
      const doc = await payload.update({
        id: draftId,
        collection: 'pages',
        context: { disableRevalidate: true },
        data: { _status: 'draft', title: 'ویرایش‌شده' },
        overrideAccess: false,
        user: acmeEditor,
      })

      expect(doc.title).toBe('ویرایش‌شده')
    })

    it('is refused for an editor creating an already-published page', async () => {
      await expect(
        payload.create({
          collection: 'pages',
          context: { disableRevalidate: true },
          data: {
            _status: 'published',
            hero: { type: 'none' },
            layout: [{ blockType: 'content', columns: [] }],
            site: acme.id,
            slug: 'publish-gate-create',
            title: 'انتشار مستقیم',
          },
          locale: 'fa',
          overrideAccess: false,
          user: acmeEditor,
        }),
      ).rejects.toThrow()
    })
  })

  describe('locales', () => {
    it('serve each site only what it declares', () => {
      expect(acme.availableLocales).toEqual(['fa', 'en'])
      expect(studio.availableLocales).toEqual(['fa'])
    })

    it('offer the admin switcher only the selected site’s locales', async () => {
      // PLAN §8.3. The switcher lists every platform locale unless
      // `filterAvailableLocales` narrows it, and an editor translating into a locale
      // the site does not serve writes content that can never render.
      // `localization` is typed `false | {...}` because a Payload app may not be
      // localized at all. Ours always is.
      const localization = payload.config.localization
      if (!localization) throw new Error('localization is off')

      const filter = localization.filterAvailableLocales
      expect(filter).toBeTypeOf('function')

      const codesFor = async (siteId?: string) =>
        (
          (await filter!({
            locales: localization.locales,
            req: {
              headers: new Headers(siteId ? { cookie: `payload-tenant=${siteId}` } : {}),
              payload,
            } as unknown as PayloadRequest,
          })) ?? []
        ).map(({ code }) => code)

      expect(await codesFor(String(acme.id))).toEqual(['fa', 'en'])
      expect(await codesFor(String(studio.id))).toEqual(['fa'])
      // No site selected — the platform list, not an empty switcher.
      expect(await codesFor()).toEqual(['fa', 'en'])
    })

    it('store one document per locale, not one document per language', async () => {
      const fa = await findForSite('pages', String(acme.id), {
        locale: 'fa',
        where: { slug: { equals: 'home' } },
      })
      const en = await findForSite('pages', String(acme.id), {
        locale: 'en',
        where: { slug: { equals: 'home' } },
      })

      expect(fa.docs[0]?.id).toBe(en.docs[0]?.id)
      expect(fa.docs[0]?.title).toBe('آکمه')
      expect(en.docs[0]?.title).toBe('Acme')
    })

    it('do not surface an untranslated page under another locale', async () => {
      // Written in `fa` only. Because the slug is localized and a `where` on a
      // localized field does not fall back, there is no `en` row to match — so the
      // English site simply has no such route, which is what we want: a 404 beats a
      // page of Persian on an English site.
      //
      // The flip side is that a nav item pointing at an untranslated page links to a
      // 404, which is why the seed translates every page it links to.
      const page = await payload.create({
        collection: 'pages',
        context: { disableRevalidate: true },
        data: {
          _status: 'published',
          hero: { type: 'none' },
          layout: [{ blockType: 'content', columns: [] }],
          site: acme.id,
          slug: 'fa-only',
          title: 'فقط فارسی',
        },
        locale: 'fa',
      })

      const en = await findForSite('pages', String(acme.id), {
        locale: 'en',
        where: { slug: { equals: 'fa-only' } },
      })

      expect(en.docs).toHaveLength(0)

      await payload.delete({
        collection: 'pages',
        context: { disableRevalidate: true },
        id: page.id,
      })
    })
  })
})
