import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { PayloadRequest, TypedLocale } from 'payload'

import { localeOrder } from '@/platform/snapshot'

/**
 * Demo packs: a folder under `demo-packs/<key>/` holding `pack.json` and `images/`.
 *
 * A pack is content the operator can drop into an empty site with one click, so a
 * theme preview shows a finished-looking site instead of nothing. Adding a pack is
 * adding a folder (`demo-packs/graphite/build.mjs` is the pattern) — no code change.
 *
 * Rules that keep it safe to press on a real site:
 *  - **Only fills gaps.** A category or post whose slug already exists on the site is
 *    left alone; an image already imported (same alt) is reused. Never updates, never
 *    deletes, so a second click adds nothing.
 *  - **`site` is the URL's site**, never anything in the pack.
 *  - A pack names one `siteType` and is refused on any other.
 *
 * Pages matter as much as posts: a theme's section routes (`/about`, `/services`,
 * `/contact`, the home page's metadata) are filled from pages whose slug is the section
 * key, and a pack that ships only posts leaves those routes empty on a fresh site.
 */

type L = Record<string, string>
type PackPage = {
  contact?: {
    address: L
    email?: string
    heading: L
    hours: L
    latitude?: number
    longitude?: number
    phones?: string[]
  }
  description: L
  paragraphs: Record<string, string[]>
  slug: string
  title: L
}
type Pack = {
  categories: { slug: string; title: L }[]
  /** The pages a theme binds to its sections (home, about, services, contact). Optional for older packs. */
  pages?: PackPage[]
  description: L
  key: string
  name: L
  posts: {
    category: string
    facts: Record<string, [string, string][]>
    image: string
    more: L
    slug: string
    text: L
    title: L
  }[]
  siteType: string
}

const KEY = /^[a-z0-9][a-z0-9-]{0,60}$/
const FILE = /^[a-z0-9][a-z0-9._-]{0,80}$/i

export const demoPacksDir = () => process.env.DEMO_PACKS_DIR || path.join(process.cwd(), 'demo-packs')

const loadPack = async (key: string): Promise<null | Pack> => {
  if (!KEY.test(key)) return null
  try {
    const pack = JSON.parse(await readFile(path.join(demoPacksDir(), key, 'pack.json'), 'utf8')) as Pack
    return pack.key === key ? pack : null
  } catch {
    return null
  }
}

export const listDemoPacks = async (): Promise<Pick<Pack, 'description' | 'key' | 'name' | 'siteType'>[]> => {
  let names: string[] = []
  try {
    names = await readdir(demoPacksDir())
  } catch {
    return []
  }
  const packs = await Promise.all(names.map(loadPack))
  return packs.flatMap((p) =>
    p ? [{ description: p.description, key: p.key, name: p.name, siteType: p.siteType }] : [],
  )
}

// --- Lexical, just enough for a fact sheet + two paragraphs -------------------------

const text = (t: string) => ({ detail: 0, format: 0, mode: 'normal', style: '', text: t, type: 'text', version: 1 })
const para = (t: string, d: string) => ({
  children: [text(t)], direction: d, format: '', indent: 0, textFormat: 0, textStyle: '', type: 'paragraph', version: 1,
})
/** The theme reads a leading "label: value" bullet list as a project's fact sheet. */
const factList = (rows: [string, string][], d: string) => ({
  children: rows.map(([k, v], i) => ({
    children: [text(`${k}: ${v}`)], direction: d, format: '', indent: 0, type: 'listitem', value: i + 1, version: 1,
  })),
  direction: d, format: '', indent: 0, listType: 'bullet', start: 1, tag: 'ul', type: 'list', version: 1,
})
const dirOf = (locale: string) => (locale === 'fa' ? 'rtl' : 'ltr')
const heading = (t: string, tag: string, d: string) => ({
  children: [text(t)], direction: d, format: '', indent: 0, tag, type: 'heading', version: 1,
})
const root = (children: unknown[], d: string) => ({
  root: { children, direction: d, format: '', indent: 0, type: 'root', version: 1 },
})

/** One page in one locale. Built by the same function for every locale, so rows pair by index. */
const pageData = (p: PackPage, locale: string) => {
  const d = dirOf(locale)
  const layout: Record<string, unknown>[] = [
    {
      blockType: 'content',
      columns: [{ richText: root((p.paragraphs[locale] ?? []).map((t) => para(t, d)), d), size: 'full' }],
    },
  ]
  if (p.contact) {
    const c = p.contact
    layout.push({
      address: c.address[locale] ?? '',
      blockType: 'contact',
      email: c.email,
      heading: c.heading[locale] ?? '',
      hours: c.hours[locale] ?? '',
      latitude: c.latitude,
      longitude: c.longitude,
      phones: c.phones,
    })
  }
  return {
    generateSlug: false,
    hero: { richText: root([heading(p.title[locale] ?? '', 'h1', d)], d), type: 'lowImpact' },
    layout,
    meta: { description: p.description[locale] ?? '', title: p.title[locale] ?? '' },
    slug: p.slug,
    title: p.title[locale] ?? '',
  }
}

/**
 * Copies the default-locale document's row ids onto a second-locale write. `layout` is an
 * unlocalized array with localized text inside: a row without its id is a new row, and the
 * array is replaced — which deletes the first locale's text (CLAUDE.md, «Payload»).
 */
