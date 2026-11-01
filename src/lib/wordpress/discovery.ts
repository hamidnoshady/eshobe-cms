import type { RestClient } from './client'
import { WordPressApiError } from './client'

/**
 * Source discovery (issue #166, CPT blocker §1).
 *
 * The one rule that shapes this module: **an empty REST answer never means
 * "there is no content".** WordPress hides every post type and taxonomy
 * registered with `show_in_rest: false`, and answers the unauthenticated with
 * less than `context=edit` callers see. So discovery treats a suspiciously
 * empty or degraded inventory as a *blocking* preflight finding with an
 * actionable next step (scoped read-only agent / backup export), and the
 * migration wizard is forbidden from starting on it.
 */

export type DiscoveredPostType = {
  builtin: boolean
  /** What this type is to the migration, before field-level mapping. */
  capability: 'attachment' | 'core-page' | 'core-post' | 'custom' | 'internal' | 'product'
  hasArchive: boolean | string
  hierarchical: boolean
  name: string
  restBase: null | string
  restNamespace: null | string
  slug: string
  taxonomies: string[]
}

export type DiscoveredTaxonomy = {
  builtin: boolean
  hierarchical: boolean
  name: string
  restBase: null | string
  slug: string
  types: string[]
}

export type DiscoveryWarning = {
  code: string
  message: string
  severity: 'blocking' | 'warning'
}

export type SourceInventory = {
  hasWooCommerce: boolean
  namespaces: string[]
  postTypes: DiscoveredPostType[]
  siteName: null | string
  taxonomies: DiscoveredTaxonomy[]
  warnings: DiscoveryWarning[]
}

export const BUILTIN_POST_TYPES = new Set([
  'attachment',
  'nav_menu_item',
  'page',
  'post',
  'revision',
  'wp_block',
  'wp_navigation',
  'wp_template',
  'wp_template_part',
])

export const BUILTIN_TAXONOMIES = new Set([
  'category',
  'link_category',
  'nav_menu',
  'post_format',
  'post_tag',
  'product_cat',
  'product_tag',
  'product_type',
  'product_visibility',
])

const capabilityOf = (slug: string): DiscoveredPostType['capability'] => {
  switch (slug) {
    case 'post':
      return 'core-post'
    case 'page':
      return 'core-page'
    case 'attachment':
      return 'attachment'
    case 'product':
    case 'product_variation':
      return 'product'
    case 'revision':
    case 'nav_menu_item':
    case 'wp_block':
    case 'wp_navigation':
    case 'wp_template':
    case 'wp_template_part':
    case 'shop_order':
    case 'shop_coupon':
      return 'internal'
    default:
      return 'custom'
  }
}

type RawType = {
  has_archive?: boolean | string
  hierarchical?: boolean
  name?: string
  rest_base?: string
  rest_namespace?: string
  slug?: string
  taxonomies?: string[]
}

type RawTaxonomy = {
  hierarchical?: boolean
  name?: string
  rest_base?: string
  slug?: string
  types?: string[]
}

/** Operational words that mean a CPT likely runs a workflow, not just pages. */
const OPERATIONAL_HINTS = [
  'appointment',
  'booking',
  'membership',
  'rental',
  'reservation',
  'subscription',
  'ticket',
  'نوبت',
  'رزرو',
]

/**
 * Does this CPT look like it powers a business workflow (bookings, member
 * access…) rather than display content? A heuristic for human review — the
 * coverage matrix turns it into a blocking row until an adapter is confirmed,
 * because moving the *rows* of a booking system without its logic is exactly
 * the silent break the issue forbids.
 */
export const classifyCptCapability = (
  type: Pick<DiscoveredPostType, 'name' | 'slug'>,
): { mode: 'data-only' | 'requires-review'; reason?: string } => {
  const haystack = `${type.slug} ${type.name}`.toLowerCase()
  const hint = OPERATIONAL_HINTS.find((word) => haystack.includes(word))

  return hint
    ? { mode: 'requires-review', reason: `نام نوع محتوا به فرایند عملیاتی («${hint}») اشاره دارد.` }
    : { mode: 'data-only' }
}

/**
 * Enumerate registered post types + taxonomies with an authenticated
 * (`context=edit`) read, degrading to a public read only to produce an
 * accurate blocking explanation — never to proceed quietly.
 */
