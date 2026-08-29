const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `sites.id` is a uuid because `postgresAdapter({ idType: 'uuid' })` says so.
 *
 * Anything else handed to a `where: { id: { equals: … } }` is not "no results", it is
 * Postgres throwing `invalid input syntax for type uuid` — which on a public route is
 * a 500 for whatever a crawler puts in the URL. Check the shape, then query.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

/**
 * A relationship value is an id on a shallow write and a document on a populated
 * read. Payload's `depth` decides which, and both are correct — so "which site is
 * this on?" has to accept either, or the answer is `"[object Object]"` and every
 * scope check passes vacuously.
 */
export const idOf = (value: unknown): null | string => {
  if (value === null || value === undefined || value === '') return null

  if (typeof value === 'object') {
    const id = (value as { id?: unknown }).id

    return id === null || id === undefined ? null : String(id)
  }

  if (typeof value === 'number' || typeof value === 'string') return String(value)

  return null
}
