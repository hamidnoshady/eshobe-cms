// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { idOf } from '@/lib/ids'
import { setMigrationContext } from '@/lib/migration-context'
import { slugify } from '@/lib/slug'

import { cmsTypedUser } from './cmsUser'

/**
 * Issue #166 — the custom content engine under the multi-tenant rules, plus
 * the side-effect-free migration write.
 *
 * Runs against the seeded database (`pnpm seed`): `acme.localhost` and
 * `studio.localhost` are the two tenants, `shop.localhost` hosts the order
 * invariant. Everything created here is removed afterwards, and the shop
 * product's inventory is restored to exactly what the seed left.
 */
let payload: Payload

const ids = {
  acme: '',
  acmeEditor: '',
  acmeGenre: '',
  acmeOwner: '',
  acmePortfolio: '',
  acmeTag: '',
  acmeTermChild: '',
  acmeTermParent: '',
  acmeTermTagSameSlug: '',
  draftEntry: '',
  draftTermRelation: '',
  privateEntry: '',
  publishedEntry: '',
  relation: '',
  shop: '',
  studio: '',
  studioEntry: '',
  studioPortfolio: '',
  termRelation: '',
}

const asData = (value: unknown): never => value as never

/**
 * Collection hooks fail with a Payload `ValidationError`, whose `.message` is
 * only a summary ("The following field is invalid: …"). The field messages
 * the admin renders live in `data.errors`, so assertions read them from there.
 */
const rejectsWithFieldError = async (promise: Promise<unknown>, pattern: RegExp) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  const errors =
    (error as { data?: { errors?: { message: string }[] } } | null)?.data?.errors ??
    []
  expect(errors.map((e) => e.message).join(' ')).toMatch(pattern)
}

const create = async (collection: string, data: Record<string, unknown>): Promise<string> => {
  // The admin generates slugs client-side; every local-API caller (seed,
  // importer, this spec) passes one explicitly.
  const slugSource = typeof data.title === 'string' ? data.title : data.name
  if (data.slug === undefined && typeof slugSource === 'string') {
    data = { ...data, slug: slugify(slugSource) }
  }

  const doc = await payload.create({
    collection: asData(collection),
    data: asData(data),
    depth: 0,
  })

  return String((doc as { id: unknown }).id)
}

const findSite = async (domain: string): Promise<string> => {
  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    where: { domain: { equals: domain } },
  })
  if (!docs[0]) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)

  return String(docs[0].id)
}

const findUser = async (email: string) => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: email } },
  })
  const user = docs[0]
  if (!user) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  // CLAUDE.md: an isolation assertion whose fixture accidentally holds the
  // platform role passes vacuously. Pin it before anything relies on it.
  expect(user.role).toBe('user')

  return cmsTypedUser(user)
}

const readAnon = async (collection: string, host: string): Promise<Record<string, unknown>[]> => {
  const req = await createLocalReq(
    {
      req: {
        headers: new Headers({ accept: 'application/json', host }),
        method: 'GET',
        url: `http://${host}/api/${collection}`,
      } as Partial<PayloadRequest>,
    },
    payload,
  )
  const { docs } = await (payload.find as (args: unknown) => Promise<{ docs: unknown[] }>)({
    collection,
    depth: 0,
    overrideAccess: false,
    pagination: false,
    req,
  })

  return docs as Record<string, unknown>[]
}

const readAs = async (
  collection: string,
  user: Awaited<ReturnType<typeof findUser>>,
): Promise<Record<string, unknown>[]> => {
  const req = await createLocalReq({ user }, payload)
  const { docs } = await (payload.find as (args: unknown) => Promise<{ docs: unknown[] }>)({
    collection,
    depth: 0,
    overrideAccess: false,
    pagination: false,
    req,
  })

  return docs as Record<string, unknown>[]
}

