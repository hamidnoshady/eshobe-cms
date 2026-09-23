import { contractVersion } from '@eshobe/site-runtime'

import {
  MAX_MANIFEST_BYTES,
  isSafeGitRef,
  parseRepository,
  parseThemeManifestText,
  type ManifestParse,
} from '@/lib/deploy/manifest'

/**
 * Read `eshobe.theme.json` out of a theme repository.
 *
 * One function, one file, one ref. Not a GitHub client: the platform does not need
 * to browse repositories, and every capability added here is a capability an
 * operator's token would carry into a third-party repo.
 *
 * ## Why `raw.githubusercontent.com` first
 *
 * It is unauthenticated, cached, and returns the file body directly — no base64
 * envelope, no JSON wrapper, no rate limit worth mentioning for public repos. The
 * REST Contents API is the fallback, used when a token is present (a private theme
 * repo) or when raw answers 404 on a private repo.
 *
 * `GITHUB_THEME_TOKEN` is a read-only PAT for private theme repositories. It is
 * platform infrastructure, not per-package: a token stored per row would be twenty
 * credentials to rotate, and the repositories it reads are all the operator's own.
 */

const TIMEOUT_MS = 10_000

export type ManifestFetch =
  | ({ ok: true; ref: string; sha: null | string } & { manifest: Extract<ManifestParse, { ok: true }>['manifest'] })
  | { errors: string[]; ok: false }

const truncatedRead = async (response: Response): Promise<null | string> => {
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length && length > MAX_MANIFEST_BYTES) return null
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) return null
  return text
}

const get = async (url: string, headers: Record<string, string>): Promise<null | Response> => {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return null
  }
}

/**
 * The commit a ref currently points at.
 *
 * Recorded on every deployment so "what is actually running on acme.ir" has an exact
 * answer, and so a rollback has something to roll back *to*. A branch name is not an
 * answer to that question — it is the answer to "what did we ask for".
 */
export const resolveCommitSha = async (
  repository: string,
  ref: string,
): Promise<null | string> => {
  const repo = parseRepository(repository)
  if (!repo || !isSafeGitRef(ref)) return null

  const token = process.env.GITHUB_THEME_TOKEN?.trim()
  const response = await get(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`,
    {
      accept: 'application/vnd.github+json',
      'user-agent': 'eshobe-cms',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  )

  if (!response?.ok) return null
  const body = (await response.json().catch(() => null)) as null | { sha?: unknown }
  const sha = String(body?.sha ?? '')
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null
}

export const fetchThemeManifest = async (
  repository: string,
  ref: string,
): Promise<ManifestFetch> => {
  const repo = parseRepository(repository)
  if (!repo) {
    return { errors: ['نشانی مخزن باید به شکل owner/name باشد.'], ok: false }
  }
  if (!isSafeGitRef(ref)) {
    return { errors: ['نام شاخه یا تگ نامعتبر است.'], ok: false }
  }

  const token = process.env.GITHUB_THEME_TOKEN?.trim()
  const path = 'eshobe.theme.json'
  let text: null | string = null

  if (!token) {
    const raw = await get(
      `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${path}`,
      { 'user-agent': 'eshobe-cms' },
    )
    if (raw?.ok) text = await truncatedRead(raw)
  }

  if (text === null) {
    const api = await get(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      {
        accept: 'application/vnd.github.raw+json',
        'user-agent': 'eshobe-cms',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    )

    if (!api) {
      return { errors: ['اتصال به گیت‌هاب برقرار نشد.'], ok: false }
    }
    if (api.status === 404) {
      return {
        errors: [
          `فایل ${path} در ${repo.owner}/${repo.name}@${ref} پیدا نشد. اگر مخزن خصوصی است، GITHUB_THEME_TOKEN را تنظیم کنید.`,
        ],
        ok: false,
      }
    }
    if (api.status === 401 || api.status === 403) {
      return { errors: ['گیت‌هاب دسترسی نداد؛ GITHUB_THEME_TOKEN را بررسی کنید.'], ok: false }
    }
    if (!api.ok) {
      return { errors: [`گیت‌هاب پاسخ ${api.status} داد.`], ok: false }
    }

    text = await truncatedRead(api)
  }

  if (text === null) {
    return { errors: [`فایل ${path} از ${MAX_MANIFEST_BYTES} بایت بزرگ‌تر است.`], ok: false }
  }

  const parsed = parseThemeManifestText(text, contractVersion)
  if (!parsed.ok) return parsed

  return { manifest: parsed.manifest, ok: true, ref, sha: await resolveCommitSha(repository, ref) }
}
