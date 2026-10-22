## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2026-10-22 - Cache Intl formatters
**Learning:** Intl formatters (Intl.DateTimeFormat, Intl.NumberFormat) are a known performance bottleneck in this app and must be cached rather than re-instantiated on every function call.
**Action:** When creating instances based on an options object, use a deterministic stringification strategy such as `JSON.stringify(options, Object.keys(options).sort())` to ensure property order differences do not cause cache misses.
