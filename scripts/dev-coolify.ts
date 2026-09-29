/**
 * Local Coolify wiring: `pnpm dev:coolify`.
 *
 * Gets a developer machine from "Coolify is running in Docker Desktop" to "the CMS
 * can deploy the Graphite theme through it":
 *
 *   1. two Coolify projects (preview / production) — created over Coolify's own API;
 *   2. a `deploy-targets` row holding the (encrypted) API token and those placements;
 *   3. the Graphite `theme-packages` row, synced from GitHub and published;
 *   4. the GHCR image the package's main branch built, registered as an artifact
 *      through the same signed callback CI uses;
 *   5. the package assigned to `studio.localhost`.
 *
 * Idempotent. Reads the token from `COOLIFY_TOKEN_FILE` (default
 * `../coolify-local/api-token.txt`) — never from argv, so it stays out of shell history.
 *
 * Requires the CMS to be running (step 4 is an HTTP call to it) with
 * `ESHOBE_THEME_ARTIFACT_SECRET` set, and `DEPLOY_PUBLIC_SCHEME=http` /
 * `DEPLOY_CMS_URL` for a local proxy with no certificates (see `.env.example`).
 */
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { syncThemePackage } from '@/deploy/themePackageSync'

const COOLIFY = process.env.COOLIFY_URL ?? 'http://localhost:8000'
const CMS = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000'
const REPO = process.env.THEME_REPOSITORY ?? 'hamidnoshady/arch-theme-cms'
const IMAGE = `ghcr.io/${REPO}`
const WILDCARD = process.env.PREVIEW_WILDCARD_DOMAIN ?? '127.0.0.1.sslip.io'
const SITE_DOMAIN = process.env.THEME_SITE_DOMAIN ?? 'studio.localhost'
const tokenFile = process.env.COOLIFY_TOKEN_FILE ?? resolve(process.cwd(), '../coolify-local/api-token.txt')
const token = readFileSync(tokenFile, 'utf8').trim()

