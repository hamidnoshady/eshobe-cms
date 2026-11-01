import { localeCodes } from './locales'
import { HOME_SLUG, PRODUCTS_SEGMENT, RESERVED_PAGE_SLUGS, slugify } from './slug'

/**
 * URL shapes for the custom content engine (issue #166 §3).
 *
 * A WordPress CPT brings its own rewrite base (`/portfolio/<slug>`) and its
 * taxonomies bring theirs (`/genre/<term>`). Those bases are *data* — one per
 * site, per locale, per definition — so they can never become folders under
 * `[domain]`; they are resolved from the site's `content-type-definitions` and
 * `taxonomy-definitions` rows at request time, as a fallback after the CMS page
 * lookup misses (see `SitePage`). Everything in this module is pure: the
 * caller fetches the definitions (tenant-scoped, in the active locale) and
 * this module only matches and expands strings.
 *
 * Machine keys vs archive slugs: a definition's `key` is the stable ASCII
 * identifier import mappings and theme code refer to; its `archiveSlug` is the
 * localized first URL segment a visitor sees, which is why it goes through the
 * same Persian-safe `slugify` as every other slug.
 */

/** `portfolio`, `case-study_2` — never a Persian title, never a path. */
export const isMachineKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)

export const machineKeyMessage =
  'کلید ماشینی باید با حرف کوچک انگلیسی شروع شود و فقط شامل حروف کوچک، عدد، خط تیره یا زیرخط باشد (حداکثر ۶۴ نویسه).'

/**
 * First URL segments a CPT/taxonomy archive may never claim: the site router's
 * own segments, the platform surfaces, and every locale code (an archive named
 * `en` would be read as the English prefix and never reach the matcher).
 */
export const RESERVED_ARCHIVE_SLUGS: readonly string[] = [
  ...RESERVED_PAGE_SLUGS,
  PRODUCTS_SEGMENT,
  HOME_SLUG,
  'admin',
  'api',
  'next',
  ...localeCodes,
]

export const isReservedArchiveSlug = (value: string): boolean =>
  RESERVED_ARCHIVE_SLUGS.includes(value)

/**
 * One URL segment, already in the canonical spelling `slugify` produces.
 * Requiring `slugify(value) === value` (rather than silently slugifying) makes
 * an imported rewrite base that would change shape a visible mapping
 * decision, not a silent URL change.
 */
export const isValidArchiveSlug = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 80 &&
  !value.includes('/') &&
  slugify(value) === value &&
  !isReservedArchiveSlug(value)

export const archiveSlugMessage =
  'بخش نشانی بایگانی باید یک بخشِ نشانی معتبر (بدون «/») و غیررزرو باشد؛ مثل «نمونه‌کار» یا portfolio.'

/** The permalink templates the first-party resolver can match back from a URL. */
export const PERMALINK_TEMPLATES = [
  '/{archive}/{slug}',
  '/{archive}/{id}',
  '/{slug}',
  '/{id}',
] as const

export type PermalinkTemplate = (typeof PERMALINK_TEMPLATES)[number]

export const DEFAULT_PERMALINK_TEMPLATE: PermalinkTemplate = '/{archive}/{slug}'

export const isPermalinkTemplate = (value: unknown): value is PermalinkTemplate =>
  typeof value === 'string' && (PERMALINK_TEMPLATES as readonly string[]).includes(value)

export const permalinkTemplateMessage = `قالب پیوسته‌نشانی باید یکی از این‌ها باشد: ${PERMALINK_TEMPLATES.join(' ، ')}`

export type TypeDefinitionRouting = {
  archiveSlug?: null | string
  hasArchive?: boolean | null
  id: string
  key: string
  permalinkTemplate?: null | string
}

export type TaxonomyDefinitionRouting = {
  archiveSlug?: null | string
  hasArchive?: boolean | null
  hierarchical?: boolean | null
  id: string
  key: string
}

/** The archive base a definition answers to, falling back to its machine key. */
export const archiveSlugOf = (definition: {
  archiveSlug?: null | string
  key: string
}): string => definition.archiveSlug?.trim() || definition.key

/** `/{archive}` — where a type's (or taxonomy's) archive listing lives. */
export const archivePathOf = (definition: {
  archiveSlug?: null | string
  key: string
}): string => `/${archiveSlugOf(definition)}`