const portfolioType = (site: string, taxonomies: string[] = []) => ({
  archiveSlug: 'نمونه-کار',
  fieldSchema: [
    { fieldType: 'text', key: 'client', label: 'کارفرما', required: true, searchable: true },
    { fieldType: 'number', key: 'year', label: 'سال' },
  ],
  hasArchive: true,
  hierarchical: false,
  key: 'portfolio',
  permalinkTemplate: '/{archive}/{slug}',
  pluralLabel: 'نمونه‌کارها',
  singularLabel: 'نمونه‌کار',
  site,
  taxonomies,
})

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  ids.acme = await findSite('acme.localhost')
  ids.studio = await findSite('studio.localhost')
  ids.shop = await findSite('shop.localhost')
  ids.acmeOwner = String((await findUser('acme@eshobe.test')).id)
  ids.acmeEditor = String((await findUser('acme-editor@eshobe.test')).id)

  ids.acmeGenre = await create('taxonomy-definitions', {
    archiveSlug: 'سبک',
    hasArchive: true,
    hierarchical: true,
    key: 'genre',
    pluralLabel: 'سبک‌ها',
    singularLabel: 'سبک',
    site: ids.acme,
  })
  ids.acmeTag = await create('taxonomy-definitions', {
    archiveSlug: 'برچسب',
    hasArchive: true,
    hierarchical: false,
    key: 'content_tag',
    pluralLabel: 'برچسب‌ها',
    singularLabel: 'برچسب',
    site: ids.acme,
  })
  ids.acmePortfolio = await create(
    'content-type-definitions',
    portfolioType(ids.acme, [ids.acmeGenre]),
  )
  ids.studioPortfolio = await create(
    'content-type-definitions',
    portfolioType(ids.studio),
  )

  ids.acmeTermParent = await create('taxonomy-terms', {
    name: 'مسکونی',
    site: ids.acme,
    taxonomy: ids.acmeGenre,
  })
  ids.acmeTermChild = await create('taxonomy-terms', {
    name: 'ویلایی',
    parent: ids.acmeTermParent,
    site: ids.acme,
    taxonomy: ids.acmeGenre,
  })
  // Same name (hence same slug) in a different taxonomy: a different term.
  ids.acmeTermTagSameSlug = await create('taxonomy-terms', {
    name: 'مسکونی',
    site: ids.acme,
    taxonomy: ids.acmeTag,
  })

  ids.publishedEntry = await create('content-entries', {
    contentType: ids.acmePortfolio,
    fieldValues: { client: 'شرکت آوا', legacy_key: 'حفظ‌شود', year: 1402 },
    site: ids.acme,
    source: {
      installation: 'example.ir',
      mappingStatus: 'imported',
      rawPayload: { secret_meta: 'نباید عمومی شود' },
      sourceId: '42',
      sourceType: 'portfolio',
      system: 'wordpress',
    },
    status: 'published',
    title: 'خانه کنار دریا',
  })
  ids.draftEntry = await create('content-entries', {
    contentType: ids.acmePortfolio,
    fieldValues: { client: 'آوا' },
    site: ids.acme,
    status: 'draft',
    title: 'پیش‌نویس پروژه',
  })
  ids.privateEntry = await create('content-entries', {
    contentType: ids.acmePortfolio,
    fieldValues: { client: 'آوا' },
    site: ids.acme,
    status: 'private',
    title: 'پروژه خصوصی',
  })
  ids.studioEntry = await create('content-entries', {
    contentType: ids.studioPortfolio,
    fieldValues: { client: 'استودیو' },
    site: ids.studio,
    status: 'published',
    title: 'پروژه استودیو',
  })

  // `taxonomy` is deliberately omitted: the hook derives it from the term.
  ids.termRelation = await create('entry-term-relations', {
    entry: ids.publishedEntry,
    site: ids.acme,
    term: ids.acmeTermChild,
  })
  // A term filing on the draft: it must stay invisible until the draft is public.
  ids.draftTermRelation = await create('entry-term-relations', {
    entry: ids.draftEntry,
    site: ids.acme,
    term: ids.acmeTermParent,
  })
  ids.relation = await create('content-relations', {
    fromEntry: ids.publishedEntry,
    relationKind: 'acf:related_projects',
    site: ids.acme,
    targetCollection: 'content-entries',
    targetEntry: ids.draftEntry,
  })
}, 180_000)

