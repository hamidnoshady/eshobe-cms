import { randomBytes } from 'crypto'

import type { Payload, PayloadRequest } from 'payload'
import { ValidationError } from 'payload'

import type { Form, Header, Page, Site, Theme } from '@/payload-types'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { dirFor } from '@/lib/locales'
import { slugify } from '@/lib/slug'
import { richText } from './richText'
import {
  starterForm,
  starterFormTitle,
  starterNav,
  starterPages,
  starterProducts,
  starterTheme,
  type PageRefs,
  type SiteType,
  type StarterLocale,
} from './starter-content'

/** What a new client site needs from each of its users: a role, not a checklist. */
export type InviteUser = {
  email: string
  role: 'editor' | 'owner'
}

/** The one action's input: the `sites` doc's own fields, plus the users to invite. */
export type ProvisionSiteInput = {
  /** The site's display name — Persian by expectation, any script accepted. */
  name: string
  /** Host only, no protocol, port or path — the same contract `sites.domain` enforces. */
  domain: string
  type: SiteType
  /** Subset of the platform locales the site serves. */
  locales: StarterLocale[]
  /** Must be one of `locales`. */
  defaultLocale: StarterLocale
  users: InviteUser[]
}

export type ProvisionedUser = {
  email: string
  id: string
  /** False when the account already existed and was only assigned to this site. */
  isNew: boolean
  role: InviteUser['role']
}

/** The summary the admin view shows once the action completes. */
export type ProvisionResult = {
  site: Site
  theme: Theme
  pages: { id: string; slug: string; title: string }[]
  header: Header
  footer: Header
  form: Form
  users: ProvisionedUser[]
}

// `revalidatePath`/`revalidateTag` throw outside a Next request scope. The
// endpoint runs inside one, but provisioning through the Local API (scripts,
// tests) does not — so every write opts out, exactly like the dev seed.
const noRevalidate = { disableRevalidate: true }

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Field-level rejection, in Persian, before anything is written. */
const fail = (message: string, path: string): never => {
  throw new ValidationError({ errors: [{ message, path }] })
}

/**
 * Every check that needs no database runs before the transaction opens, so most
 * operator mistakes never create anything. One action means all-or-nothing —
 * that starts with failing fast.
 */
const validate = (input: ProvisionSiteInput): ProvisionSiteInput => {
  const name = input.name?.trim()
  if (!name) fail('نام سایت الزامی است.', 'name')

  const domain = input.domain?.trim().toLowerCase()
  if (!domain) fail('دامنه الزامی است.', 'domain')
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    fail('دامنه باید فقط میزبان باشد: بدون //:http، بدون پورت و بدون مسیر.', 'domain')
  }

  const locales = [...new Set(input.locales ?? [])]
  if (!locales.length) fail('دست‌کم یک زبان انتخاب کنید.', 'locales')
  const unknown = locales.filter((code) => !['fa', 'en'].includes(code))
  if (unknown.length) fail(`زبان پشتیبانی‌نشده: ${unknown.join('، ')}`, 'locales')

  if (!input.defaultLocale) fail('زبان پیش‌فرض الزامی است.', 'defaultLocale')
  if (!locales.includes(input.defaultLocale)) {
    fail('زبان پیش‌فرض باید بین زبان‌های انتخاب‌شدهٔ سایت باشد.', 'defaultLocale')
  }

  const users = input.users ?? []
  const seen = new Set<string>()

  users.forEach(({ email, role }, index) => {
    const address = email?.trim().toLowerCase()
    if (!address) fail('نشانی رایانامه الزامی است.', `users.${index}.email`)
    if (!emailPattern.test(address)) fail('نشانی رایانامه معتبر نیست.', `users.${index}.email`)
    if (!['owner', 'editor'].includes(role)) {
      fail('نقش باید «مالک» یا «ویرایشگر» باشد.', `users.${index}.role`)
    }
    if (seen.has(address)) fail('این رایانامه دو بار در فهرست آمده است.', `users.${index}.email`)
    seen.add(address)
  })

  return {
    ...input,
    domain,
    locales,
    name,
    users: users.map((user) => ({ ...user, email: user.email.trim().toLowerCase() })),
  }
}

/**
 * The second-locale pass for an unlocalized container: keep every row id so the
 * write is a translation, not a rewrite (CLAUDE.md — "An unlocalized array field
 * updated via the Local API on a second locale is replaced, not merged").
 *
 * Both locales are built by the same `starterPages` call, so rows pair by index.
 * A pairing that does not line up (the structures drifted) keeps the default
 * locale's row — fallback, never corruption.
 */
const withRowId = <T extends { id?: null | string }>(existing: T | undefined, next: T): T =>
  existing?.id ? { ...next, id: existing.id } : next

