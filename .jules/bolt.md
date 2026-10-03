## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-10-04 - Intl.*Format Caching
**Learning:** Instantiating `Intl.DateTimeFormat` and `Intl.NumberFormat` is an expensive operation that was occurring on every render or function call in central utility functions.
**Action:** Implement simple `Map`-based caching for `Intl` formatters, using a stringified combination of locale and options as the key, to dramatically reduce overhead for repetitive formatting operations.