afterAll(async () => {
  const remove = async (collection: string, id: string): Promise<void> => {
    if (!id) return
    await payload.delete({ collection: asData(collection), id }).catch(() => undefined)
  }

  await remove('content-relations', ids.relation)
  await remove('entry-term-relations', ids.termRelation)
  await remove('entry-term-relations', ids.draftTermRelation)
  await remove('content-entries', ids.publishedEntry)
  await remove('content-entries', ids.draftEntry)
  await remove('content-entries', ids.privateEntry)
  await remove('content-entries', ids.studioEntry)
  await remove('taxonomy-terms', ids.acmeTermChild)
  await remove('taxonomy-terms', ids.acmeTermParent)
  await remove('taxonomy-terms', ids.acmeTermTagSameSlug)
  await remove('content-type-definitions', ids.acmePortfolio)
  await remove('content-type-definitions', ids.studioPortfolio)
  await remove('taxonomy-definitions', ids.acmeGenre)
  await remove('taxonomy-definitions', ids.acmeTag)
}, 120_000)

describe('custom content engine tenancy', () => {
  it('registers tenant-scoped reads: anonymous sees only own-site published entries', async () => {
    const onAcme = await readAnon('content-entries', 'acme.localhost')
    const titles = onAcme.map((doc) => doc.title)

    expect(titles).toContain('خانه کنار دریا')
    expect(titles).not.toContain('پیش‌نویس پروژه') // draft
    expect(titles).not.toContain('پروژه خصوصی') // private
    expect(titles).not.toContain('پروژه استودیو') // other tenant
    expect(new Set(onAcme.map((doc) => idOf(doc.site)))).toEqual(new Set([ids.acme]))
  })

  it('never returns the raw source payload or unmapped meta anonymously', async () => {
    const [doc] = await readAnon('content-entries', 'acme.localhost')
    const source = doc!.source as Record<string, unknown> | undefined

    expect(doc!.unmappedMeta).toBeUndefined()
    expect(source?.rawPayload).toBeUndefined()
    // Mapped provenance is publishable; the raw record is not.
    expect(source?.sourceId).toBe('42')
  })

  it('preserves unknown source keys in unmappedMeta and derives search text', async () => {
    const { docs } = await (payload.find as (args: unknown) => Promise<{ docs: Record<string, unknown>[] }>)({
      collection: 'content-entries',
      depth: 0,
      overrideAccess: true,
      where: { id: { equals: ids.publishedEntry } },
    })
    const doc = docs[0]!

    expect(doc.fieldValues).toEqual({ client: 'شرکت آوا', year: 1402 })
    expect(doc.unmappedMeta).toEqual({ legacy_key: 'حفظ‌شود' })
    expect(String(doc.searchText)).toContain('شرکت آوا')
  })

  it('derives the relation taxonomy from its term', async () => {
    const { docs } = await (payload.find as (args: unknown) => Promise<{ docs: Record<string, unknown>[] }>)({
      collection: 'entry-term-relations',
      depth: 0,
      overrideAccess: true,
      where: { id: { equals: ids.termRelation } },
    })

    expect(idOf(docs[0]!.taxonomy)).toBe(ids.acmeGenre)
  })

  it('hides a draft entry’s term filings until the entry is public', async () => {
    const relations = await readAnon('entry-term-relations', 'acme.localhost')
    const relationIds = relations.map((doc) => String(doc.id))

    expect(relationIds).toContain(ids.termRelation) // published entry
    expect(relationIds).not.toContain(ids.draftTermRelation) // draft entry
  })

  it('lets site staff read their own drafts — and only their own', async () => {
    const owner = await findUser('acme@eshobe.test')
    const docs = await readAs('content-entries', owner)
    const titles = docs.map((doc) => doc.title)

    expect(titles).toEqual(expect.arrayContaining(['خانه کنار دریا', 'پیش‌نویس پروژه']))
    expect(titles).not.toContain('پروژه استودیو')
  })

  it('gates publishing to the site owner', async () => {
    const editor = await findUser('acme-editor@eshobe.test')
    const editorReq = await createLocalReq({ user: editor }, payload)

    await expect(
      (payload.update as (args: unknown) => Promise<unknown>)({
        collection: 'content-entries',
        data: { status: 'published' },
        id: ids.draftEntry,
        overrideAccess: false,
        req: editorReq,
      }),
    ).rejects.toThrow()

    // Still a draft afterwards.
    const { docs } = await (payload.find as (args: unknown) => Promise<{ docs: Record<string, unknown>[] }>)({
      collection: 'content-entries',
      depth: 0,
      overrideAccess: true,
      select: { status: true },
      where: { id: { equals: ids.draftEntry } },
    })
    expect(docs[0]!.status).toBe('draft')
  })

  it('refuses wiring an entry to another site’s content type', async () => {
    await rejectsWithFieldError(
      create('content-entries', {
        contentType: ids.studioPortfolio,
        fieldValues: { client: 'x' },
        site: ids.acme,
        status: 'draft',
        title: 'نشت بین سایت‌ها',
      }),
      /متعلق به این سایت نیست/,
    )
  })

  it('refuses a term relation whose taxonomy the content type never declared, and duplicates', async () => {
    await rejectsWithFieldError(
      create('entry-term-relations', {
        entry: ids.publishedEntry,
        site: ids.acme,
        term: ids.acmeTermTagSameSlug, // content_tag is not linked to portfolio
      }),
      /پیوسته نیست/,
    )

    await rejectsWithFieldError(
      create('entry-term-relations', {
        entry: ids.publishedEntry,
        site: ids.acme,
        term: ids.acmeTermChild, // already related above
      }),
      /از قبل/,
    )
  })

  it('refuses wrong-typed field values instead of coercing them silently', async () => {
    await expect(
      create('content-entries', {
        contentType: ids.acmePortfolio,
        fieldValues: { client: 'x', year: '۱۴۰۲' },
        site: ids.acme,
        status: 'draft',
        title: 'نوع اشتباه',
      }),
    ).rejects.toThrow()
  })

  it('refuses a parent from another taxonomy and a parent in a flat taxonomy', async () => {
    await expect(
      create('taxonomy-terms', {
        name: 'بد',
        parent: ids.acmeTermParent,
        site: ids.acme,
        taxonomy: ids.acmeTag,
      }),
    ).rejects.toThrow()
  })
})

