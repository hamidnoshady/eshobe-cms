## 2024-05-18 - Static computation outside React components
**Learning:** Pre-calculating static derived data (like parsing breakpoints into a sizes string) outside the component body is a clean, low-risk way to eliminate redundant CPU work on every render of heavily reused components like Images.
**Action:** Always look for `Object.entries().map()` or similar iterations inside component bodies that rely purely on static module-level variables. Move them to module scope to compute them exactly once.

## 2024-05-19 - Cache Intl formatters
**Learning:** `Intl.DateTimeFormat` and `Intl.NumberFormat` instantiation is a known performance bottleneck in JS. Recreating them on every function call for commonly formatted dates or numbers causes significant CPU overhead, especially during bulk operations or frequent re-renders.
**Action:** Always cache `Intl` formatters (e.g., using a `Map` keyed by locale and options) instead of instantiating them on every function call.
## 2024-05-20 - Deterministic stringification for object caching
**Learning:** When using `JSON.stringify()` to generate cache keys from configuration objects, the key insertion order can lead to unexpected cache misses. Even if  and  are semantically equivalent, their serialized strings are different, causing duplicate instantiations.
**Action:** When hashing or caching based on an object, always use a deterministic serialization strategy. For flat objects with primitive keys (like  options),  is a zero-dependency, highly performant way to guarantee consistent cache keys.

## 2024-05-20 - Deterministic stringification for object caching
**Learning:** When using `JSON.stringify()` to generate cache keys from configuration objects, the key insertion order can lead to unexpected cache misses. Even if `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are semantically equivalent, their serialized strings are different, causing duplicate instantiations.
**Action:** When hashing or caching based on an object, always use a deterministic serialization strategy. For flat objects with primitive keys (like `Intl` options), `JSON.stringify(opts, Object.keys(opts).sort())` is a zero-dependency, highly performant way to guarantee consistent cache keys.
