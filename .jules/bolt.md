## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2026-10-19 - Cache Intl formatters
**Learning:** Instantiating `Intl.DateTimeFormat` and `Intl.NumberFormat` is a known performance bottleneck in JS. Calling them on every render or function call can degrade performance.
**Action:** Always cache `Intl` formatter instances, such as using a `Map` keyed by locale and options to reuse them instead of creating new instances. For options objects, a deterministic key stringification strategy (like `JSON.stringify(options, Object.keys(options).sort())`) is essential.
