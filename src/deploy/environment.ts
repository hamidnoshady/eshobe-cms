import type { PayloadRequest } from 'payload'

import { contractVersion } from '@eshobe/site-runtime'

import { DEPLOY_SECRET_READ_CONTEXT_KEY, readThemeSettingSecrets } from '@/collections/hooks/deploySecrets'
import { validateTenantEnv, type ThemeManifest } from '@/lib/deploy/manifest'

/**
 * Everything a deployed theme needs to know, assembled in one place.
 *
 * ## The split this file exists to enforce
 *
 * A theme's environment has two halves and they have different owners. The
 * **platform** half is computed here from the site's own record — the CMS URL, the
 * domain, the locales, the minted API key. The **tenant** half is whatever the
 * customer typed into the manifest-generated form. They are assembled together and
 * never merge their authority: `buildEnvironment` writes the platform values *last*,
 * so a tenant value named `ESHOBE_API_KEY` cannot win even if `validateTenantEnv`'s
 * refusal were ever removed. Two independent barriers, because one of them is a
 * validation function and validation functions get relaxed.
 *
 * ## Why `ESHOBE_CMS_URL` and not a per-theme guess
 *
 * A theme fetches content from somewhere. Letting it hardcode a URL means a
 * deployment cannot be moved, and letting the *tenant* supply it means a customer can
 * point their own storefront at a server that collects their buyers' checkout
 * details. It comes from the deployment's own configuration, always.
 */

export type EnvVariable = { isBuildTime?: boolean; key: string; value: string }

export type EnvironmentInput = {
  apiKey: null | string
  manifest: ThemeManifest
  req: PayloadRequest
  revalidateSecret: string
  site: Record<string, unknown>
  /** The deployment's public origin host — the preview subdomain, or the customer's own domain in `edge`/`direct`. */
  serviceDomain: string
  themePackageId: string
}

export type EnvironmentResult = {
  errors: string[]
  variables: EnvVariable[]
}

/**
 * The control plane's own public origin.
 *
 * `NEXT_PUBLIC_SERVER_URL` is what every other part of this codebase treats as "where
 * this deployment answers" (`getServerSideURL`), so a theme reading content is
 * pointed at the same place the admin's own links are.
 */
const cmsOrigin = (): string =>
  (process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

/** The site's store currency, if it has a store. A theme renders prices; it must not guess the unit. */
const currencyFor = async (req: PayloadRequest, siteId: string): Promise<null | string> => {
  const { docs } = await req.payload.find({
    collection: 'store',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { site: { equals: siteId } },
  })
  const currency = (docs[0] as undefined | { currency?: unknown })?.currency
  return currency ? String(currency) : null
}

export type StoredTenantValues = { plain: Record<string, string>; secrets: Record<string, string> }

/**
 * The customer's stored answers for this (site, package) pair — plaintext and
 * decrypted secrets, kept apart so a caller that must not show a secret cannot
 * mistake one for the other.
 *
 * The only reader of `secretValues` besides the save path: it sets the context flag
 * the masking hook checks, exactly as `readDeployTargetToken` does for Coolify tokens.
 */
export const storedTenantValues = async (
  req: PayloadRequest,
  siteId: string,
  themePackageId: string,
): Promise<StoredTenantValues & { id: null | string }> => {
  req.context[DEPLOY_SECRET_READ_CONTEXT_KEY] = true
  let row: undefined | Record<string, unknown>
  try {
    const { docs } = await req.payload.find({
      collection: 'site-theme-settings',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [{ site: { equals: siteId } }, { themePackage: { equals: themePackageId } }],
      },
    })
    row = docs[0] as unknown as undefined | Record<string, unknown>
  } finally {
    delete req.context[DEPLOY_SECRET_READ_CONTEXT_KEY]
  }

  if (!row) return { id: null, plain: {}, secrets: {} }

  const plain =
    row.values && typeof row.values === 'object' && !Array.isArray(row.values)
      ? Object.fromEntries(
          Object.entries(row.values as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value ?? ''),
          ]),
        )
      : {}

  return { id: String(row.id), plain, secrets: readThemeSettingSecrets(row.secretValues) }
}

/** Plaintext and secret answers merged — the shape the build environment consumes. */
export const tenantValuesFor = async (
  req: PayloadRequest,
  siteId: string,
  themePackageId: string,
): Promise<Record<string, string>> => {
  const { plain, secrets } = await storedTenantValues(req, siteId, themePackageId)
  return { ...plain, ...secrets }
}

export const buildEnvironment = async (input: EnvironmentInput): Promise<EnvironmentResult> => {
  const { apiKey, manifest, req, revalidateSecret, site, serviceDomain, themePackageId } = input
  const siteId = String(site.id)

  // Only what this version of the manifest still declares. A variable a theme update
  // removed is not the customer's mistake, and refusing the deploy over it would make
  // every upgrade that drops a variable fail until somebody cleaned the settings.
  const declared = new Set(manifest.env.filter((v) => v.source === 'tenant').map((v) => v.key))
  const tenantRaw = Object.fromEntries(
    Object.entries(await tenantValuesFor(req, siteId, themePackageId)).filter(([key]) => declared.has(key)),
  )
  const { errors, values: tenant } = validateTenantEnv(manifest, tenantRaw)

  const locales = Array.isArray(site.availableLocales)
    ? (site.availableLocales as unknown[]).map(String)
    : ['fa']
  const currency = await currencyFor(req, siteId)

  /**
   * Platform values, written after the tenant's so they cannot be shadowed. The
   * ordering is the barrier; `validateTenantEnv` refusing `PLATFORM_ENV_KEYS` is the
   * other one, and both are deliberate.
   */
  const platform: EnvVariable[] = [
    { key: 'ESHOBE_CMS_URL', value: cmsOrigin() },
    { key: 'ESHOBE_SITE_DOMAIN', value: String(site.domain ?? '') },
    { key: 'ESHOBE_SITE_ID', value: siteId },
    { key: 'ESHOBE_SITE_TYPE', value: String(site.type ?? 'business') },
    { key: 'ESHOBE_DEFAULT_LOCALE', value: String(site.defaultLocale ?? 'fa') },
    { key: 'ESHOBE_LOCALES', value: locales.join(',') },
    { key: 'ESHOBE_CONTRACT_VERSION', value: String(contractVersion) },
    /**
     * The origin the theme's own code should use for links it emits — the hostname it
     * is actually reachable at, which on a preview deployment is *not* the site's
     * canonical domain. A theme that builds absolute URLs from `ESHOBE_SITE_DOMAIN`
     * while running on a preview host emits links nobody can follow.
     */
    { key: 'ESHOBE_PUBLIC_ORIGIN', value: `https://${serviceDomain}` },
  ]

  if (currency) platform.push({ key: 'ESHOBE_CURRENCY', value: currency })

  // Runtime-only, both of them: a secret baked into a build layer is a secret in an
  // image that outlives the credential's rotation.
  if (apiKey) platform.push({ isBuildTime: false, key: 'ESHOBE_API_KEY', value: apiKey })
  platform.push({ isBuildTime: false, key: 'ESHOBE_REVALIDATE_SECRET', value: revalidateSecret })

  const secretKeys = new Set(manifest.env.filter((v) => v.secret).map((v) => v.key))

  const variables: EnvVariable[] = [
    ...Object.entries(tenant).map(([key, value]) => ({
      isBuildTime: !secretKeys.has(key),
      key,
      value,
    })),
    ...platform,
  ]

  return { errors, variables }
}
