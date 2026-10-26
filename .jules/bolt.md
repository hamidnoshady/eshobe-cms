## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.

## 2024-05-19 - Cache Intl formatters deterministically
**Learning:** Even when caching `Intl.DateTimeFormat` or `Intl.NumberFormat` via an options string `JSON.stringify(options)`, property order differences will result in different string representations and cause cache misses, negating the caching benefits entirely for functionally identical options objects.
**Action:** When stringifying an options object for caching, consistently ensure key ordering by explicitly sorting the keys: `JSON.stringify(options, Object.keys(options).sort())` to guarantee deterministic cache keys and optimal cache hit rates.
