import type { ManifestContentSlot } from '@/lib/deploy/manifest'

import { adminBase } from '@/admin/navigation'

/** The collection a content slot's binding points at — the same table as the descriptor's. */
export const SLOT_COLLECTION = {
  category: 'categories',
  form: 'forms',
  media: 'media',
  page: 'pages',
  post: 'posts',
} as const

export type SlotCollection = (typeof SLOT_COLLECTION)[keyof typeof SLOT_COLLECTION]

/** What the dashboard shows for one theme content slot. */
export type ThemeSlotRow = {
  /** A second, optional shortcut — a category's posts, for instance. */
  extra?: { href: string; label: string }
  href: string
  key: string
  label: string
  linkLabel: string
  required: boolean
  /** `bound`: points at a live document. `missing`: bound, but the document is gone. `unbound`: nothing chosen. */
  state: 'bound' | 'missing' | 'unbound'
  title: null | string
  type: string
}

const bindingId = (binding: unknown): string =>
  binding && typeof binding === 'object' ? String((binding as { id?: unknown }).id ?? '') : ''

/**
 * One row of «محتوای پوسته» — what a theme's manifest asked the customer to choose, and
 * where to go to change it.
 *
 * Generic on purpose: nothing here knows what a blog, a projects page or a home page is.
 * A theme that declares a new slot in `eshobe.theme.json` shows up on the dashboard
 * without a CMS change, which is the point of declaring it in the manifest.
 *
 * `doc` is the bound document as read tenant-scoped by the caller, or `null` when that
 * read found nothing (deleted, or another site's — reported identically).
 */
export const buildSlotRow = ({
  adminRoute,
  binding,
  doc,
  settingsHref,
  slot,
}: {
  adminRoute: string
  binding: unknown
  doc: null | { filename?: unknown; title?: unknown }
  settingsHref: string
  slot: ManifestContentSlot
}): ThemeSlotRow => {
  const id = bindingId(binding)
  const base = adminBase(adminRoute)
  const collection = SLOT_COLLECTION[slot.type]
  const label = slot.labelFa?.trim() || slot.labelEn?.trim() || slot.key
  const common = { key: slot.key, label, required: slot.required, type: slot.type }

  if (!id) {
    return { ...common, href: settingsHref, linkLabel: 'انتخاب', state: 'unbound', title: null }
  }
  if (!doc) {
    return { ...common, href: settingsHref, linkLabel: 'اتصال دوباره', state: 'missing', title: null }
  }

  const title =
    typeof doc.title === 'string' && doc.title.trim()
      ? doc.title
      : typeof doc.filename === 'string'
        ? doc.filename
        : null
  const row: ThemeSlotRow = {
    ...common,
    href: `${base}/collections/${collection}/${encodeURIComponent(id)}`,
    linkLabel: 'ویرایش',
    state: 'bound',
    title,
  }
  // A category is only useful through what is filed under it.
  if (slot.type === 'category') {
    row.extra = {
      href: `${base}/collections/posts?where[categories][in][0]=${encodeURIComponent(id)}`,
      label: 'نوشته‌ها',
    }
  }
  return row
}
