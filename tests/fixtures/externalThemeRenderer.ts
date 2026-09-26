/**
 * Minimal consumer a generic external theme can copy: shape checks for `/api/site`
 * and signed revalidation payloads without importing any theme repository.
 */
import { createHmac } from 'node:crypto'

import { expect } from 'vitest'

import { contractVersion } from '@eshobe/site-runtime'

export type SiteDescriptor = {
  availableLocales: string[]
  blocks: string[]
  branding: {
    displayName: string
    primaryLogo: null | { id: string; url: null | string }
  }
  contractVersion: number
  defaultLocale: string
  domain: string
  domainVerified?: boolean
  id?: string
  media: { basePath: string; origin: string }
  name: string
  theme: null | Record<string, unknown>
  themeRuntime: null | {
    bindings: Record<string, null | { id: string; slug: null | string; type: string }>
    package: { key: null | string }
    settings: Record<string, unknown>
  }
  type: string
}

export const assertGenericSiteDescriptor = (body: unknown): SiteDescriptor => {
  const site = body as SiteDescriptor
  if (!site || typeof site !== 'object') throw new Error('descriptor must be an object')
  if (site.contractVersion !== contractVersion) {
    throw new Error(`contractVersion mismatch: ${String(site.contractVersion)}`)
  }
  if (!site.domain || !site.media?.origin) throw new Error('descriptor missing domain/media')
  if (!site.branding?.displayName) throw new Error('descriptor missing branding.displayName')
  return site
}

export const verifyRendererRevalidation = (secret: string, rawBody: string, signature: string) => {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`
  return signature === expected
}

/** Minimal shape checks for headless collection rows a theme typically consumes. */
export const assertHostScopedDocs = (
  docs: { site?: unknown }[],
  expectedSiteId: string,
): void => {
  const sites = new Set(docs.map((doc) => String((doc.site as { id?: string })?.id ?? doc.site)))
  expect(sites.size).toBeLessThanOrEqual(1)
  if (docs.length) expect(sites).toEqual(new Set([expectedSiteId]))
}
