import type { CollectionBeforeValidateHook } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'
import { failField, siteIdOfWrite } from './contentSameSite'

// IDs go in paths as well as database indexes; names, slugs and SKU are not identities.
export const isMenuSourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)

/** The pair is optional for native content, but complete and immutable for a POS row. */
export const validateMenuSource: CollectionBeforeValidateHook = async ({ collection, data, originalDoc, req }) => {
  if (!data) return data
  const row = data as Record<string, unknown>
  const previous = (originalDoc ?? {}) as Record<string, unknown>
  const system = row.menuSourceSystem === undefined ? previous.menuSourceSystem : row.menuSourceSystem
  const sourceId = row.menuSourceId === undefined ? previous.menuSourceId : row.menuSourceId
  const hasSystem = typeof system === 'string' && system.length > 0
  const hasId = typeof sourceId === 'string' && sourceId.length > 0

  if (hasSystem && !siteIdOfWrite(row, previous)) {
    failField(collection, req, [{ message: 'منوی همگام‌شده باید به یک سایت تعلق داشته باشد.', path: 'site' }])
  }
  if (hasSystem && row.menuOrder !== undefined && row.menuOrder !== null && !Number.isSafeInteger(row.menuOrder)) {
    failField(collection, req, [{ message: 'ترتیب منو باید عدد صحیح باشد.', path: 'menuOrder' }])
  }
  if (hasSystem !== hasId || (hasSystem && system !== 'biza_miz') || (hasId && !isMenuSourceId(sourceId))) {
    failField(collection, req, [
      { message: 'سامانه و شناسهٔ معتبر منوی مبدأ باید با هم ثبت شوند.', path: 'menuSourceId' },
    ])
  }
  if (previous.menuSourceSystem && (system !== previous.menuSourceSystem || sourceId !== previous.menuSourceId)) {
    failField(collection, req, [
      { message: 'شناسهٔ مبدأ یک منوی همگام‌شده تغییرپذیر نیست.', path: 'menuSourceId' },
    ])
  }
  if (!hasSystem && !hasId) {
    // Empty native identities must be SQL NULL, not a shared empty-string key.
    if (row.menuSourceSystem !== undefined) row.menuSourceSystem = null
    if (row.menuSourceId !== undefined) row.menuSourceId = null
  }
  const nextSite = Object.hasOwn(row, 'site') ? idOf(row.site) : idOf(previous.site)
  if (previous.menuSourceSystem && nextSite !== idOf(previous.site)) {
    failField(collection, req, [{ message: 'سایت منوی همگام‌شده تغییرپذیر نیست.', path: 'site' }])
  }

  // POS owns recipe stock. Neither an admin edit nor a payment hook can opt a Biza
  // product back into CMS stock settlement while that identity remains attached.
  if (collection.slug === 'products' && system === 'biza_miz') {
    row.externalInventory = true
    if (previous.menuSourceSystem === 'biza_miz') {
      const inventoryChanged = ['inventory', 'trackInventory'].some((key) =>
        row[key] !== undefined && (row[key] ?? null) !== (previous[key] ?? null),
      )
      const stocks = (value: unknown) => Array.isArray(value)
        ? value.map((entry) => ({ key: entry?.key ?? null, inventory: entry?.inventory ?? null, trackInventory: entry?.trackInventory === true }))
        : []
      const variationsChanged = row.variations !== undefined &&
        JSON.stringify(stocks(row.variations)) !== JSON.stringify(stocks(previous.variations))
      if (inventoryChanged || variationsChanged) {
        const key = await requestApiKey(req)
        if (key?.role !== 'site' || key.siteId !== siteIdOfWrite(row, previous)) {
          failField(collection, req, [{ message: 'موجودی این کالا فقط از سامانهٔ مبدأ همگام می‌شود.', path: 'inventory' }])
        }
      }
    }
  }
  return data
}