const translateLayout = (existing: Page['layout'], next: Page['layout']): Page['layout'] =>
  existing.map((row, index) => {
    const replacement = next[index]

    if (!replacement || replacement.blockType !== row.blockType) return row

    /** One block, rewritten in this locale on the default locale's row ids. */
    const translateRow = <T extends { id?: null | string; blockType: string }>(
      sameTypeRow: T,
      keys: (keyof T & string)[],
    ): T => {
      const merged = { ...sameTypeRow, id: row.id } as T

      for (const key of keys) {
        const nested = sameTypeRow[key] as unknown as { id?: null | string }[] | undefined
        const previous = (row as unknown as Record<string, { id?: null | string }[]>)[key]

        ;(merged as unknown as Record<string, unknown>)[key] = nested?.map((item, i) =>
          withRowId(previous?.[i], item),
        )
      }

      return merged
    }

    switch (row.blockType) {
      case 'content':
        return translateRow(
          replacement as Extract<LayoutRow, { blockType: 'content' }>,
          ['columns'],
        )
      case 'cta':
        return translateRow(replacement as Extract<LayoutRow, { blockType: 'cta' }>, ['links'])
      case 'features':
        return translateRow(replacement as Extract<LayoutRow, { blockType: 'features' }>, ['items'])
      case 'testimonials':
        return translateRow(
          replacement as Extract<LayoutRow, { blockType: 'testimonials' }>,
          ['items'],
        )
      case 'team':
        return translateRow(replacement as Extract<LayoutRow, { blockType: 'team' }>, ['members'])
      case 'pricing':
        return translateRow(replacement as Extract<LayoutRow, { blockType: 'pricing' }>, ['plans'])
      case 'faq':
        return translateRow(replacement as Extract<LayoutRow, { blockType: 'faq' }>, ['items'])
      default:
        // `contact` and `formBlock`: flat localized fields, or a relationship plus
        // localized rich text. Nothing nested carries a row id.
        return { ...replacement, id: row.id }
    }
  })

type LayoutRow = Page['layout'][number]

/** Nav rows are an unlocalized array too — same rule, one shape. */
const translateNav = (
  existing: Header['navItems'],
  next: Header['navItems'],
): Header['navItems'] =>
  existing?.map((row, index) => {
    const replacement = next?.[index]

    // The reference target is not localized; the label is. Sending the whole link
    // keeps the two in step.
    return replacement ? { link: replacement.link, id: row.id } : row
  })

/** Form field rows are blocks — ids again, paired by index and block type. */
const translateFormFields = (existing: Form['fields'], next: Form['fields']): Form['fields'] =>
  existing?.map((row, index) => {
    const replacement = next?.[index]

    return replacement && replacement.blockType === row.blockType
      ? { ...replacement, id: row.id }
      : row
  }) ?? []

/** One page's `hero`, localized rich text and all. */
const heroFor = (heading: string, locale: StarterLocale): Page['hero'] => ({
  type: 'lowImpact',
  richText: richText([{ text: heading, type: 'heading' }], dirFor(locale)),
})

/**
 * Creating a client site in one action (Wave 5): the `sites` doc, a starter set
 * of pages/nav/footer/theme for the chosen type, content in every one of the
 * site's locales, and the client's users invited with a per-site role.
 *
 * Agency-operated by design: the caller must be a platform admin. This function
 * is the security boundary for the Local API, not just the endpoint above it.
 *
 * Everything happens in one database transaction — a half-built site is worse
 * than an error, because the admin would show a site whose pages all 404.
 */
