## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.

## 2024-05-19 - Cache Intl formatters (Deterministic Cache Key generation overhead)
**Learning:** When generating cache keys for options objects (e.g., Intl formatters options), attempting to create a deterministic cache key by sorting the keys inside `JSON.stringify` (e.g., `JSON.stringify(options, Object.keys(options).sort())`) introduces significant overhead in the hot path. Benchmarks demonstrate that this approach is ~3x slower than a standard `JSON.stringify(options)` due to array allocation and sorting. A custom, manual stringification function (checking length and concatenating strings directly) can be ~4x faster than standard `JSON.stringify(options)`, making it the optimal approach for generating cache keys from small options objects.
**Action:** When caching instances based on small options objects, use a fast, custom stringification function that avoids `JSON.stringify` overhead, such as manual string concatenation. Avoid using sorting combined with `JSON.stringify` because it adds unnecessary CPU overhead for cache hits.
