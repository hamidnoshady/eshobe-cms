import { parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'

/**
 * Theme package rows must store the raw `eshobe.theme.json` object. Parsed manifests
 * encode `settings` as an array and break `manifestOf()` on read.
 */
export const parseStoredThemeManifest = (
  raw: Record<string, unknown>,
  contractVersion = 1,
): ThemeManifest => {
  const parsed = parseThemeManifest(raw, contractVersion)
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}
