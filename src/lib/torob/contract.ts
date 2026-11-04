/**
 * Torob Product API v3 — the wire contract, shared with Biza Miz and the Woo connector.
 *
 * Source: `torob/Torob-Sync` → `product_api_v3.md`, as transcribed by
 * `biza-miz/src/lib/torob/contract.ts`. The field names and error sentences are
 * Torob's, not a CMS vocabulary. Four request modes, exactly one, no default page.
 */
export const TOROB_API_VERSION = 'torob_api_v3'
export const TOROB_PAGE_SIZE = 100
export const TOROB_PRODUCTS_PATH = '/torob/v1/products'
export const TOROB_SORTS = ['date_added_desc', 'date_updated_desc', 'product_id_desc'] as const
export type TorobSort = (typeof TOROB_SORTS)[number]
export const TOROB_CURSOR_SORT: TorobSort = 'product_id_desc'

export const TOROB_FIELD_LIMITS = {
  category_name: 200,
  image_link: 1000,
  page_unique: 200,
  page_url: 1500,
  product_group_id: 200,
  short_desc: 500,
  subtitle: 500,
  title: 500,
} as const

export interface TorobProductV3 {
  availability: boolean
  category_name?: string
  current_price: number
  date_added: string
  date_updated?: string
  image_links: string[]
  old_price?: number
  page_unique: string
  page_url: string
  product_group_id?: string
  short_desc?: string
  spec: Record<string, number | string>
  subtitle?: string
  title: string
}

export interface TorobV3Response {
  api_version: typeof TOROB_API_VERSION
  current_page?: number
  max_pages: number | null
  next_cursor: null | string
  products: TorobProductV3[]
  total: number
}

export type TorobRequest =
  | { mode: 'cursor'; cursor: null | string; sort: TorobSort }
  | { mode: 'page'; page: number; sort: TorobSort }
  | { mode: 'page_uniques'; pageUniques: string[] }
  | { mode: 'page_urls'; pageUrls: string[] }

export type TorobRequestError =
  | 'body_not_object'
  | 'cursor_invalid'
  | 'cursor_requires_product_id_desc'
  | 'empty_request'
  | 'multiple_modes'
  | 'page_invalid'
  | 'page_uniques_invalid'
  | 'page_urls_invalid'
  | 'sort_invalid'
  | 'sort_required'

export const TOROB_REQUEST_ERROR_MESSAGE: Readonly<Record<TorobRequestError, string>> = {
  body_not_object: 'request body must be a JSON object',
  cursor_invalid: 'cursor must be a non-empty string',
  cursor_requires_product_id_desc: 'cursor pagination requires sort product_id_desc',
  empty_request: 'request body is empty: send page_urls, page_uniques, page, or cursor',
  multiple_modes: 'request must use exactly one of page_urls, page_uniques, page, or cursor',
  page_invalid: 'page must be an integer greater than or equal to 1',
  page_uniques_invalid: 'page_uniques must be a non-empty list of strings',
  page_urls_invalid: 'page_urls must be a non-empty list of absolute URLs',
  sort_invalid: `sort must be one of ${TOROB_SORTS.join(', ')}`,
  sort_required: 'sort parameter is not provided',
}

export type ParsedTorobRequest =
  | { ok: false; error: TorobRequestError }
  | { ok: true; request: TorobRequest }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isAbsoluteHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

/** Unknown keys are ignored; ambiguity and every form of "no mode" are refused. */
export const parseTorobRequest = (body: unknown): ParsedTorobRequest => {
  if (!isPlainObject(body)) return { ok: false, error: 'body_not_object' }

  const hasUrls = 'page_urls' in body
  const hasUniques = 'page_uniques' in body
  const hasPage = 'page' in body
  const hasCursor = 'cursor' in body
  const modes = [hasUrls, hasUniques, hasPage, hasCursor].filter(Boolean).length
  if (modes === 0) return { ok: false, error: 'empty_request' }
  if (modes > 1) return { ok: false, error: 'multiple_modes' }

  if (hasUrls) {
    const value = body.page_urls
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((entry) => typeof entry === 'string' && isAbsoluteHttpUrl(entry))
    ) {
      return { ok: false, error: 'page_urls_invalid' }
    }
    return { ok: true, request: { mode: 'page_urls', pageUrls: value as string[] } }
  }

  if (hasUniques) {
    const value = body.page_uniques
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
    ) {
      return { ok: false, error: 'page_uniques_invalid' }
    }
    return {
      ok: true,
      request: { mode: 'page_uniques', pageUniques: (value as string[]).map((entry) => entry.trim()) },
    }
  }

  const sort = body.sort
  if (sort === undefined) return { ok: false, error: 'sort_required' }
  if (typeof sort !== 'string' || !(TOROB_SORTS as readonly string[]).includes(sort)) {
    return { ok: false, error: 'sort_invalid' }
  }
  const typedSort = sort as TorobSort

  if (hasCursor) {
    const cursor = body.cursor
    if (cursor !== null && (typeof cursor !== 'string' || cursor.trim().length === 0)) {
      return { ok: false, error: 'cursor_invalid' }
    }
    if (typedSort !== TOROB_CURSOR_SORT) {
      return { ok: false, error: 'cursor_requires_product_id_desc' }
    }
    return {
      ok: true,
      request: { mode: 'cursor', cursor: typeof cursor === 'string' ? cursor.trim() : null, sort: typedSort },
    }
  }

  const page = body.page
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) {
    return { ok: false, error: 'page_invalid' }
  }
  return { ok: true, request: { mode: 'page', page, sort: typedSort } }
}

export const clampTorobField = (value: null | string | undefined, limit: number): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

export const torobPricePair = (available: boolean, toman: number) =>
  available ? { availability: true, current_price: toman } : { availability: false, current_price: 0 }

export const torobMaxPages = (total: number): number => Math.max(1, Math.ceil(total / TOROB_PAGE_SIZE))

export const torobPageResponse = (input: {
  page: number
  products: TorobProductV3[]
  total: number
}): TorobV3Response => ({
  api_version: TOROB_API_VERSION,
  current_page: input.page,
  max_pages: torobMaxPages(input.total),
  next_cursor: null,
  products: input.products,
  total: input.total,
})

export const torobCursorResponse = (input: {
  nextCursor: null | string
  products: TorobProductV3[]
  total: number
}): TorobV3Response => ({
  api_version: TOROB_API_VERSION,
  max_pages: torobMaxPages(input.total),
  next_cursor: input.nextCursor,
  products: input.products,
  total: input.total,
})

export const torobErrorBody = (error: TorobRequestError): { error: string } => ({
  error: TOROB_REQUEST_ERROR_MESSAGE[error],
})