export const provisionSite = async ({
  input,
  payload,
  req,
}: {
  input: ProvisionSiteInput
  payload: Payload
  req: PayloadRequest
}): Promise<ProvisionResult> => {
  // WAVE-9 §9.4 — a `role: "platform"` API key is the same operator action called
  // by a headless client instead of the admin view's own form, so it satisfies this
  // boundary check exactly like a platform-admin session does.
  if (!(await isPlatformAdminOrPlatformKey(req, isPlatformAdmin(req.user)))) {
    throw new ValidationError({
      errors: [{ message: 'ساخت سایت فقط برای مدیر پلتفرم ممکن است.', path: '_error' }],
    })
  }

  const { name, domain, type, locales, defaultLocale, users } = validate(input)

  // The slug is internal, so a readable derivative of the name beats an error the
  // operator cannot act on. Two sites with the same name fall back to the domain,
  // which is unique by definition.
  const nameSlug = slugify(name)
  const { totalDocs: slugClash } = await payload.count({
    collection: 'sites',
    req,
    where: { slug: { equals: nameSlug } },
  })

  const transactionID = await payload.db.beginTransaction()

  // Null means the adapter cannot open one — and provisioning must never
  // half-write. The Postgres adapter always returns an id.
  if (!transactionID) throw new Error('The database adapter cannot open a transaction')

  // One req threaded through every write, so every operation joins the transaction.
  const txReq: PayloadRequest = { ...req, transactionID }

  try {
    const { docs: clash } = await payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      pagination: false,
      req: txReq,
      where: { domain: { equals: domain } },
    })

    if (clash.length) {
      throw new ValidationError({
        errors: [{ message: 'این دامنه قبلاً ثبت شده است.', path: 'domain' }],
      })
    }

    payload.logger.info(`Provisioning ${domain}...`)

    const site = await payload.create({
      collection: 'sites',
      data: {
        availableLocales: locales,
        defaultLocale,
        domain,
        name,
        slug: nameSlug && !slugClash ? nameSlug : slugify(domain),
        status: 'active',
        type,
      },
      depth: 0,
      req: txReq,
    })

    const theme = await payload.create({
      collection: 'theme',
      context: noRevalidate,
      data: { ...starterTheme(type), site: site.id },
      depth: 0,
      req: txReq,
    })

    const createdProducts: { id: string }[] = []
    let createdStore: { id: string } | null = null

    if (type === 'store') {
      const storeDoc = await payload.create({
        collection: 'store',
        context: noRevalidate,
        data: {
          currency: 'IRT',
          paymentProvider: 'bank',
          paymentInstructions:
            defaultLocale === 'fa'
              ? 'پرداخت از طریق کارت به کارت. پس از واریز با فروشگاه تماس بگیرید.'
              : 'Bank card transfer. Contact the store after payment.',
          site: site.id,
        },
        depth: 0,
        locale: defaultLocale,
        req: txReq,
      })
      createdStore = storeDoc as { id: string }

      for (const prod of starterProducts(defaultLocale)) {
        const doc = await payload.create({
          collection: 'products',
          context: noRevalidate,
          data: {
            _status: 'published',
            compareAtPrice: prod.compareAtPrice,
            price: prod.price,
            site: site.id,
            slug: prod.slug[defaultLocale],
            summary: prod.summary[defaultLocale],
            title: prod.title[defaultLocale],
            trackInventory: prod.trackInventory ?? false,
            ...(prod.trackInventory ? { inventory: prod.inventory ?? 0 } : {}),
          },
          depth: 0,
          locale: defaultLocale,
          req: txReq,
        })
        createdProducts.push(doc as { id: string })
      }
    }

    const refs: PageRefs = {
      contactEmail: `info@${domain}`,
      contactPageId: '', // set once the contact page exists — it is created first
      formId: '',
      siteName: name,
    }

    // The contact form precedes every page: the contact page's form block
    // references it.
    const form = await payload.create({
      collection: 'forms',
      context: noRevalidate,
      data: {
        site: site.id,
        title: starterFormTitle(name),
        ...starterForm(defaultLocale),
      },
      depth: 0,
      req: txReq,
    })

    refs.formId = String(form.id)

    const specs = starterPages(type, defaultLocale)
    const created: Page[] = []

    for (const spec of specs) {
      // `build` runs at creation time, so every CTA after the contact page points
      // at a real document. The home page's hero is the site's name.
      const page = await payload.create({
        collection: 'pages',
        context: noRevalidate,
        data: {
          _status: 'published',
          hero: heroFor(spec.slug === 'home' ? name : spec.hero, defaultLocale),
          layout: spec.build(refs),
          meta: { description: spec.intro.slice(0, 150), title: spec.title },
          site: site.id,
          slug: spec.slug,
          title: spec.title,
        },
        depth: 0,
        locale: defaultLocale,
        req: txReq,
      })

      if (spec.slug === 'contact') refs.contactPageId = String(page.id)

      created.push(page)
    }

    if (!refs.contactPageId) throw new Error('Starter content produced no contact page')

    /** Nav rows for one locale, referencing the created pages. */
    const navData = (locale: StarterLocale): Header['navItems'] =>
      starterNav(type).map(({ label, slug: navSlug }) => {
        const target = created.find((page) => page.slug === navSlug)

        if (!target) {
          throw new Error(`Nav references a page the starter set does not create: ${navSlug}`)
        }

        // `navItems` itself is not localized — the label inside each row is — so
        // one row set is translated in place on the second-locale pass.
        return {
          link: {
            label: label[locale],
            reference: { relationTo: 'pages' as const, value: String(target.id) },
            type: 'reference' as const,
          },
        }
      })

    const header = await payload.create({
      collection: 'header',
      context: noRevalidate,
      data: { navItems: navData(defaultLocale), site: site.id },
      depth: 0,
      locale: defaultLocale,
      req: txReq,
    })

    const footer = await payload.create({
      collection: 'footer',
      context: noRevalidate,
      data: { navItems: navData(defaultLocale), site: site.id },
      depth: 0,
      locale: defaultLocale,
      req: txReq,
    })

    // --- the second-locale pass -----------------------------------------------
    //
    // Every localized field gets a row in each of the site's other locales —
    // page content, nav labels, form labels. Fallback would *render* the default
    // locale's text fine, but a localized slug with no row makes the page
    // unreachable on that locale's URL, and the nav links to every starter page
    // in every locale the site serves.
    for (const locale of locales.filter((code) => code !== defaultLocale)) {
      const localeSpecs = starterPages(type, locale)

      for (const [index, page] of created.entries()) {
        const spec = localeSpecs[index]!

        await payload.update({
          id: page.id,
          collection: 'pages',
          context: noRevalidate,
          data: {
            hero: heroFor(spec.slug === 'home' ? name : spec.hero, locale),
            layout: translateLayout(page.layout, spec.build(refs)),
            meta: { description: spec.intro.slice(0, 150), title: spec.title },
            slug: spec.slug,
            title: spec.title,
          },
          depth: 0,
          locale,
          req: txReq,
        })
      }

      const translatedForm = starterForm(locale)

      await payload.update({
        id: form.id,
        collection: 'forms',
        context: noRevalidate,
        data: {
          confirmationMessage: translatedForm.confirmationMessage,
          fields: translateFormFields(form.fields, translatedForm.fields),
          submitButtonLabel: translatedForm.submitButtonLabel,
        },
        depth: 0,
        locale,
        req: txReq,
      })

      for (const [collection, doc] of [
        ['header', header],
        ['footer', footer],
      ] as const) {
        await payload.update({
          id: doc.id,
          collection,
          context: noRevalidate,
          data: { navItems: translateNav(doc.navItems, navData(locale)) },
          depth: 0,
          locale,
          req: txReq,
        })
      }

      if (type === 'store' && createdStore) {
        await payload.update({
          id: createdStore.id,
          collection: 'store',
          context: noRevalidate,
          data: {
            paymentInstructions:
              locale === 'fa'
                ? 'پرداخت از طریق کارت به کارت. پس از واریز با فروشگاه تماس بگیرید.'
                : 'Bank card transfer. Contact the store after payment.',
          },
          depth: 0,
          locale,
          req: txReq,
        })
      }

      if (type === 'store' && createdProducts.length) {
        const localeProducts = starterProducts(locale as StarterLocale)
        for (const [index, doc] of createdProducts.entries()) {
          const prod = localeProducts[index]
          if (!prod) continue
          await payload.update({
            id: doc.id,
            collection: 'products',
            context: noRevalidate,
            data: {
              slug: prod.slug[locale as StarterLocale],
              summary: prod.summary[locale as StarterLocale],
              title: prod.title[locale as StarterLocale],
            },
            depth: 0,
            locale,
            req: txReq,
          })
        }
      }
    }

    // --- invites ---------------------------------------------------------------
    const invited: ProvisionedUser[] = []

    for (const invitee of users) {
      const { docs } = await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        pagination: false,
        req: txReq,
        where: { email: { equals: invitee.email } },
      })

      if (docs[0]) {
        // An account that already exists (platform staff, or a client who works
        // with another of our sites) is assigned to the new site, not duplicated.
        const user = await payload.update({
          id: docs[0].id,
          collection: 'users',
          data: {
            tenants: [...(docs[0].tenants ?? []), { role: invitee.role, tenant: site.id }],
          },
          depth: 0,
          req: txReq,
        })

        invited.push({ email: invitee.email, id: String(user.id), isNew: false, role: invitee.role })
      } else {
        // A random password the caller never sees: the invite *is* the
        // set-password email, sent after the transaction commits.
        const user = await payload.create({
          collection: 'users',
          data: {
            email: invitee.email,
            password: randomBytes(24).toString('base64url'),
            role: 'user',
            tenants: [{ role: invitee.role, tenant: site.id }],
          },
          depth: 0,
          req: txReq,
        })

        invited.push({ email: invitee.email, id: String(user.id), isNew: true, role: invitee.role })
      }
    }

    await payload.db.commitTransaction(transactionID)

    // Invite emails after the commit: a rolled-back site must not have mailed
    // anyone a link to an account that no longer exists. A failed email is
    // logged, not thrown — the site itself is provisioned.
    for (const invitee of invited) {
      if (!invitee.isNew) continue

      try {
        await payload.forgotPassword({
          collection: 'users',
          data: { email: invitee.email },
          req,
        })
      } catch (error) {
        payload.logger.error(`Invite email for ${invitee.email} failed: ${error}`)
      }
    }

    payload.logger.info(`Provisioned ${domain}.`)

    return {
      site,
      theme,
      pages: created.map((page) => ({ id: String(page.id), slug: page.slug, title: page.title })),
      header,
      footer,
      form,
      users: invited,
    }
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID)

    throw error
  }
}
