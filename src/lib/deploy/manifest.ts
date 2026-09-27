/**
 * `eshobe.theme.json` — how a theme repository describes itself.
 *
 * A theme built against `docs/THEME_API.md` lives in its own GitHub repository and
 * is a *program*: a build, a port, a health path, a set of environment variables.
 * The operator must not have to retype any of that into a form, because a build
 * command typed twice is a build command that is wrong once. So the repo carries a
 * manifest at its root and the CMS reads it.
 *
 * Framework-free on purpose — no `payload` import — like `src/lib/slug.ts` and
 * `src/lib/money.ts`. The collection hook, the endpoint and the deploy job all parse
 * with the same function, and the unit spec parses without a database.
 *
 * ## The two rules that make this safe
 *
 * 1. **Everything is an allowlist.** `buildPack`, the env `source`, the site types —
 *    all closed sets. An unknown value is a rejection with a Persian reason, never a
 *    passthrough. This string arrives from a third-party repository; treating it as
 *    configuration the platform will execute means every field is attacker input.
 * 2. **`contractVersion` is enforced here, not documented elsewhere.** `GET /api/site`
 *    promises "bump = breaking change". A theme declaring a contract this deployment
 *    does not implement is refused at registration, which is the only moment the
 *    refusal is cheap.
 */

/** Build strategies this platform knows how to ask Coolify for. Closed, for the reason every registry here is closed. */
export const BUILD_PACKS = ['nixpacks', 'dockerfile', 'static', 'dockercompose'] as const
export type BuildPack = (typeof BUILD_PACKS)[number]

/** The same three the `sites.type` enum carries. A theme claiming a fourth names a site that cannot exist. */
export const THEME_SITE_TYPES = ['business', 'portfolio', 'store'] as const
export type ThemeSiteType = (typeof THEME_SITE_TYPES)[number]

/**
 * Who supplies an environment variable's value.
 *
 * `platform` — the CMS writes it (CMS URL, the site's domain, the minted API key).
 * A theme may *declare* it so the operator can see what the theme reads, but the
 * value is never taken from the manifest.
 *
 * `tenant` — the customer answers it in a generated form. This is the only free text
 * that reaches a build environment, which is why §4 of the validator caps it.
 */
export const ENV_SOURCES = ['platform', 'tenant'] as const
export type EnvSource = (typeof ENV_SOURCES)[number]

/**
 * The variables the platform writes itself, whatever a manifest says.
 *
 * A manifest declaring one of these with `source: "tenant"` is refused: it is an
 * attempt to have the customer (or the theme author) choose the value of the CMS
 * URL or the API key the theme authenticates with.
 */
export const PLATFORM_ENV_KEYS = [
  'ESHOBE_CMS_URL',
  'ESHOBE_SITE_DOMAIN',
  'ESHOBE_SITE_ID',
  'ESHOBE_API_KEY',
  'ESHOBE_DEFAULT_LOCALE',
  'ESHOBE_LOCALES',
  'ESHOBE_SITE_TYPE',
  'ESHOBE_CURRENCY',
  'ESHOBE_REVALIDATE_SECRET',
  'ESHOBE_CONTRACT_VERSION',
  // Injected by `buildEnvironment` from the domain the deployment is actually
  // reachable at, which in preview mode is not the site's canonical domain. It belongs
  // here for the same reason as the rest: a theme that declares it as a tenant
  // question would show the customer a box whose answer is silently overwritten.
  'ESHOBE_PUBLIC_ORIGIN',
] as const

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/** A tenant's answer is a build-environment value. Long enough for a real token, short enough not to be a payload. */
export const MAX_ENV_VALUE_LENGTH = 2048

/** A manifest is a config file. Anything larger is not one, and should cost one rejected read. */
export const MAX_MANIFEST_BYTES = 64 * 1024

export type ManifestEnvVar = {
  help?: null | string
  key: string
  labelFa?: null | string
  required: boolean
  secret: boolean
  source: EnvSource
}

export const RUNTIME_SETTING_TYPES = ['boolean', 'text', 'number', 'select'] as const
export type RuntimeSettingType = (typeof RUNTIME_SETTING_TYPES)[number]
export type ManifestRuntimeSetting = {
  default?: boolean | number | string
  help?: null | string
  key: string
  labelEn?: null | string
  labelFa?: null | string
  max?: number
  min?: number
  options?: { labelEn?: null | string; labelFa?: null | string; value: string }[]
  type: RuntimeSettingType
}

