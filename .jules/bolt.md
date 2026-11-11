## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.

## 2024-05-20 - Fast Custom Cache Keys over JSON.stringify
**Learning:** When generating cache keys for options objects (e.g., Intl formatters) in hot paths, using standard `JSON.stringify` degrades performance significantly due to string allocation and sorting overhead (~3x slower than a custom loop). Since these option objects are flat and don't require predictable sorting to achieve a high cache hit rate, we can serialize them manually.
**Action:** Always prefer fast custom stringification (e.g., manual concatenation via `for...in` loop) over `JSON.stringify` when caching options in a hot path.