export const discoverWordPress = async (client: RestClient): Promise<SourceInventory> => {
  const warnings: DiscoveryWarning[] = []

  const index = await client
    .getJson<{ name?: string; namespaces?: string[] }>('/wp-json/')
    .catch(() => ({}) as { name?: string; namespaces?: string[] })
  const namespaces = index.namespaces ?? []
  const hasWooCommerce = namespaces.some((ns) => ns.startsWith('wc/'))

  const readRegistry = async <T>(path: string): Promise<T | null> => {
    try {
      return await client.getJson<T>(path, { context: 'edit' })
    } catch (error) {
      if (error instanceof WordPressApiError && (error.status === 401 || error.status === 403)) {
        warnings.push({
          code: 'EDIT_CONTEXT_DENIED',
          message:
            'دسترسی احراز‌شده (context=edit) رد شد؛ موجودی فعلی فقط نمای عمومی است و نمی‌توان بر آن تکیه کرد. رمز برنامه با نقش مدیر لازم است یا باید از خروجی پشتیبان/عامل مهاجرت استفاده شود.',
          severity: 'blocking',
        })
        return client.getJson<T>(path).catch(() => null)
      }
      throw error
    }
  }

  const [rawTypes, rawTaxonomies] = await Promise.all([
    readRegistry<Record<string, RawType>>('/wp-json/wp/v2/types'),
    readRegistry<Record<string, RawTaxonomy>>('/wp-json/wp/v2/taxonomies'),
  ])

  const postTypes: DiscoveredPostType[] = Object.values(rawTypes ?? {})
    .filter((type) => typeof type?.slug === 'string')
    .map((type) => ({
      builtin: BUILTIN_POST_TYPES.has(type.slug!),
      capability: capabilityOf(type.slug!),
      hasArchive: type.has_archive ?? false,
      hierarchical: Boolean(type.hierarchical),
      name: type.name ?? type.slug!,
      restBase: type.rest_base ?? null,
      restNamespace: type.rest_namespace ?? null,
      slug: type.slug!,
      taxonomies: type.taxonomies ?? [],
    }))

  const taxonomies: DiscoveredTaxonomy[] = Object.values(rawTaxonomies ?? {})
    .filter((taxonomy) => typeof taxonomy?.slug === 'string')
    .map((taxonomy) => ({
      builtin: BUILTIN_TAXONOMIES.has(taxonomy.slug!),
      hierarchical: Boolean(taxonomy.hierarchical),
      name: taxonomy.name ?? taxonomy.slug!,
      restBase: taxonomy.rest_base ?? null,
      slug: taxonomy.slug!,
      types: taxonomy.types ?? [],
    }))

  const typeSlugs = new Set(postTypes.map((type) => type.slug))

  if (!rawTypes || !typeSlugs.has('post') || !typeSlugs.has('page')) {
    warnings.push({
      code: 'CORE_TYPES_MISSING',
      message:
        'حتی نوع‌های هسته وردپرس (نوشته و برگه) در پاسخ REST نیستند؛ یعنی دسترسی یا REST ناقص است، نه این‌که محتوایی وجود ندارد. مهاجرت تا رفع این مورد شروع نمی‌شود.',
      severity: 'blocking',
    })
  }
  if (!taxonomies.length) {
    warnings.push({
      code: 'NO_TAXONOMIES_VISIBLE',
      message:
        'هیچ طبقه‌بندی‌ای از REST دیده نمی‌شود. طبقه‌بندی‌های با show_in_rest=false پنهان می‌مانند؛ پیش از مهاجرت باید با عامل مهاجرت فقط‌خواندنی یا خروجی پشتیبان فهرست کامل گرفته شود.',
      severity: 'blocking',
    })
  }
  if (postTypes.some((type) => !type.restBase && type.capability === 'custom')) {
    warnings.push({
      code: 'CPT_WITHOUT_REST',
      message:
        'دست‌کم یک نوع محتوای سفارشی پایه REST ندارد و از API خوانده نمی‌شود؛ برای آن عامل مهاجرت یا خروجی پشتیبان لازم است.',
      severity: 'blocking',
    })
  }
  warnings.push({
    code: 'HIDDEN_TYPES_POSSIBLE',
    message:
      'نوع‌ها و طبقه‌بندی‌های ثبت‌شده با show_in_rest=false در REST فهرست نمی‌شوند. این موجودی را «کامل» حساب نکنید تا گزارش افزونه‌ها/عامل مهاجرت آن را تأیید کند.',
    severity: 'warning',
  })

  return {
    hasWooCommerce,
    namespaces,
    postTypes,
    siteName: index.name ?? null,
    taxonomies,
    warnings,
  }
}