export const CONTENT_SLOT_TYPES = ['page', 'post', 'category', 'form', 'media'] as const
export type ContentSlotType = (typeof CONTENT_SLOT_TYPES)[number]
export type ManifestContentSlot = {
  help?: null | string
  key: string
  labelEn?: null | string
  labelFa?: null | string
  required: boolean
  type: ContentSlotType
}

export type ManifestBuild = {
  baseDirectory: string
  buildCommand: null | string
  buildPack: BuildPack
  dockerfileLocation: null | string
  healthCheckPath: null | string
  installCommand: null | string
  isStatic: boolean
  port: number
  publishDirectory: null | string
  startCommand: null | string
}

export type ThemeManifest = {
  build: ManifestBuild
  capabilities: Record<string, boolean>
  contractVersion: number
  env: ManifestEnvVar[]
  settings: ManifestRuntimeSetting[]
  contentSlots: ManifestContentSlot[]
  key: string
  locales: string[]
  name: string
  nameFa: null | string
  /** Does the theme proxy the reserved `/api/*` paths back to the CMS? Decides which domain modes it may use. */
  proxiesApi: boolean
  previewUrl: null | string
  siteTypes: ThemeSiteType[]
}

const SCHEMA_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/

const parseSettings = (raw: unknown, errors: string[]): ManifestRuntimeSetting[] => {
  if (raw == null) return []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('«settings» باید یک شیء باشد.')
    return []
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 50) errors.push('«settings» نباید بیش از ۵۰ گزینه داشته باشد.')
  const out: ManifestRuntimeSetting[] = []
  for (const [key, value] of entries.slice(0, 50)) {
    if (
      !SCHEMA_KEY_PATTERN.test(key) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      errors.push(`گزینهٔ پوستهٔ «${key}» نامعتبر است.`)
      continue
    }
    const row = value as Record<string, unknown>
    const type = str(row.type)
    if (!type || !(RUNTIME_SETTING_TYPES as readonly string[]).includes(type)) {
      errors.push(`نوع settings.${key} باید یکی از ${RUNTIME_SETTING_TYPES.join('، ')} باشد.`)
      continue
    }
    let options: ManifestRuntimeSetting['options']
    if (type === 'select') {
      if (!Array.isArray(row.options) || !row.options.length || row.options.length > 50) {
        errors.push(`settings.${key}.options برای select الزامی است.`)
        continue
      }
      options = row.options.flatMap((option) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return []
        const item = option as Record<string, unknown>
        const optionValue = str(item.value)
        return optionValue && optionValue.length <= 100
          ? [{ labelEn: str(item.labelEn), labelFa: str(item.labelFa), value: optionValue }]
          : []
      })
      if (options.length !== row.options.length) errors.push(`settings.${key}.options نامعتبر است.`)
    }
    const defaultValue = row.default
    const validDefault =
      defaultValue === undefined ||
      (type === 'boolean' && typeof defaultValue === 'boolean') ||
      (type === 'number' && typeof defaultValue === 'number' && Number.isFinite(defaultValue)) ||
      ((type === 'text' || type === 'select') && typeof defaultValue === 'string')
    if (
      !validDefault ||
      (type === 'select' &&
        defaultValue !== undefined &&
        !options?.some((o) => o.value === defaultValue))
    ) {
      errors.push(`settings.${key}.default با نوع آن سازگار نیست.`)
      continue
    }
    out.push({
      default: defaultValue as boolean | number | string | undefined,
      help: str(row.help),
      key,
      labelEn: str(row.labelEn),
      labelFa: str(row.labelFa),
      max: typeof row.max === 'number' ? row.max : undefined,
      min: typeof row.min === 'number' ? row.min : undefined,
      options,
      type: type as RuntimeSettingType,
    })
  }
  return out
}

