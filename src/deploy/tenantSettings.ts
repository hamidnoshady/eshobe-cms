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
  type RuntimeSettingValue,
  type ThemeManifest,
} from '@/lib/deploy/manifest'
import { isProductionMode } from '@/lib/deploy/status'
import {
  splitStoredRuntimeSettings,
  THEME_SETTINGS_CONVERTER_VERSION,
  type RuntimeSettingsMeta,
} from '@/lib/deploy/theme-settings'
import { previewHttpsUrl } from '@/lib/deploy/previewUrl'

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
  previewUrl: null | string
  siteLocales: string[]
  variables: ManifestEnvVar[]
}> => {
  if (!isUuid(siteId)) return null

  const site = (await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: siteId,
    overrideAccess: true,
    req,
  })) as unknown as null | Record<string, unknown>

  const assignedId = site ? idOf(site.assignedThemePackage) : null

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
  const packageId = assignedId ?? (row ? idOf(row.themePackage) : null)
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

  /**
   * The «پیش‌نمایش» frame shows the build that is already running, never an unsaved
   * draft. A live deployment's own hostname is the honest target: it is the theme's
   * renderer on this site, and it is reached over the scheme the deploy pipeline set
   * up. `manifest.previewUrl` is the catalogue/demo fallback for a theme with no live
   * deployment yet.
   */
  const liveHost = rows.find((doc) => doc.status === 'live' && isProductionMode(doc.domainMode))?.domain
  const previewHost = rows.find((doc) => doc.status === 'live')?.domain

  return {
    id: String(pkg.id),
    key: String(pkg.key ?? ''),
    manifest,
    name: String(pkg.name ?? manifest.nameFa ?? manifest.name),
    previewUrl:
      previewHttpsUrl(typeof liveHost === 'string' ? liveHost : String(previewHost ?? '')) ??
      manifest.previewUrl,
    siteLocales: Array.isArray(site?.availableLocales)
      ? (site!.availableLocales as unknown[]).map(String).filter(Boolean)
      : [],
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
  /** Stored values the current manifest no longer declares — preserved, never rendered. */
  legacyRuntimeKeys: string[]
  legacyRuntimeSettings: Record<string, unknown>
  package: null | { id: string; key: string; name: string }
  /** The theme's already-deployed preview, or its catalogue demo link. */
  previewUrl: null | string
  runtimeDefaults: Record<string, RuntimeSettingValue>
  runtimeSchema: ManifestRuntimeSetting[]
  runtimeSettings: Record<string, RuntimeSettingValue>
  runtimeSettingsMeta: null | RuntimeSettingsMeta
  siteLocales: string[]
}

const LEGACY_RUNTIME_META = THEME_SETTINGS_CONVERTER_VERSION

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Split a stored blob into values the current manifest can still use and values that
 * must be preserved untouched.
 *
 * Shape is not enough: a number inside the declared bounds is valid, a number outside
 * them is not, and turning the latter into "absent" would silently fall back to the
 * theme default. It is preserved instead, so a rollback to the old manifest still
 * finds it.
 */
const partitionRuntime = (
  manifest: ThemeManifest,
  stored: unknown,
): { legacy: Record<string, unknown>; legacyDeclaredKeys: string[]; runtime: Record<string, RuntimeSettingValue> } => {
  const split = splitStoredRuntimeSettings(manifest.settings, stored)
  const runtime: Record<string, RuntimeSettingValue> = {}
  const legacy = { ...split.legacy }
  const legacyDeclaredKeys = [...split.legacyDeclaredKeys]
  for (const [key, value] of Object.entries(split.runtime)) {
    const checked = validateRuntimeSettings(manifest, { [key]: value }, { applyDefaults: false })
    if (checked.errors.length) {
      legacy[key] = value
      legacyDeclaredKeys.push(key)
      continue
    }
    runtime[key] = checked.values[key]!
  }
  return { legacy, legacyDeclaredKeys, runtime }
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
      legacyRuntimeKeys: [],
      legacyRuntimeSettings: {},
      package: null,
      previewUrl: null,
      runtimeDefaults: {},
      runtimeSchema: [],
      runtimeSettings: {},
      runtimeSettingsMeta: null,
      siteLocales: [],
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
  const rawRuntime = isPlainObject(row.runtimeSettings) ? row.runtimeSettings : {}
  const partition = partitionRuntime(pkg.manifest, rawRuntime)
  const preserved = isPlainObject(row.legacyRuntimeSettings) ? row.legacyRuntimeSettings : {}

  /**
   * Only the slots the *current* manifest declares. A site that moved from another
   * theme keeps that theme's keys in the row (`homePage`, `aboutPage`, …) until the next
   * save; handing them to the form made it resubmit them, and the save refused every one
   * as «نگاشت نامعتبر» — a form that could never be saved after a theme change.
   */
  const declaredSlots = new Set(pkg.manifest.contentSlots.map((slot) => slot.key))
  const storedBindings = isPlainObject(row.contentBindings) ? row.contentBindings : {}

  const runtimeDefaults: Record<string, RuntimeSettingValue> = {}
  for (const setting of pkg.manifest.settings) {
    if (setting.default !== undefined) {
      runtimeDefaults[setting.key] = setting.default as RuntimeSettingValue
    }
  }

  return {
    bindings: Object.fromEntries(
      Object.entries(storedBindings).filter(([key]) => declaredSlots.has(key)),
    ),
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
    legacyRuntimeKeys: [
      ...new Set([
        ...partition.legacyDeclaredKeys,
        ...Object.keys(partition.legacy),
        ...Object.keys(preserved),
      ]),
    ].sort(),
    legacyRuntimeSettings: { ...partition.legacy, ...preserved },
    package: { id: pkg.id, key: pkg.key, name: pkg.name },
    previewUrl: pkg.previewUrl,
    runtimeDefaults,
    runtimeSchema: pkg.manifest.settings,
    runtimeSettings: partition.runtime,
    runtimeSettingsMeta: isPlainObject(row.runtimeSettingsMeta)
      ? (row.runtimeSettingsMeta as unknown as RuntimeSettingsMeta)
      : null,
    siteLocales: pkg.siteLocales,
  }
}

