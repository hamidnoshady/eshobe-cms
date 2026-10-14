## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Expensive Intl re-instantiation overhead
**Learning:** Instantiating `Intl.DateTimeFormat` or `Intl.NumberFormat` instances on every function call within a render loop causes a massive, hidden performance penalty due to the internal setup cost of the `Intl` API.
**Action:** Always cache `Intl` instances using a map keyed by locale (and options/timezone) when formatting strings, rather than constructing new ones during render cycles or loop iterations.