const parseContentSlots = (raw: unknown, errors: string[]): ManifestContentSlot[] => {
  if (raw == null) return []
  if (!Array.isArray(raw) || raw.length > 50) {
    errors.push('«contentSlots» باید آرایه‌ای حداکثر ۵۰ عضوی باشد.')
    return []
  }
  const seen = new Set<string>()
  return raw.flatMap((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`contentSlots[${index}] نامعتبر است.`)
      return []
    }
    const row = value as Record<string, unknown>
    const key = str(row.key)
    const type = str(row.type)
    if (
      !key ||
      !SCHEMA_KEY_PATTERN.test(key) ||
      seen.has(key) ||
      !type ||
      !(CONTENT_SLOT_TYPES as readonly string[]).includes(type)
    ) {
      errors.push(`contentSlots[${index}] کلید تکراری یا نوع/کلید نامعتبر دارد.`)
      return []
    }
    seen.add(key)
    return [
      {
        help: str(row.help),
        key,
        labelEn: str(row.labelEn),
        labelFa: str(row.labelFa),
        required: bool(row.required, false),
        type: type as ContentSlotType,
      },
    ]
  })
}

export type ManifestParse = { manifest: ThemeManifest; ok: true } | { errors: string[]; ok: false }

const str = (value: unknown): null | string => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

/**
 * Slug rules shared with `slugKey` in `src/lib/saas/plans.ts`, restated rather than
 * imported: this module must stay free of the SaaS layer so the manifest parser can
 * be used from the `@eshobe/site-runtime` side of the contract later.
 */
export const manifestKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const parseEnv = (raw: unknown, errors: string[]): ManifestEnvVar[] => {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push('«env» باید یک آرایه باشد.')
    return []
  }
  if (raw.length > 50) {
    errors.push('«env» بیش از ۵۰ متغیر دارد؛ این یک پوستهٔ وب‌سایت نیست.')
    return []
  }

  const seen = new Set<string>()
  const out: ManifestEnvVar[] = []

  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`«env[${index}]» باید یک شیء باشد.`)
      continue
    }
    const row = entry as Record<string, unknown>
    const key = str(row.key)

    if (!key || !ENV_KEY_PATTERN.test(key)) {
      errors.push(`«env[${index}].key» باید حروف بزرگ انگلیسی، رقم و زیرخط باشد — مثل MAP_API_KEY.`)
      continue
    }
    if (seen.has(key)) {
      errors.push(`متغیر «${key}» دوبار تعریف شده است.`)
      continue
    }
    seen.add(key)

    const sourceRaw = str(row.source) ?? 'tenant'
    if (!(ENV_SOURCES as readonly string[]).includes(sourceRaw)) {
      errors.push(`«env.${key}.source» باید یکی از ${ENV_SOURCES.join('، ')} باشد.`)
      continue
    }
    const source = sourceRaw as EnvSource

    // The refusal that matters: a theme must not be able to nominate the customer
    // (or itself) as the author of the CMS URL or the key it authenticates with.
    if (source === 'tenant' && (PLATFORM_ENV_KEYS as readonly string[]).includes(key)) {
      errors.push(`«${key}» را سکو مقداردهی می‌کند؛ نمی‌تواند source: "tenant" باشد.`)
      continue
    }

    out.push({
      help: str(row.help),
      key,
      labelFa: str(row.labelFa),
      required: bool(row.required, false),
      secret: bool(row.secret, false),
      source,
    })
  }

  return out
}

const parseBuild = (raw: unknown, errors: string[]): ManifestBuild => {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const packRaw = str(row.pack) ?? str(row.buildPack) ?? 'nixpacks'
  if (!(BUILD_PACKS as readonly string[]).includes(packRaw)) {
    errors.push(`«build.pack» باید یکی از ${BUILD_PACKS.join('، ')} باشد.`)
  }

  const portRaw = row.port ?? 3000
  const port = typeof portRaw === 'number' ? portRaw : Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('«build.port» باید یک عدد بین ۱ تا ۶۵۵۳۵ باشد.')
  }

  const healthCheckPath = str(row.healthCheckPath)
  if (healthCheckPath && !healthCheckPath.startsWith('/')) {
    errors.push('«build.healthCheckPath» باید با / شروع شود.')
  }

  const baseDirectory = str(row.baseDirectory) ?? '/'
  if (!baseDirectory.startsWith('/')) {
    errors.push('«build.baseDirectory» باید با / شروع شود.')
  }

  return {
    baseDirectory,
    buildCommand: str(row.buildCommand),
    buildPack: ((BUILD_PACKS as readonly string[]).includes(packRaw)
      ? packRaw
      : 'nixpacks') as BuildPack,
    dockerfileLocation: str(row.dockerfileLocation),
    healthCheckPath,
    installCommand: str(row.installCommand),
    isStatic: bool(row.isStatic, packRaw === 'static'),
    port: Number.isInteger(port) ? port : 3000,
    publishDirectory: str(row.publishDirectory),
    startCommand: str(row.startCommand),
  }
}