describe('migration write side-effect suppression', () => {
  it('a replayed historical order never moves stock; a live transition does', async () => {
    const { docs: products } = await payload.find({
      collection: 'products',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ site: { equals: ids.shop } }, { title: { equals: 'سوهان هل' } }],
      },
    })
    const product = products[0]
    if (!product) throw new Error('Seeded tracked product missing — run `pnpm seed`')
    expect(product.trackInventory).toBe(true)
    const initial = Number(product.inventory)

    const inventory = async (): Promise<number> => {
      const { docs } = await payload.find({
        collection: 'products',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        select: { inventory: true },
        where: { id: { equals: String(product.id) } },
      })

      return Number(docs[0]!.inventory)
    }

    const order = await payload.create({
      collection: 'orders',
      data: asData({
        buyer: { name: 'مهاجر تاریخچه', phone: '09121234567' },
        currency: 'IRT',
        payment: { provider: 'bank' },
        product: String(product.id),
        quantity: 2,
        site: ids.shop,
        status: 'pending',
        total: 200000,
        unitPrice: 100000,
      }),
      depth: 0,
    })

    try {
      const migrateReq = setMigrationContext(
        await createLocalReq({}, payload),
        { jobId: 'test-run', siteId: ids.shop, source: 'wordpress' },
      )

      // Historical replay: paid, then reversed — stock must not blink.
      await payload.update({
        collection: 'orders',
        data: asData({ status: 'paid' }),
        id: order.id,
        overrideAccess: true,
        req: migrateReq,
      })
      expect(await inventory()).toBe(initial)

      await payload.update({
        collection: 'orders',
        data: asData({ status: 'cancelled' }),
        id: order.id,
        overrideAccess: true,
        req: migrateReq,
      })
      expect(await inventory()).toBe(initial)

      // A context stamped for a *different* site suppresses nothing here.
      const foreignReq = setMigrationContext(await createLocalReq({}, payload), {
        siteId: ids.acme,
        source: 'wordpress',
      })
      await payload.update({
        collection: 'orders',
        data: asData({ status: 'paid' }),
        id: order.id,
        overrideAccess: true,
        req: foreignReq,
      })
      expect(await inventory()).toBe(initial - 2)

      // Live reversal restores it.
      await payload.update({
        collection: 'orders',
        data: asData({ status: 'refunded' }),
        id: order.id,
        overrideAccess: true,
      })
      expect(await inventory()).toBe(initial)
    } finally {
      await payload
        .update({
          collection: 'products',
          data: asData({ inventory: initial }),
          id: product.id,
          overrideAccess: true,
        })
        .catch(() => undefined)
      await payload.delete({ collection: 'orders', id: order.id }).catch(() => undefined)
    }
  })
})
