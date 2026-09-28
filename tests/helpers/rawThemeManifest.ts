import { parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'

/** Parse a theme package's stored `manifest` JSON (GitHub object or post-sync normalized shape). */
export const parseStoredThemeManifest = (
  raw: Record<string, unknown>,
  contractVersion = 1,
): ThemeManifest => {
  const parsed = parseThemeManifest(raw, contractVersion)
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}
