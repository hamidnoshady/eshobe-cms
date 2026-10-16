## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-10-16 - Cache Intl Formatters for performance
**Learning:** Intl formatters (`Intl.DateTimeFormat` and `Intl.NumberFormat`) instantiation can be quite expensive. Repeated creation of these formatters, like in `formatDate` and `formatNumber` which are heavily used, severely impacts performance.
**Action:** Always verify if Intl objects can be instantiated outside loops/repeated component calls and cached using deterministic stringification of options.
