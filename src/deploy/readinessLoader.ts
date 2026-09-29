import type { PayloadRequest } from 'payload'

import { readyArtifactForCommit } from '@/deploy/artifacts'
import {
  computeThemeReadiness,
  type ReadinessSlot,
  type SlotState,
  type ThemeReadiness,
} from '@/deploy/readiness'
import { latestPackageCommit } from '@/deploy/service'
import { themeSettingsView } from '@/deploy/tenantSettings'
import { idOf } from '@/lib/ids'

/** The collection a content slot's binding points at. */
const SLOT_COLLECTION = {
  category: 'categories',
  form: 'forms',
  media: 'media',
  page: 'pages',
  post: 'posts',
} as const

type SlotType = keyof typeof SLOT_COLLECTION

/** Slot types whose text is localized, so a missing translation is worth reporting. */
const LOCALIZED: ReadonlySet<string> = new Set(['category', 'page', 'post'])

const stateOfSlot = async (
  req: PayloadRequest,
  siteId: string,
  slot: ReadinessSlot,
  binding: unknown,
  siteLocales: string[],
): Promise<SlotState> => {
  const id =
    binding && typeof binding === 'object' ? String((binding as { id?: unknown }).id ?? '') : ''
  if (!id) return null

  const collection = SLOT_COLLECTION[slot.type as SlotType]
  if (!collection) return null

  const doc = (await req.payload.findByID({
    collection: collection as 'pages',
    depth: 0,
    disableErrors: true,
    id,
    overrideAccess: true,
    req,
    select: { _status: true, site: true },
  })) as unknown as null | Record<string, unknown>

  // Another site's document is reported exactly like a deleted one: the descriptor
  // resolves it to `null` for the same reason, and the caller learns nothing more.
  if (!doc || idOf(doc.site) !== siteId) {
    return { found: false, presentLocales: [], unpublished: false }
  }

  const unpublished = doc._status === 'draft'
  const editHref = `/admin/collections/${collection}/${encodeURIComponent(id)}`
  if (!LOCALIZED.has(slot.type)) {
    return { editHref, found: true, presentLocales: siteLocales, unpublished }
  }

  const presentLocales: string[] = []
  for (const locale of siteLocales) {
    const localized = (await req.payload.findByID({
      collection: collection as 'pages',
      depth: 0,
      disableErrors: true,
      fallbackLocale: false,
      id,
      locale: locale as 'all',
      overrideAccess: true,
      req,
      select: { slug: true, title: true },
    })) as unknown as null | Record<string, unknown>
    const hasTitle = typeof localized?.title === 'string' && localized.title.trim() !== ''
    // Categories carry a slug too, but only pages and posts are addressed by it.
    const hasSlug = slot.type === 'category' || typeof localized?.slug === 'string'
    if (hasTitle && hasSlug) presentLocales.push(locale)
  }
  return { editHref, found: true, presentLocales, unpublished }
}

/**
 * Gathers what `computeThemeReadiness` needs for one site: the package it would run, the
 * customer's saved answers and bindings, and whether the pieces they point at exist and
 * are translated. Read-only, and it never reads a secret's value — `themeSettingsView`
 * reports a secret only as "set".
 */
export const loadThemeReadiness = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
): Promise<ThemeReadiness> => {
  const siteId = String(site.id)
  const siteLocales = (Array.isArray(site.availableLocales) ? site.availableLocales : [])
    .map(String)
    .filter(Boolean)
  const view = await themeSettingsView(req, siteId, 'platform')

  const pkg = view.package
    ? ((await req.payload.findByID({
        collection: 'theme-packages',
        depth: 0,
        disableErrors: true,
        id: view.package.id,
        overrideAccess: true,
        req,
      })) as unknown as null | Record<string, unknown>)
    : null

  const registry = pkg?.deploymentStrategy === 'registry_image'
  const commit = pkg ? latestPackageCommit(pkg) : null
  const artifact = registry && commit ? await readyArtifactForCommit(req, String(pkg?.id), commit) : null

  const siteType = String(site.type ?? 'business')
  const rowTypes = (Array.isArray(pkg?.siteTypes) ? (pkg?.siteTypes as unknown[]) : []).map(String)
  const manifestTypes = (pkg?.manifest as { siteTypes?: unknown } | undefined)?.siteTypes
  const siteTypeAllowed =
    (Array.isArray(manifestTypes) ? manifestTypes.map(String) : []).includes(siteType) &&
    (rowTypes.length === 0 || rowTypes.includes(siteType))

  const slots: ReadinessSlot[] = view.contentSlots.map((slot) => ({
    key: slot.key,
    labelFa: slot.labelFa ?? null,
    required: slot.required,
    type: slot.type,
  }))
  const slotStates: Record<string, SlotState> = {}
  for (const slot of slots) {
    slotStates[slot.key] = await stateOfSlot(req, siteId, slot, view.bindings[slot.key], siteLocales)
  }

  return computeThemeReadiness({
    assigned: Boolean(view.package),
    domainVerified: site.domainVerified === true,
    packageName: view.package?.name ?? null,
    packagePublished: pkg?.status === 'published',
    registry: { artifactReady: Boolean(artifact), needed: registry },
    siteLocales,
    siteTypeAllowed,
    slotStates,
    slots,
    variables: view.fields.map((field) => ({
      key: field.key,
      labelFa: field.label,
      required: field.required,
      set: field.secret ? field.set === true : Boolean(field.value?.trim()),
    })),
  })
}
