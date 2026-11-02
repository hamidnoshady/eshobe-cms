/**
 * Redirect path arithmetic for the migration URL inventory (issue #166 §6).
 *
 * WordPress hands the importer absolute permalinks (`https://old.example/blog/…`
 * — note the subdirectory install); Eshobe's `redirects` store site-root
 * relative paths. This module is the one place that turns one into the
 * other, so the generated rule and the reconciliation check can never
 * disagree about whether two URLs are "the same".
 */

/** One comparable site-relative path: leading slash, decoded, no query/hash, no trailing slash. */
export const normalizeRedirectPath = (input: string): string => {
  let path = input.trim()

  try {
    path = decodeURIComponent(path)
  } catch {
    // A malformed percent escape is kept verbatim rather than "fixed" into a
    // different URL than the one the old site actually served.
  }

  path = path.split(/[?#]/)[0] ?? path
  path = path.replace(/\/{2,}/g, '/')
  if (!path.startsWith('/')) path = `/${path}`
  if (path.length > 1) path = path.replace(/\/+$/, '')

  return path.normalize('NFC') || '/'
}

/**
 * The site-relative path a WordPress permalink occupied, with the install's
 * subdirectory prefix removed (`/blog` in `https://old.example/blog/post`).
 * Returns `null` when the value is not a URL at all — the engine records
 * that as an inventory gap instead of inventing a rule.
 */
export const pathFromPermalink = (
  permalink: null | string | undefined,
  sourceBaseUrl: string,
): null | string => {
  if (!permalink || typeof permalink !== 'string') return null

  let url: URL
  try {
    url = new URL(permalink)
  } catch {
    return null
  }

  let prefix = ''
  try {
    prefix = new URL(sourceBaseUrl).pathname.replace(/\/+$/, '')
  } catch {
    prefix = ''
  }

  let path = url.pathname
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
    path = path.slice(prefix.length) || '/'
  }

  return normalizeRedirectPath(path)
}

export type RedirectRule = { from: string; to: string }

export type RedirectProblem =
  | { from: string; kind: 'duplicate'; tos: string[] }
  | { from: string; kind: 'loop' }
  | { from: string; kind: 'self' }

/**
 * Static analysis over a rule set: a `from` pointing at two destinations, a
 * self-rule, or a cycle. Chains (A→B→C) are *not* problems — the resolver
 * follows one hop per request and the browser lands correctly — but cycles
 * are infinite loops, so reconciliation blocks cutover while one exists.
 */
export const analyzeRedirectRules = (rules: RedirectRule[]): RedirectProblem[] => {
  const problems: RedirectProblem[] = []
  const byFrom = new Map<string, Set<string>>()

  for (const rule of rules) {
    const from = normalizeRedirectPath(rule.from)
    const to = normalizeRedirectPath(rule.to)
    byFrom.set(from, new Set([...(byFrom.get(from) ?? []), to]))
  }

  for (const [from, tos] of byFrom) {
    if (tos.has(from)) problems.push({ from, kind: 'self' })
    if (tos.size > 1) problems.push({ from, kind: 'duplicate', tos: [...tos] })
  }

  const single = new Map(
    [...byFrom.entries()].flatMap(([from, tos]) => (tos.size === 1 ? [[from, [...tos][0]!]] : [])),
  )
  const visited = new Set<string>()

  for (const start of single.keys()) {
    if (visited.has(start)) continue

    const trail: string[] = []
    let current: string | undefined = start

    while (current && single.has(current) && !visited.has(current)) {
      if (trail.includes(current)) {
        problems.push({ from: current, kind: 'loop' })
        break
      }
      trail.push(current)
      current = single.get(current)
    }
    for (const node of trail) visited.add(node)
  }

  return problems
}
