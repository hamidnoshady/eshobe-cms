## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-10-22 - Caching Intl Formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instances are a severe performance bottleneck if re-instantiated on every function call.
**Action:** Always cache `Intl` formatters using a Map with deterministic stringification of options (e.g., `JSON.stringify(options, Object.keys(options).sort())`) as part of the cache key.
