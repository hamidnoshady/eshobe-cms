## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.
## 2025-02-12 - Cache Intl formatters for dates and numbers
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is notoriously slow in V8/Node.js. Repeatedly calling `new Intl.DateTimeFormat()` or `new Intl.NumberFormat()` inside utility functions (like `formatDate` and `formatNumber`) without caching causes significant performance bottlenecks, particularly when rendering lists of components that display dates or formatted numbers.
**Action:** Always cache `Intl` formatter instances instead of creating them on every function call. A simple `Map` keyed by the locale and stringified options provides a ~100x performance improvement for formatting operations.
