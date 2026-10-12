## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.
## 2024-05-19 - Cache Intl formatters
**Learning:** Intl formatters (`Intl.DateTimeFormat`, `Intl.NumberFormat`) are a known performance bottleneck in this app and must be cached (e.g., using a Map with locale/options as the key) rather than re-instantiated on every function call.
**Action:** Always check if `Intl` instances are being instantiated inside functions or components that are called frequently. If so, move the instantiation to module scope or cache them based on their locale and options.
