## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-10-20 - Cache Intl Formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Re-creating them on every format call (e.g., in a loop or large lists) degrades performance.
**Action:** Always cache these formatters (e.g. using a Map). To ensure options uniqueness handles differing key order, stringify options deterministically using `JSON.stringify(options, Object.keys(options).sort())`.
