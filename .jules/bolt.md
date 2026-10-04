## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2026-10-04 - Avoid N+1 queries during search index sync
**Learning:** In `src/search/beforeSync.ts`, fetching categories inside a `for...of` loop led to sequential queries for each category during the search document sync. Replacing this with `Promise.all()` and `.map()` parallelizes these lookups, reducing overall latency.
**Action:** Whenever fetching associated documents (like categories, tags, or authors) from an array of IDs or references, always map them into an array of Promises and resolve them concurrently with `Promise.all` instead of fetching them sequentially.
