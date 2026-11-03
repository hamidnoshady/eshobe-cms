## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.

## 2024-05-20 - Deterministic Object Stringification for Cache Keys
**Learning:** `JSON.stringify(options)` is sensitive to property order. Passing `{a:1, b:2}` and `{b:2, a:1}` generates different strings, which causes cache misses for structurally identical options objects.
**Action:** When caching based on an options object, use `JSON.stringify(safeOptions, Object.keys(safeOptions).sort())` to ensure property order differences do not cause cache misses. Always safeguard against null/undefined options before passing to `Object.keys()`.
