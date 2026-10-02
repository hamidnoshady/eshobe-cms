## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-10-02 - Pre-computing static mapped React elements
**Learning:** In forms using `react-hook-form` where components render frequently, rendering large static lists (like 250+ countries) inside the component body creates hundreds of React element objects per render.
**Action:** Always move `.map()` calls over static data that output static `<SelectItems>` (or similar elements) outside the component definition to module scope, passing the pre-computed array down into the render.