/**
 * Parse and validate a manifest object.
 *
 * `platformContractVersion` is `contractVersion` from `@eshobe/site-runtime` — passed
 * in rather than imported so this file stays dependency-free and the spec can drive
 * both sides of the comparison.
 */
export const parseThemeManifest = (
  input: unknown,
  platformContractVersion: number,
): ManifestParse => {
  const errors: string[] = []

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['فایل eshobe.theme.json باید یک شیء JSON باشد.'], ok: false }
  }

  const row = input as Record<string, unknown>

  const name = str(row.name)
  if (!name) errors.push('«name» الزامی است.')

  const key = manifestKey(row.key ?? name)
  if (!key) errors.push('«key» الزامی است و باید با حروف انگلیسی نوشته شود.')

  const contractRaw = row.contractVersion
  const contractVersion = typeof contractRaw === 'number' ? contractRaw : Number(contractRaw)
  if (!Number.isInteger(contractVersion) || contractVersion < 1) {
    errors.push('«contractVersion» الزامی است و باید عدد صحیح باشد.')
  } else if (contractVersion > platformContractVersion) {
    // The whole point of the version existing. A theme written against a newer
    // contract will read fields this deployment does not emit, and the failure would
    // otherwise surface as a blank storefront on a customer's domain.
    errors.push(
      `این پوسته برای نسخهٔ قرارداد ${contractVersion} نوشته شده و این نصب نسخهٔ ${platformContractVersion} را ارائه می‌کند. ابتدا CMS را به‌روزرسانی کنید.`,
    )
  }

  const siteTypesRaw = row.siteTypes
  let siteTypes: ThemeSiteType[] = [...THEME_SITE_TYPES]
  if (siteTypesRaw !== undefined) {
    if (!Array.isArray(siteTypesRaw)) {
      errors.push('«siteTypes» باید آرایه باشد.')
    } else {
      const unknown = siteTypesRaw.filter(
        (value) => !(THEME_SITE_TYPES as readonly unknown[]).includes(value),
      )
      if (unknown.length) {
        errors.push(`نوع سایت ناشناخته: ${unknown.map(String).join('، ')}.`)
      }
      siteTypes = siteTypesRaw.filter((value): value is ThemeSiteType =>
        (THEME_SITE_TYPES as readonly unknown[]).includes(value),
      )
      if (!siteTypes.length) errors.push('«siteTypes» نباید خالی باشد.')
    }
  }

  const localesRaw = row.locales
  const locales =
    Array.isArray(localesRaw) && localesRaw.length
      ? localesRaw.map((value) => String(value).trim()).filter(Boolean)
      : ['fa']

  const capabilitiesRaw = row.capabilities
  const capabilities: Record<string, boolean> = {}
  if (capabilitiesRaw && typeof capabilitiesRaw === 'object' && !Array.isArray(capabilitiesRaw)) {
    for (const [name_, value] of Object.entries(capabilitiesRaw as Record<string, unknown>)) {
      capabilities[name_] = value === true
    }
  }

  const build = parseBuild(row.build, errors)
  const env = parseEnv(row.env, errors)
  const settings = parseSettings(row.settings, errors)
  const contentSlots = parseContentSlots(row.contentSlots, errors)

  const previewUrl = str(row.preview) ?? str(row.previewUrl)
  if (previewUrl && !/^https:\/\//i.test(previewUrl)) {
    errors.push('«preview» باید یک نشانی https باشد.')
  }

  if (errors.length) return { errors, ok: false }

  return {
    manifest: {
      build,
      capabilities,
      contractVersion,
      env,
      settings,
      contentSlots,
      key,
      locales,
      name: name!,
      nameFa: str(row.nameFa),
      previewUrl,
      proxiesApi: bool(row.proxiesApi, false),
      siteTypes,
    },
    ok: true,
  }
}

