// @vitest-environment node
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseThemeManifest } from '@/lib/deploy/manifest'
import { contractVersion } from '@eshobe/site-runtime'

const repoDir = path.join('/tmp', 'arch-theme-cms-compat')

describe('hamidnoshady/arch-theme-cms compatibility', () => {
  it('manifest parses with the same validator the CMS uses', () => {
    if (!fs.existsSync(path.join(repoDir, 'eshobe.theme.json'))) {
      execSync(
        `git clone --depth 1 https://github.com/hamidnoshady/arch-theme-cms.git ${repoDir}`,
        { stdio: 'pipe', timeout: 120_000 },
      )
    }

    const manifestPath = path.join(repoDir, 'eshobe.theme.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const parsed = parseThemeManifest(raw, contractVersion)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.manifest.contractVersion).toBeLessThanOrEqual(contractVersion)
      expect(parsed.manifest.key).toBeTruthy()
    }
  })

  it('declares @eshobe/site-runtime as a dependency', () => {
    const pkgPath = path.join(repoDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@eshobe/site-runtime']).toBeTruthy()
  })
})
