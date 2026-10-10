## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Intl API formatting overhead
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS engines when called on every function execution, which can slow down rendering particularly in a Next.js app rendering many dates or numbers.
**Action:** Cache the instantiated formatters (e.g. using a Map with locale and options as keys) and re-use the instances when calling `format()` to prevent repeatedly allocating new formatters.