const coolify = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${COOLIFY}/api/v1${path}`, {
    ...init,
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Coolify ${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const ensureProject = async (name: string): Promise<string> => {
  const all = await coolify<{ name: string; uuid: string }[]>('/projects')
  const found = all.find((p) => p.name === name)
  if (found) return found.uuid
  return (await coolify<{ uuid: string }>('/projects', { body: JSON.stringify({ name }), method: 'POST' })).uuid
}

const payload = await getPayload({ config })
const base = { context: { disableRevalidate: true }, depth: 0, overrideAccess: true } as const

// 1 — Coolify side
const servers = await coolify<{ is_coolify_host?: boolean; uuid: string }[]>('/servers')
const server = servers.find((s) => s.is_coolify_host) ?? servers[0]
if (!server) throw new Error('Coolify has no server')
const previewProject = await ensureProject('Eshobe Preview')
const productionProject = await ensureProject('Eshobe Production')

// 2 — the deploy target
const targetData = {
  active: true,
  apiToken: token,
  baseUrl: COOLIFY,
  defaultServerUuid: server.uuid,
  environmentName: 'production',
  key: 'local-coolify',
  name: 'Coolify محلی (Docker Desktop)',
  previewEnvironmentName: 'production',
  previewProjectUuid: previewProject,
  previewWildcardDomain: WILDCARD,
  productionEnvironmentName: 'production',
  productionProjectUuid: productionProject,
  provider: 'coolify' as const,
  publicGitEnabled: true,
  publicRegistryPullEnabled: true,
  serverUuid: server.uuid,
}
const existingTarget = await payload.find({ ...base, collection: 'deploy-targets', limit: 1, where: { key: { equals: 'local-coolify' } } })
const target = existingTarget.docs[0]
  ? await payload.update({ ...base, collection: 'deploy-targets', data: targetData as never, id: existingTarget.docs[0].id })
  : await payload.create({ ...base, collection: 'deploy-targets', data: targetData as never })

// 3 — the theme package
const packageData = {
  allowedDeploymentStrategies: ['registry_image'] as ('registry_image')[],
  defaultRef: 'main',
  defaultTarget: target.id,
  deploymentStrategy: 'registry_image' as const,
  key: 'graphite',
  name: 'Graphite',
  provider: 'github' as const,
  registryImageRepository: IMAGE,
  registryProvider: 'ghcr' as const,
  registryVisibility: 'public' as const,
  repository: REPO,
  visibility: 'public' as const,
}
const existingPkg = await payload.find({ ...base, collection: 'theme-packages', limit: 1, where: { key: { equals: 'graphite' } } })
let pkg = existingPkg.docs[0]
  ? await payload.update({ ...base, collection: 'theme-packages', data: packageData as never, id: existingPkg.docs[0].id })
  : await payload.create({ ...base, collection: 'theme-packages', data: packageData as never })

const req = await createLocalReq({}, payload)
const synced = await syncThemePackage(req, pkg as unknown as Record<string, unknown>, 'main')
if (!synced.ok) throw new Error(`sync failed: ${synced.errors.join(' | ')}`)
pkg = await payload.update({ ...base, collection: 'theme-packages', data: { status: 'published' }, id: pkg.id })

// 4 — register the image the main branch built (what CI would do)
const secret = process.env.ESHOBE_THEME_ARTIFACT_SECRET?.trim()
if (!secret) throw new Error('ESHOBE_THEME_ARTIFACT_SECRET is not set in .env')
const inspected = JSON.parse(
  execFileSync('docker', ['buildx', 'imagetools', 'inspect', `${IMAGE}:latest`, '--format', '{{json .}}'], { encoding: 'utf8' }),
) as { manifest: { digest: string }; image?: Record<string, { config?: { Labels?: Record<string, string> } }> }
const digest = inspected.manifest.digest
const labels = Object.values(inspected.image ?? {})[0]?.config?.Labels ?? {}
const commit = labels['org.opencontainers.image.revision'] ?? synced.commit
if (!commit) throw new Error('cannot tell which commit the image was built from')

const body = JSON.stringify({
  commit,
  digest,
  image: IMAGE,
  platform: 'linux/amd64',
  ref: 'main',
  registry: 'ghcr',
  repository: REPO,
  tag: commit,
})
const signature = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
const registered = await fetch(`${CMS}/api/platform/theme-packages/${pkg.id}/artifacts`, {
  body,
  headers: { 'content-type': 'application/json', 'x-eshobe-signature-256': signature },
  method: 'POST',
})
if (!registered.ok) throw new Error(`artifact registration → ${registered.status} ${await registered.text()}`)

// 5 — assign to the site
const site = (await payload.find({ ...base, collection: 'sites', limit: 1, where: { domain: { equals: SITE_DOMAIN } } })).docs[0]
if (!site) throw new Error(`no site for ${SITE_DOMAIN}`)
// `domainVerified` is a DNS check in production; on a developer machine `*.localhost`
// resolves to this host by definition, so the operator's answer is simply "yes".
await payload.update({
  ...base,
  collection: 'sites',
  data: { assignedThemePackage: pkg.id, domainVerified: true } as never,
  id: site.id,
})

// 6 — the customer's half of the checklist: which pages/categories fill the theme's slots
// (`pnpm seed:demo` writes them, by slug).
const bySlug = async (collection: 'categories' | 'pages', slug: string) =>
  (await payload.find({ ...base, collection, limit: 1, locale: 'fa', where: { and: [{ site: { equals: site.id } }, { slug: { equals: slug } }] } })).docs[0]?.id
const slots: Record<string, ['category' | 'page', 'categories' | 'pages', string]> = {
  aboutPage: ['page', 'pages', 'about'],
  contactPage: ['page', 'pages', 'contact'],
  educationCategory: ['category', 'categories', 'education'],
  homePage: ['page', 'pages', 'home'],
  projectsCategory: ['category', 'categories', 'projects'],
  servicesPage: ['page', 'pages', 'services'],
}
const contentBindings: Record<string, { id: string; type: string }> = {}
for (const [slot, [type, collection, slug]] of Object.entries(slots)) {
  const id = await bySlug(collection, slug)
  if (id) contentBindings[slot] = { id: String(id), type }
  else payload.logger.warn(`no ${type} with slug "${slug}" for slot ${slot} — run \`pnpm seed:demo\` first`)
}
const settings = await payload.find({ ...base, collection: 'site-theme-settings', limit: 1, where: { site: { equals: site.id } } })
const settingsData = { contentBindings, site: site.id, themePackage: pkg.id }
if (settings.docs[0]) await payload.update({ ...base, collection: 'site-theme-settings', data: settingsData as never, id: settings.docs[0].id })
else await payload.create({ ...base, collection: 'site-theme-settings', data: settingsData as never })

payload.logger.info(
  `local Coolify ready: target=${target.id} package=${pkg.id} commit=${commit.slice(0, 7)} digest=${digest.slice(0, 19)}… site=${site.id}`,
)
process.exit(0)
