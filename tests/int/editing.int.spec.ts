import type { Payload } from 'payload'

import { beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'

import config from '@/payload.config'
import { sitePath, siteUrl } from '@/lib/site-url'

/**
 * The Wave 3 gate: preview and SEO URLs point at the customer's own domain, and a
 * public form submission cannot be filed under someone else's site.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

const site = async (domain: string) => {
  const { docs } = await payload.find({
    collection: 'sites',
    limit: 1,
    where: { domain: { equals: domain } },
  })

  if (!docs[0]) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)

  return docs[0]
}

describe('document URLs', () => {
  /** Only the two fields `siteUrl` reads, so these cases need no database. */
  const acme = { defaultLocale: 'fa' as const, domain: 'acme.localhost' }

  it('gives the home page one URL, not `/home`', () => {
    // Two URLs for the front page splits its cache entry and its search ranking.
    expect(sitePath(acme, 'fa', 'home')).toBe('/')
    expect(sitePath(acme, 'fa', null)).toBe('/')
  })

  it('leaves the site’s own default locale unprefixed', () => {
    // `/about` and `/fa/about` would otherwise both render — duplicate content.
    expect(sitePath(acme, 'fa', 'about')).toBe('/about')
    expect(sitePath(acme, 'en', 'about')).toBe('/en/about')
  })

  it('builds an absolute URL on the customer’s domain, not the admin’s', () => {
    // The template used the deployment origin here, so every canonical tag, OG tag
    // and preview link pointed at a domain the customer does not own.
    expect(siteUrl(acme, { locale: 'en', origin: 'http://localhost:3000', slug: 'about' })).toBe(
      'http://acme.localhost:3000/en/about',
    )
  })

  it('keeps the deployment’s protocol and port', () => {
    // Dev serves every domain off one port, production off none. Hardcoding either
    // breaks the other.
    expect(siteUrl(acme, { locale: 'fa', origin: 'https://eshobe.com', slug: 'about' })).toBe(
      'https://acme.localhost/about',
    )
  })

  it('percent-encodes nothing it does not have to, and still round-trips Persian', () => {
    // A Persian slug is legal in a URL; the browser encodes it and shows it back.
    expect(sitePath(acme, 'fa', 'درباره-ما')).toBe('/درباره-ما')
  })
})

describe('form submissions', () => {
  let acmeForm: string
  let studioId: string

  beforeAll(async () => {
    payload = await getPayload({ config: await config })

    const [acme, studio] = [await site('acme.localhost'), await site('studio.localhost')]

    studioId = String(studio.id)

    const { docs } = await payload.find({
      collection: 'forms',
      limit: 1,
      where: { site: { equals: acme.id } },
    })

    if (!docs[0]) throw new Error('Seeded form missing — run `pnpm seed`')

    acmeForm = String(docs[0].id)
  })

  const submit = (data: { site?: string } = {}) =>
    payload.create({
      collection: 'form-submissions',
      data: {
        form: acmeForm,
        submissionData: [{ field: 'name', value: 'تست' }],
        ...data,
      },
      // As an anonymous visitor: `create` is public by design, which is exactly why
      // the site cannot be taken from the request.
      overrideAccess: false,
    })

  it('takes the site from the form, ignoring what the request claims', async () => {
    /**
     * The leak this closes: `create` access on `form-submissions` is `() => true`
     * (a contact form is submitted by anonymous visitors) and the multi-tenant
     * plugin only ANDs its site constraint on when `req.user` exists. So nothing
     * stood between the request body and the database, and a POST naming acme's
     * form with studio's site id filed acme's enquiry under studio — visible to
     * the wrong customer.
     */
    const doc = await submit({ site: studioId })

    expect(String(doc.site)).not.toBe(studioId)
  })

  it('fills the site in when the request omits it', async () => {
    // A public POST carries no tenant cookie, so without the hook the required
    // field is missing and every real submission fails validation.
    const doc = await submit({})

    expect(String(doc.site)).toBeTruthy()
    expect(String(doc.site)).not.toBe(studioId)
  })
})