/** Parse from raw text, with the size cap applied before `JSON.parse` sees it. */
export const parseThemeManifestText = (
  text: string,
  platformContractVersion: number,
): ManifestParse => {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    return {
      errors: [`فایل eshobe.theme.json از ${MAX_MANIFEST_BYTES} بایت بزرگ‌تر است.`],
      ok: false,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      errors: [`eshobe.theme.json قابل خواندن نیست: ${(error as Error).message}`],
      ok: false,
    }
  }
  return parseThemeManifest(parsed, platformContractVersion)
}

/**
 * Validate a tenant's answers against the manifest's declared variables.
 *
 * Returns only declared `source: "tenant"` keys — an undeclared key is dropped, not
 * merely ignored, because "we passed through whatever the form sent" is how an
 * environment grows a variable nobody wrote down.
 */
export const validateTenantEnv = (
  manifest: ThemeManifest,
  values: Record<string, unknown>,
): { errors: string[]; values: Record<string, string> } => {
  const errors: string[] = []
  const declared = new Map(manifest.env.filter((v) => v.source === 'tenant').map((v) => [v.key, v]))
  const out: Record<string, string> = {}

  for (const [key, raw] of Object.entries(values ?? {})) {
    const spec = declared.get(key)
    if (!spec) {
      errors.push(`متغیر «${key}» در این پوسته تعریف نشده است.`)
      continue
    }
    const value =
      typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw)
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      errors.push(`مقدار «${key}» از ${MAX_ENV_VALUE_LENGTH} نویسه بلندتر است.`)
      continue
    }
    if (value) out[key] = value
  }

  for (const spec of declared.values()) {
    if (spec.required && !out[spec.key]) {
      errors.push(`مقدار «${spec.labelFa ?? spec.key}» الزامی است.`)
    }
  }

  return { errors, values: out }
}

/** Apply manifest defaults and reject every undeclared or wrongly typed editor-facing option. */
export const validateRuntimeSettings = (
  manifest: ThemeManifest,
  input: Record<string, unknown>,
): { errors: string[]; values: Record<string, boolean | number | string> } => {
  const errors: string[] = []
  const declared = new Map(manifest.settings.map((setting) => [setting.key, setting]))
  const values: Record<string, boolean | number | string> = {}
  for (const setting of manifest.settings)
    if (setting.default !== undefined) values[setting.key] = setting.default
  for (const [key, value] of Object.entries(input ?? {})) {
    const setting = declared.get(key)
    if (!setting) {
      errors.push(`گزینهٔ «${key}» در مانیفست پوسته تعریف نشده است.`)
      continue
    }
    const valid =
      setting.type === 'boolean'
        ? typeof value === 'boolean'
        : setting.type === 'number'
          ? typeof value === 'number' &&
            Number.isFinite(value) &&
            (setting.min === undefined || value >= setting.min) &&
            (setting.max === undefined || value <= setting.max)
          : typeof value === 'string' &&
            value.length <= 500 &&
            (setting.type !== 'select' ||
              Boolean(setting.options?.some((option) => option.value === value)))
    if (!valid) {
      errors.push(`مقدار گزینهٔ «${key}» نامعتبر است.`)
      continue
    }
    values[key] = value as boolean | number | string
  }
  return { errors, values }
}

/** `owner/name`, validated. A repository reference is the input to a clone; it is never free text. */
export const parseRepository = (value: unknown): null | { name: string; owner: string } => {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  // Accept a full URL and reduce it, so an operator pasting the browser address bar works.
  const cleaned = raw
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')

  const match = /^([A-Za-z0-9._-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned)
  if (!match) return null
  return { name: match[2]!, owner: match[1]! }
}

/** A git ref that is safe to hand to a clone: a branch, a tag, or a 40-hex sha. */
export const isSafeGitRef = (value: unknown): value is string => {
  const raw = String(value ?? '')
  if (!raw || raw.length > 100) return false
  if (raw.startsWith('-') || raw.includes('..') || raw.endsWith('/')) return false
  return /^[A-Za-z0-9._\-/]+$/.test(raw)
}
