## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-11-20 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instances are a known performance bottleneck in JS because they are expensive to create. Doing so inside loops or frequently called formatting functions causes heavy main-thread blocking.
**Action:** Always cache `Intl` formatter instances (e.g., using a `Map` where the key is derived from the locale and formatting options) so they are initialized only once per unique locale and options configuration.
