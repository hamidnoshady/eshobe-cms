## 2024-06-15 - Deterministic Intl Caching
**Learning:** Caching `Intl` instances using `JSON.stringify(options)` is flawed because object property order is not guaranteed. Different call sites passing `{ dateStyle: 'long', timeStyle: 'short' }` vs `{ timeStyle: 'short', dateStyle: 'long' }` will result in different cache keys and cache misses, negating the optimization.
**Action:** Always sort object keys before stringifying for cache keys using `JSON.stringify(options, Object.keys(options).sort())`.
