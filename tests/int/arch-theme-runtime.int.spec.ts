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

/** GitHub Actions runners do not ship `rg`; walk the tree in-process instead. */
const searchRepo = (root: string, pattern: RegExp): string[] => {
  const hits: string[] = []
  const skip = new Set(['node_modules', '.git'])

  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!stat.isFile() || stat.size > 512_000) continue
      try {
        const text = fs.readFileSync(full, 'utf8')
        if (pattern.test(text)) hits.push(full)
      } catch {
        // skip binary or unreadable files
      }
    }
  }

  walk(root)
  return hits
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
    const hits = searchRepo(repoDir, /api\/site/)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('includes revalidation handling for renderer webhooks', () => {
    ensureRepo()
    const hits = searchRepo(repoDir, /x-eshobe-signature|revalidate/i)
    expect(hits.length).toBeGreaterThan(0)
  })
})
