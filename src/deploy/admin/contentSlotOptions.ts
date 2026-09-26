/** Maps manifest content-slot types to Payload collection slugs. */
export const contentSlotCollectionSlug = {
  category: 'categories',
  form: 'forms',
  media: 'media',
  page: 'pages',
  post: 'posts',
} as const

export type ContentSlotType = keyof typeof contentSlotCollectionSlug

export type ContentOption = { id: string; label: string }

type ListResponse = {
  docs?: Record<string, unknown>[]
  hasNextPage?: boolean
  nextPage?: null | number
}

const labelOf = (doc: Record<string, unknown>): null | string => {
  const label = doc.title ?? doc.name ?? doc.filename ?? doc.slug
  return typeof label === 'string' ? label : null
}

/** One page of tenant-scoped REST results (same shape the admin form uses). */
export const mapContentDocsToOptions = (docs: Record<string, unknown>[]): ContentOption[] =>
  docs.flatMap((doc) => {
    const id = typeof doc.id === 'string' ? doc.id : null
    const label = labelOf(doc)
    return id && label ? [{ id, label }] : []
  })

/**
 * Walk every page so sites with more than 100 bindable rows still see them all.
 * Optional `search` narrows by title/name/filename/slug when the API supports it.
 */
export const fetchAllContentSlotOptions = async (
  fetchPage: (args: { page: number; search?: string; type: ContentSlotType }) => Promise<ListResponse>,
  type: ContentSlotType,
  search?: string,
): Promise<ContentOption[]> => {
  const options: ContentOption[] = []
  let page = 1
  let hasNext = true

  while (hasNext) {
    const payload = await fetchPage({ page, search, type })
    options.push(...mapContentDocsToOptions(payload.docs ?? []))
    hasNext = Boolean(payload.hasNextPage && payload.nextPage)
    page = payload.nextPage ?? page + 1
    if (!payload.docs?.length && !hasNext) break
    if (page > 500) break
  }

  return options
}

export const contentSlotSearchWhere = (
  type: ContentSlotType,
  term: string,
): Record<string, unknown> | undefined => {
  const q = term.trim()
  if (!q) return undefined
  if (type === 'media') return { filename: { contains: q } }
  if (type === 'form') return { title: { contains: q } }
  if (type === 'category') return { title: { contains: q } }
  return { or: [{ title: { contains: q } }, { slug: { contains: q } }] }
}
