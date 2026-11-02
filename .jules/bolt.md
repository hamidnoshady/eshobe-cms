## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.
## 2024-05-30 - Deterministic Cache Keys for Intl Formatters
**Learning:** Instantiating `Intl` formatters (`DateTimeFormat`, `NumberFormat`) is extremely expensive and causes a known bottleneck, making caching crucial. When using stringified options objects (e.g. `JSON.stringify(options)`) as part of a cache key, object property order causes non-deterministic keys (e.g., `{a:1, b:2}` vs `{b:2, a:1}` stringify differently) leading to severe performance degradations via unnecessary cache misses and re-instantiations.
**Action:** When caching object instances based on an options argument, always ensure a deterministic stringification strategy, such as using `JSON.stringify(options, Object.keys(options).sort())`. Always protect against null/undefined before extracting keys (e.g., `const safeOptions = options || {}`) to avoid runtime crashes.
