/**
 * Browser-safe limits and error codes for the SVG upload allowlist.
 *
 * `src/lib/svg.ts` is the server-side validator and uses `Buffer`; keeping the
 * constants here lets the admin uploader read the same numbers without dragging
 * Node-only code into the client bundle. The server remains authoritative —
 * these are shared *labels*, never a client-side decision to accept a file.
 */

/** An SVG logo is a few KB. Anything near this is a photograph in a costume. */
export const MAX_SVG_BYTES = 200 * 1024

/**
 * Bounds for the narrow filter subset. They are deliberately small: a logo needs
 * one or two blur/merge graphs, not a rendering workload. Percentages are
 * relative to the object bounding box; user units are absolute SVG units.
 */
export const SVG_FILTER_LIMITS = {
  maxStdDeviation: 20,
  maxRegionPercent: 1000,
  maxRegionUserUnits: 10_000,
  maxFilters: 8,
  maxPrimitivesPerFilter: 24,
  maxPrimitivesTotal: 48,
  maxMergeNodesPerFilter: 32,
  maxMergeNodesTotal: 96,
  /** Uses of `filter: url(#id)` / `filter="url(#id)"`, not all local refs. */
  maxFilterReferences: 32,
  maxKeyframes: 16,
  maxCssDeclarations: 512,
} as const

/** Stable, machine-readable reasons. The UI keys its localized copy off these. */
export const SVG_ERROR_CODES = [
  'svg-empty',
  'svg-too-large',
  'svg-invalid-utf8',
  'svg-forbidden-markup',
  'svg-invalid-comment',
  'svg-invalid-root',
  'svg-invalid-markup',
  'svg-invalid-text',
  'svg-invalid-entity',
  'svg-invalid-element',
  'svg-invalid-attribute',
  'svg-invalid-value',
  'svg-invalid-reference',
  'svg-invalid-css',
  'svg-invalid-structure',
  'svg-too-complex',
  'svg-unclosed',
] as const

export type SvgErrorCode = (typeof SVG_ERROR_CODES)[number]
