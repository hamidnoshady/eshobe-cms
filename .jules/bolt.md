## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2026-10-17 - Intl object instantiation caching
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is notoriously expensive and known to be a performance bottleneck in JS environments. It is critical to avoid creating a new `Intl` instance inside formatting functions that are called frequently (like in React render cycles or mapped over large datasets).
**Action:** Always cache and reuse `Intl` instances. Use deterministic caching keys based on the provided configuration (like `locale` and `options`) such as `JSON.stringify(options, Object.keys(options).sort())` to ensure property order differences do not cause cache misses.
