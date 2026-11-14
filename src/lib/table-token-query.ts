/**
 * The table QR query contract shared by the site route and tests.
 *
 * `tableToken` is the canonical name emitted by Biza. `t` is accepted only as a
 * migration alias for old printed links. A request that supplies both names with
 * different values is never allowed to choose one: the caller must reject it rather
 * than accidentally attributing a basket to the wrong table.
 *
 * This module deliberately does not ask Biza whether a token is live. The token is
 * opaque to Eshobe; authorization, rotation and revocation belong to Biza's existing
 * table QR service when the order is submitted.
 */

export type TableTokenQueryValue = string | string[] | undefined

export type TableTokenQuery = {
  tableToken?: TableTokenQueryValue
  t?: TableTokenQueryValue
}

export type TableTokenQueryResult = {
  /** The single value to carry to the café menu, or null when none was supplied. */
  token: null | string
  /** True when canonical and legacy inputs disagree (including distinct duplicates). */
  conflict: boolean
  /** True when the legacy alias was used without a canonical value. */
  usedLegacy: boolean
  /** True when the legacy alias appeared at all, including alongside an equal canonical value. */
  hasLegacy: boolean
}

const valuesOf = (value: TableTokenQueryValue): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
  return typeof value === 'string' ? [value.trim()] : []
}

/**
 * Resolve the two accepted spellings without silently preferring either one.
 *
 * Repeated identical values are harmless (some proxies preserve duplicate query
 * parameters), while two distinct values are a conflict (an empty duplicate is still
 * a supplied value and is not silently discarded). Whitespace around a value is ignored
 * for comparison and forwarding; Biza's token resolver still owns the actual token-format
 * and lifecycle check.
 */
export const resolveTableTokenQuery = (query: TableTokenQuery): TableTokenQueryResult => {
  const canonical = valuesOf(query.tableToken)
  const legacy = valuesOf(query.t)
  const distinct = [...new Set([...canonical, ...legacy])]

  if (distinct.length > 1) {
    return { conflict: true, hasLegacy: query.t !== undefined, token: null, usedLegacy: false }
  }

  const token = distinct[0] || null
  const hasLegacy = query.t !== undefined

  return {
    conflict: false,
    hasLegacy,
    token,
    usedLegacy: Boolean(token && canonical.length === 0 && hasLegacy),
  }
}

/**
 * Return a query object with the legacy alias removed and the canonical key inserted.
 * Used only for the permanent redirect from old QR links; unrelated search params are
 * preserved by the site route.
 */
export const canonicalizeTableTokenQuery = <T extends Record<string, unknown>>(
  query: T,
  resolved: TableTokenQueryResult = resolveTableTokenQuery(query as TableTokenQuery),
): T => {
  const next = { ...query } as T & { tableToken?: string; t?: unknown }
  delete next.t

  if (resolved.token) next.tableToken = resolved.token
  else delete next.tableToken

  return next as T
}
