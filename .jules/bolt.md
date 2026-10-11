## 2024-05-18 - Intl Formatter Caching
**Learning:** Instantiating `Intl.DateTimeFormat` and `Intl.NumberFormat` repeatedly is a known performance bottleneck.
**Action:** Use a `Map` cache keyed by locale and stringified options to reuse Intl formatters across function calls.
