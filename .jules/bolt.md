## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.

## 2024-05-19 - Deterministic object stringification in cache keys
**Learning:** Using `JSON.stringify(options)` for caching can lead to cache misses if identically-valued objects are constructed with different key ordering. `JSON.stringify(options, Object.keys(options).sort())` is a highly elegant and performant trick to serialize flat objects deterministically.
**Action:** When building cache keys from parameter objects, enforce deterministic ordering of keys if the environment might provide them in different orders. Always safeguard against null/undefined options before extracting their keys to prevent throwing exceptions (e.g. `const safeOptions = options || {}`).
