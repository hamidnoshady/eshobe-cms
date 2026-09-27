import type { PayloadRequest } from 'payload'

import type { User } from '@/payload-types'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { idOf, isUuid } from '@/lib/ids'
import {
  MAX_ENV_VALUE_LENGTH,
  PLATFORM_ENV_KEYS,
  validateRuntimeSettings,
  type ManifestEnvVar,
  type ManifestContentSlot,
  type ManifestRuntimeSetting,
  type ThemeManifest,
} from '@/lib/deploy/manifest'
import { isProductionMode } from '@/lib/deploy/status'

import { storedTenantValues } from './environment'
import { manifestOf } from './service'

/**
 * The customer's side of a deployable theme: the answers to the variables its
 * manifest declares `source: "tenant"` — a map key, an analytics id.
 *
 * ## Who decides what
 *
 * Deployable themes are **operator-managed**. Which package a site runs, on which
 * server, in which domain mode, is decided by platform staff through
 * `/api/platform/sites/:id/deployment*`. A customer's staff decide exactly one thing:
 * the values of the variables the theme asked *them* for. So every input this module
 * accepts is a value for a key; the site comes from the caller's own membership, and
 * the package from the site's deployments — never from the request.
 *
 * ## Secrets
 *
 * A variable the manifest marks `secret` is write-only: encrypted at rest
 * (`encryptThemeSettings`), masked on every read, and reported here only as "set" or
 * "not set". A blank submission leaves it unchanged; `clear` is the explicit door.
 */

export type SiteStaffRole = 'editor' | 'owner' | 'platform'

/** The caller's standing on this site: platform staff, the site's owner, its editor, or nothing. */
export const siteStaffRole = (user: unknown, siteId: string): null | SiteStaffRole => {
  const typed = user as null | (User & { collection?: string })
  if (!typed || (typed.collection && typed.collection !== 'users')) return null
  if (isPlatformAdmin(typed)) return 'platform'
  const row = typed.tenants?.find((entry) => idOf(entry.tenant) === siteId)
  if (!row) return null
  return row.role === 'owner' ? 'owner' : 'editor'
}

/** Owners and platform staff change a theme's settings; an editor may look. */
export const canEditThemeSettings = (role: null | SiteStaffRole): boolean =>
  role === 'owner' || role === 'platform'

/**
 * The deployable theme a site's settings are for, taken from its deployments rather
 * than from anyone's say-so: the one serving the customer's domain, else a live
 * preview, else the most recent attempt — a first deploy that failed because a
 * required value was missing is exactly when the customer needs this form.
 */