/** The site's one `site-theme-settings` row (`isGlobal` in the multi-tenant plugin), if any. */
const settingsRowFor = async (
  req: PayloadRequest,
  siteId: string,
): Promise<null | Record<string, unknown>> => {
  const { docs } = await req.payload.find({
    collection: 'site-theme-settings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { site: { equals: siteId } },
  })
  return (docs[0] as unknown as Record<string, unknown> | undefined) ?? null
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
 *
 * ## What happens to a value the new manifest cannot use
 *
 * It is moved to `legacyRuntimeSettings`, verbatim, and recorded in
 * `runtimeSettingsMeta`. The alternative — dropping it because the current manifest
 * does not declare it — is how a theme upgrade erases a customer's old typography
 * with no way back. Saving a value for that key is the explicit opt-in that clears
 * the preserved copy; nothing converts a percent to px on the customer's behalf.
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

  const submitted = isPlainObject(input.values) ? input.values : {}
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : []
  const hasRuntimeInput = input.runtimeSettings !== undefined
  const runtimeInput = isPlainObject(input.runtimeSettings) ? input.runtimeSettings : {}

  const existing = await settingsRowFor(req, siteId)
  const storedRuntime = existing?.runtimeSettings
  const partition = partitionRuntime(pkg.manifest, storedRuntime)
  const storedLegacy = isPlainObject(existing?.legacyRuntimeSettings)
    ? existing.legacyRuntimeSettings
    : {}

  /**
   * A save names only the options it shows: «طراحی سایت» sends the `design` group and
   * «تنظیمات پوسته» the `general` one. Each starts from what is stored (still-declared
   * keys only, so a previous theme's leftovers cannot fail the save), or saving one page
   * would put every option on the other back to its default.
   */
  const runtime = validateRuntimeSettings(pkg.manifest, runtimeInput, { applyDefaults: false })
  if (hasRuntimeInput) errors.push(...runtime.errors)
  const mergedRuntime: Record<string, RuntimeSettingValue> = {
    ...partition.runtime,
    ...runtime.values,
  }

  const hasBindingsInput = input.bindings !== undefined
  const bindingsInput = isPlainObject(input.bindings) ? input.bindings : {}
  const slots = new Map(pkg.manifest.contentSlots.map((slot) => [slot.key, slot]))
  const bindings: Record<string, { id: string; type: string }> = {}
  for (const [key, raw] of Object.entries(bindingsInput)) {
    const slot = slots.get(key)
    const id =
      raw && typeof raw === 'object' ? idOf((raw as Record<string, unknown>).id) : idOf(raw)
    if (!slot) {
      errors.push(`بخش «${key}» در پوستهٔ فعلی تعریف نشده است.`)
      continue
    }
    if (!id || !isUuid(id)) {
      errors.push(`نگاشت «${slot.labelFa ?? key}» نامعتبر است.`)
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

  // Preserved values from a previous manifest/package stay preserved, except a key the
  // customer has just saved explicitly — that save is the opt-in.
  const legacyRuntime: Record<string, unknown> = {
    ...partition.legacy,
    ...storedLegacy,
  }
  for (const key of Object.keys(runtime.values)) delete legacyRuntime[key]

  const data = {
    ...(hasBindingsInput ? { contentBindings: bindings } : {}),
    ...(hasRuntimeInput
      ? {
          legacyRuntimeSettings: Object.keys(legacyRuntime).length ? legacyRuntime : null,
          runtimeSettings: mergedRuntime,
          runtimeSettingsMeta: {
            adoptedKeys: Object.keys(runtime.values).sort(),
            packageId: pkg.id,
            preservedLegacyKeys: Object.keys(legacyRuntime).sort(),
            updatedAt: new Date().toISOString(),
            version: LEGACY_RUNTIME_META,
          } satisfies RuntimeSettingsMeta,
        }
      : {}),
    secretValues: Object.keys(secrets).length ? JSON.stringify(secrets) : null,
    themePackage: pkg.id,
    values: plain,
  }

  /**
   * One document per site (`isGlobal` in the multi-tenant plugin), so a site that
   * moved to another theme overwrites its previous package's answers — the ones a
   * different manifest asked for are meaningless to this one. The preserved map is
   * what keeps the *values* while their package's answers move on.
   *
   * `overrideAccess` because the collection's own create/update are platform-only:
   * the raw collection would let a customer name any package and write any key, and
   * this function is the validation that makes the write safe.
   */
  if (existing) {
    await req.payload.update({
      collection: 'site-theme-settings',
      data,
      depth: 0,
      id: String(existing.id),
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
