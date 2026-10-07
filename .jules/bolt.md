## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2025-02-12 - Caching Intl Formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instances are extremely slow to instantiate (~4ms each) but fast to use once created (~0.007ms). Creating them on every render or function call creates a massive performance bottleneck.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them directly inside utility functions like `formatDate` or `formatNumber`.
