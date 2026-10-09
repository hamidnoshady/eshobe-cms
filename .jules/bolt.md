## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Intl formatters are expensive to instantiate
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instances are incredibly expensive to create. Re-instantiating them on every function call (e.g. for simple formatting) becomes a significant performance bottleneck, especially on operations called repeatedly.
**Action:** When working with the `Intl` API, always cache formatter instances (for example, using a `Map` where keys represent locale and options combinations) and reuse them instead of creating new instances.