/** One entry's site-relative path under its type's permalink template. */
export const entryPath = (
  definition: TypeDefinitionRouting,
  entry: { id: string; slug?: null | string },
): string => {
  const template = isPermalinkTemplate(definition.permalinkTemplate)
    ? definition.permalinkTemplate
    : DEFAULT_PERMALINK_TEMPLATE

  return template
    .replace('{archive}', archiveSlugOf(definition))
    .replace('{slug}', entry.slug ?? '')
    .replace('{id}', String(entry.id))
}

/**
 * A term's archive path. `termSlugs` is the ancestor chain ending at the term
 * itself — hierarchical taxonomies keep the parent segments WordPress rewrites
 * carry (`/genre/parent/child`), tag-like ones pass a single slug.
 */
export const termArchivePath = (
  definition: TaxonomyDefinitionRouting,
  termSlugs: string[],
): string => `/${[archiveSlugOf(definition), ...termSlugs].join('/')}`

export type ContentRouteMatch =
  | { entryId: string; kind: 'entry'; typeId: string; typeKey: string }
  | { kind: 'entry'; slug: string; typeId: string; typeKey: string }
  | { kind: 'taxonomy-index'; taxonomyId: string; taxonomyKey: string }
  | { kind: 'term-archive'; taxonomyId: string; taxonomyKey: string; termSlugs: string[] }
  | { kind: 'type-archive'; typeId: string; typeKey: string }

/**
 * Match locale-stripped, decoded URL segments against one site's definitions.
 *
 * Archive slugs are unique across both definition collections on a site
 * (`uniqueArchiveSlugPerSite`), so the first segment decides unambiguously
 * whether this is a type or a taxonomy. Single-segment permalink templates
 * (`/{slug}`, `/{id}`) are tried last, in definition order — two types
 * publishing entries at the root can collide on a slug, and first-match is the
 * documented tiebreak (root-level types should keep slugs disjoint).
 */
export const matchContentRoute = (
  definitions: { taxonomies: TaxonomyDefinitionRouting[]; types: TypeDefinitionRouting[] },
  segments: string[],
): ContentRouteMatch | null => {
  const [first, ...rest] = segments

  if (!first) return null

  const type = definitions.types.find(
    (definition) =>
      archiveSlugOf(definition) === first &&
      (definition.permalinkTemplate ?? DEFAULT_PERMALINK_TEMPLATE).startsWith('/{archive}/'),
  )

  if (type) {
    if (rest.length === 0) {
      return type.hasArchive === false
        ? null
        : { kind: 'type-archive', typeId: type.id, typeKey: type.key }
    }

    if (rest.length === 1) {
      return (type.permalinkTemplate ?? DEFAULT_PERMALINK_TEMPLATE) === '/{archive}/{id}'
        ? { entryId: rest[0]!, kind: 'entry', typeId: type.id, typeKey: type.key }
        : { kind: 'entry', slug: rest[0]!, typeId: type.id, typeKey: type.key }
    }

    return null
  }

  const taxonomy = definitions.taxonomies.find(
    (definition) => archiveSlugOf(definition) === first,
  )

  if (taxonomy) {
    if (taxonomy.hasArchive === false) return null
    if (rest.length === 0) {
      return { kind: 'taxonomy-index', taxonomyId: taxonomy.id, taxonomyKey: taxonomy.key }
    }
    // A flat (tag-like) taxonomy has no ancestor segments to walk: anything
    // past the term slug is a different, unknown URL.
    if (!taxonomy.hierarchical && rest.length > 1) return null

    return {
      kind: 'term-archive',
      taxonomyId: taxonomy.id,
      taxonomyKey: taxonomy.key,
      termSlugs: rest,
    }
  }

  if (segments.length === 1) {
    for (const definition of definitions.types) {
      if (definition.permalinkTemplate === '/{slug}') {
        return { kind: 'entry', slug: first, typeId: definition.id, typeKey: definition.key }
      }
      if (definition.permalinkTemplate === '/{id}') {
        return { entryId: first, kind: 'entry', typeId: definition.id, typeKey: definition.key }
      }
    }
  }

  return null
}