const withIds = <T,>(next: T, prev: unknown): T => {
  if (Array.isArray(next)) {
    return next.map((row, i) => withIds(row, Array.isArray(prev) ? prev[i] : undefined)) as T
  }
  if (next && typeof next === 'object') {
    const before = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(next)) out[key] = withIds(value, before[key])
    if (typeof before.id === 'string' && !('id' in out)) out.id = before.id
    return out as T
  }
  return next
}
const body = (p: Pack['posts'][number], locale: string) => ({
  root: {
    children: [factList(p.facts[locale] ?? [], dirOf(locale)), para(p.text[locale] ?? '', dirOf(locale)), para(p.more[locale] ?? '', dirOf(locale))],
    direction: dirOf(locale), format: '', indent: 0, type: 'root', version: 1,
  },
})

// --- apply --------------------------------------------------------------------------

export type DemoPackResult =
  | { ok: false; reason: 'not_found' | 'type_mismatch' }
  | { ok: true; summary: { categories: number; media: number; pages: number; posts: number; skipped: number } }

export const applyDemoPack = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  key: string,
  dryRun: boolean,
): Promise<DemoPackResult> => {
  const pack = await loadPack(key)
  if (!pack) return { ok: false, reason: 'not_found' }
  if (String(site.type) !== pack.siteType) return { ok: false, reason: 'type_mismatch' }

  const { payload } = req
  const siteId = String(site.id)
  const locales = localeOrder(site).filter((l) => pack.name[l]) as TypedLocale[]
  const [first, ...rest] = locales
  if (!first) return { ok: false, reason: 'not_found' }

  const summary = { categories: 0, media: 0, pages: 0, posts: 0, skipped: 0 }
  const inSite = { site: { equals: siteId } }
  const opts = { depth: 0, fallbackLocale: false, limit: 1, locale: first, overrideAccess: true } as const

  const categoryIds = new Map<string, number | string>()
  for (const c of pack.categories) {
    const found = (await payload.find({ ...opts, collection: 'categories', where: { and: [inSite, { slug: { equals: c.slug } }] } })).docs[0]
    if (found) { categoryIds.set(c.slug, found.id); summary.skipped++; continue }
    summary.categories++
    if (dryRun) continue
    const created = await payload.create({
      collection: 'categories', data: { generateSlug: false, site: siteId, slug: c.slug, title: c.title[first] }, locale: first, overrideAccess: true,
    } as never)
    for (const l of rest) {
      await payload.update({ collection: 'categories', data: { generateSlug: false, slug: c.slug, title: c.title[l] }, id: created.id, locale: l, overrideAccess: true } as never)
    }
    categoryIds.set(c.slug, created.id)
  }

  for (const p of pack.pages ?? []) {
    const exists = (await payload.find({ ...opts, collection: 'pages', where: { and: [inSite, { slug: { equals: p.slug } }] } })).docs[0]
    if (exists) { summary.skipped++; continue }
    summary.pages++
    if (dryRun) continue
    const created = await payload.create({
      collection: 'pages',
      data: { ...pageData(p, first), _status: 'published', publishedAt: new Date().toISOString(), site: siteId },
      locale: first, overrideAccess: true,
    } as never)
    for (const l of rest) {
      const stored = (await payload.findByID({ collection: 'pages', depth: 0, id: created.id, locale: first, overrideAccess: true } as never)) as unknown as Record<string, unknown>
      const data = pageData(p, l)
      await payload.update({
        collection: 'pages', data: { ...data, _status: 'published', layout: withIds(data.layout, stored.layout) }, id: created.id, locale: l, overrideAccess: true,
      } as never)
    }
  }

  for (const p of pack.posts) {
    const exists = (await payload.find({ ...opts, collection: 'posts', where: { and: [inSite, { slug: { equals: p.slug } }] } })).docs[0]
    if (exists) { summary.skipped++; continue }

    // The image: reuse one this pack already put on the site, else upload it.
    let mediaId: null | number | string = null
    if (FILE.test(p.image)) {
      const hit = (await payload.find({ ...opts, collection: 'media', where: { and: [inSite, { alt: { equals: p.title[first] } }] } })).docs[0]
      if (hit) mediaId = hit.id
      else {
        summary.media++
        if (!dryRun) {
          const created = await payload.create({
            collection: 'media', data: { alt: p.title[first], site: siteId }, filePath: path.join(demoPacksDir(), pack.key, 'images', p.image), locale: first, overrideAccess: true,
          } as never)
          for (const l of rest) await payload.update({ collection: 'media', data: { alt: p.title[l] }, id: created.id, locale: l, overrideAccess: true } as never)
          mediaId = created.id
        }
      }
    }

    summary.posts++
    if (dryRun) continue
    const category = categoryIds.get(p.category)
    const data = (l: string) => ({ content: body(p, l), generateSlug: false, slug: p.slug, title: p.title[l] })
    const created = await payload.create({
      collection: 'posts',
      data: { ...data(first), _status: 'published', categories: category ? [category] : [], heroImage: mediaId, publishedAt: new Date().toISOString(), site: siteId },
      locale: first, overrideAccess: true,
    } as never)
    for (const l of rest) await payload.update({ collection: 'posts', data: { ...data(l), _status: 'published' }, id: created.id, locale: l, overrideAccess: true } as never)
  }

  return { ok: true, summary }
}
