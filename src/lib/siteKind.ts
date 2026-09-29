/**
 * Shop vs. non-shop, the one split the admin panel makes by site type.
 *
 * `sites.type` is `business | portfolio | store`. Only `store` sells anything, so it is
 * the only type whose panel shows products, orders, payments and store settings; the
 * others get the content-and-theme panel. Unknown or missing counts as non-shop for the
 * *dashboard* (nothing to sell is the safe reading) — the sidebar makes the opposite
 * choice when the type cannot be read, see `resolveNavGroups`.
 *
 * This is navigation, not authorization: the shop collections keep their access rules.
 */
export const isShopSite = (type: null | string | undefined): boolean => type === 'store'

/** Collections that only exist for a shop. */
export const SHOP_COLLECTIONS = ['products', 'orders', 'payment-gateways', 'store'] as const