export const themePackageForSite = async (
  req: PayloadRequest,
  siteId: string,
): Promise<null | {
  id: string
  key: string
  manifest: ThemeManifest
  name: string
  variables: ManifestEnvVar[]
}> => {
  if (!isUuid(siteId)) return null

  const { docs } = await req.payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit: 25,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-createdAt',
    where: { and: [{ site: { equals: siteId } }, { status: { not_equals: 'removed' } }] },
  })

  const rows = docs as unknown as Record<string, unknown>[]
  const row =
    rows.find((doc) => doc.status === 'live' && isProductionMode(doc.domainMode)) ??
    rows.find((doc) => doc.status === 'live') ??
    rows[0]
  const packageId = row ? idOf(row.themePackage) : null
  if (!packageId) return null

  const pkg = (await req.payload.findByID({
    collection: 'theme-packages',
    depth: 0,
    disableErrors: true,
    id: packageId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>
  if (!pkg) return null

  const manifest = manifestOf(pkg)
  if (!manifest) return null

  return {
    id: String(pkg.id),
    key: String(pkg.key ?? ''),
    manifest,
    name: String(pkg.name ?? manifest.nameFa ?? manifest.name),
    variables: manifest.env.filter((variable) => variable.source === 'tenant'),
  }
}

export type ThemeSettingsField = {
  help: null | string
  key: string
  label: string
  required: boolean
  secret: boolean
  /** Secrets only: whether a value is stored. The value itself never leaves the server. */
  set?: boolean
  /** Non-secret only. */
  value?: string
}

export type ThemeSettingsView = {
  canEdit: boolean
  contentSlots: ManifestContentSlot[]
  bindings: Record<string, unknown>
  fields: ThemeSettingsField[]
  package: null | { id: string; key: string; name: string }
  runtimeSchema: ManifestRuntimeSetting[]
  runtimeSettings: Record<string, boolean | number | string>
}

/** What the settings form renders. Carries no ciphertext and no secret value. */
export const themeSettingsView = async (
  req: PayloadRequest,
  siteId: string,
  role: null | SiteStaffRole,
): Promise<ThemeSettingsView> => {
  const pkg = await themePackageForSite(req, siteId)
  if (!pkg)
    return {
      bindings: {},
      canEdit: false,
      contentSlots: [],
      fields: [],
      package: null,
      runtimeSchema: [],
      runtimeSettings: {},
    }

  const stored = await storedTenantValues(req, siteId, pkg.id)
  const { docs } = await req.payload.find({
    collection: 'site-theme-settings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { site: { equals: siteId } },
  })
  const row = (docs[0] ?? {}) as unknown as Record<string, unknown>
  const rawRuntime =
    row.runtimeSettings && typeof row.runtimeSettings === 'object'
      ? (row.runtimeSettings as Record<string, unknown>)
      : {}

  return {
    bindings:
      row.contentBindings && typeof row.contentBindings === 'object'
        ? (row.contentBindings as Record<string, unknown>)
        : {},
    canEdit: canEditThemeSettings(role),
    contentSlots: pkg.manifest.contentSlots,
    fields: pkg.variables.map((variable) => ({
      help: variable.help ?? null,
      key: variable.key,
      label: variable.labelFa ?? variable.key,
      required: variable.required,
      secret: variable.secret,
      ...(variable.secret
        ? { set: Boolean(stored.secrets[variable.key]) }
        : { value: stored.plain[variable.key] ?? '' }),
    })),
    package: { id: pkg.id, key: pkg.key, name: pkg.name },
    runtimeSchema: pkg.manifest.settings,
    runtimeSettings: validateRuntimeSettings(pkg.manifest, rawRuntime).values,
  }
}

export type ThemeSettingsInput = {
  bindings?: unknown
  clear?: unknown
  runtimeSettings?: unknown
  values?: unknown
}

/**
 * Validate and store a customer's answers.
 *
 * Refuses rather than drops: a key the theme did not declare, a platform variable,
 * a value too long for a build environment. The caller sees a Persian reason per key
 * instead of a save that silently kept half of what they typed.
 */
export const saveThemeSettings = async (
  req: PayloadRequest,
  siteId: string,
  input: ThemeSettingsInput,
): Promise<{ errors: string[]; ok: false } | { ok: true }> => {
  const pkg = await themePackageForSite(req, siteId)
  if (!pkg) return { errors: ['این سایت پوستهٔ نصب‌شدنی‌ای ندارد که تنظیماتی بخواهد.'], ok: false }

  const declared = new Map(pkg.variables.map((variable) => [variable.key, variable]))
  const errors: string[] = []

  const submitted =
    input.values && typeof input.values === 'object' && !Array.isArray(input.values)
      ? (input.values as Record<string, unknown>)
      : {}
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : []
  const hasRuntimeInput = input.runtimeSettings !== undefined
  const runtimeInput =
    input.runtimeSettings &&
    typeof input.runtimeSettings === 'object' &&
    !Array.isArray(input.runtimeSettings)
      ? (input.runtimeSettings as Record<string, unknown>)
      : {}
  const runtime = validateRuntimeSettings(pkg.manifest, runtimeInput)
  if (hasRuntimeInput) errors.push(...runtime.errors)

  const hasBindingsInput = input.bindings !== undefined
  const bindingsInput =
    input.bindings && typeof input.bindings === 'object' && !Array.isArray(input.bindings)
      ? (input.bindings as Record<string, unknown>)
      : {}
  const slots = new Map(pkg.manifest.contentSlots.map((slot) => [slot.key, slot]))
  const bindings: Record<string, { id: string; type: string }> = {}
  for (const [key, raw] of Object.entries(bindingsInput)) {
    const slot = slots.get(key)
    const id =
      raw && typeof raw === 'object' ? idOf((raw as Record<string, unknown>).id) : idOf(raw)
    if (!slot || !id || !isUuid(id)) {
      errors.push(`نگاشت «${key}» نامعتبر است.`)
      continue
    }
    const collection = (
      {
        category: 'categories',
        form: 'forms',
        media: 'media',
        page: 'pages',
        post: 'posts',
      } as const
    )[slot.type]
    const target = (await req.payload.findByID({
      collection: collection as 'pages',
      id,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
      select: { site: true },
    })) as unknown as null | Record<string, unknown>
    if (!target || idOf(target.site) !== siteId) {
      errors.push(`مقصد «${key}» به این سایت تعلق ندارد.`)
      continue
    }
    bindings[key] = { id, type: slot.type }
  }
  for (const slot of slots.values())
    if (hasBindingsInput && slot.required && !bindings[slot.key])
      errors.push(`نگاشت «${slot.labelFa ?? slot.key}» الزامی است.`)

  for (const key of [...Object.keys(submitted), ...clear]) {
    if ((PLATFORM_ENV_KEYS as readonly string[]).includes(key)) {
      errors.push(`«${key}» را سکو مقداردهی می‌کند و قابل تغییر نیست.`)
    } else if (!declared.has(key)) {
      errors.push(`متغیر «${key}» در این پوسته تعریف نشده است.`)
    }
  }

  for (const [key, raw] of Object.entries(submitted)) {
    if (
      raw !== null &&
      raw !== undefined &&
      typeof raw !== 'string' &&
      typeof raw !== 'number' &&
      typeof raw !== 'boolean'
    ) {
      errors.push(`مقدار «${key}» باید متن باشد.`)
      continue
    }
    if (String(raw ?? '').length > MAX_ENV_VALUE_LENGTH) {
      errors.push(`مقدار «${key}» از ${MAX_ENV_VALUE_LENGTH} نویسه بلندتر است.`)
    }
  }

  if (errors.length) return { errors, ok: false }

  const stored = await storedTenantValues(req, siteId, pkg.id)
  const plain: Record<string, string> = {}
  const secrets: Record<string, string> = {}

  // Start from what is stored for *this* package, limited to what it still declares.
  for (const [key, variable] of declared) {
    const target = variable.secret ? secrets : plain
    const source = variable.secret ? stored.secrets : stored.plain
    if (source[key]) target[key] = source[key]
  }

  for (const [key, raw] of Object.entries(submitted)) {
    const variable = declared.get(key)!
    const value = String(raw ?? '').trim()
    if (variable.secret) {
      // Blank is "unchanged": the form never shows the stored secret, so an untouched
      // secret box always submits empty.
      if (value) secrets[key] = value
    } else if (value) {
      plain[key] = value
    } else {
      delete plain[key]
    }
  }

  for (const key of clear) {
    delete plain[key]
    delete secrets[key]
  }

  const data = {
    ...(hasBindingsInput ? { contentBindings: bindings } : {}),
    ...(hasRuntimeInput ? { runtimeSettings: runtime.values } : {}),
    secretValues: Object.keys(secrets).length ? JSON.stringify(secrets) : null,
    themePackage: pkg.id,
    values: plain,
  }

  /**
   * One document per site (`isGlobal` in the multi-tenant plugin), so a site that
   * moved to another theme overwrites its previous package's answers — the ones a
   * different manifest asked for are meaningless to this one.
   *
   * `overrideAccess` because the collection's own create/update are platform-only:
   * the raw collection would let a customer name any package and write any key, and
   * this function is the validation that makes the write safe.
   */
  const { docs } = await req.payload.find({
    collection: 'site-theme-settings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { site: { equals: siteId } },
  })

  if (docs[0]) {
    await req.payload.update({
      collection: 'site-theme-settings',
      data,
      depth: 0,
      id: String((docs[0] as { id: unknown }).id),
      overrideAccess: true,
      req,
    })
  } else {
    await req.payload.create({
      collection: 'site-theme-settings',
      data: { ...data, site: siteId },
      depth: 0,
      overrideAccess: true,
      req,
    })
  }

  return { ok: true }
}
