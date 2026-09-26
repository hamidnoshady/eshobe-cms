// @vitest-environment node
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { contractVersion } from '@eshobe/site-runtime'
import { parseThemeManifest } from '@/lib/deploy/manifest'

const repoDir = path.join('/tmp', 'arch-theme-cms-runtime')

const ensureRepo = () => {
  if (!fs.existsSync(path.join(repoDir, 'package.json'))) {
    execSync(`git clone --depth 1 https://github.com/hamidnoshady/arch-theme-cms.git ${repoDir}`, {
      stdio: 'pipe',
      timeout: 120_000,
    })
  }
}

describe('arch-theme-cms runtime assumptions', () => {
  it('documents contractVersion alignment with the CMS', () => {
    ensureRepo()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'eshobe.theme.json'), 'utf8'),
    ) as Record<string, unknown>
    const parsed = parseThemeManifest(manifest, contractVersion)
    expect(parsed.ok).toBe(true)
  })

  it('includes a site bootstrap module that references /api/site', () => {
    ensureRepo()
    const hits = execSync(`rg -l "api/site" ${repoDir} --glob '!node_modules' || true`, {
      encoding: 'utf8',
    }).trim()
    expect(hits.length).toBeGreaterThan(0)
  })

  it('includes revalidation handling for renderer webhooks', () => {
    ensureRepo()
    const hits = execSync(
      `rg -l "x-eshobe-signature|revalidate" ${repoDir} --glob '!node_modules' || true`,
      { encoding: 'utf8' },
    ).trim()
    expect(hits.length).toBeGreaterThan(0)
  })
})
