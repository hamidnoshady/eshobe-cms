/**
 * The lifecycle of a `content-entries` document (issue #166).
 *
 * Mirrors WordPress `post_status` rather than Payload's draft/published pair:
 * a migrated CPT entry can be private, scheduled or trashed in the source, and
 * flattening those into "draft" would lose the distinction the migration report
 * has to reconcile. Only `published` is ever public — `private` and `scheduled`
 * are staff-only states, exactly as `authenticatedOrEntryPublished`
 * (`src/access/entryPublished.ts`) enforces.
 */
export const ENTRY_STATUSES = [
  'draft',
  'pending',
  'published',
  'private',
  'scheduled',
  'trash',
] as const

export type EntryStatus = (typeof ENTRY_STATUSES)[number]

export const isEntryStatus = (value: unknown): value is EntryStatus =>
  typeof value === 'string' && (ENTRY_STATUSES as readonly string[]).includes(value)

/** The one status an anonymous visitor may ever see. */
export const isPublicEntryStatus = (value: unknown): boolean => value === 'published'
