## 2024-05-24 - Length-based Timing Leaks in Tokens

**Vulnerability:** Comparing user-supplied variable-length tokens to an expected token using `timingSafeEqual(expected, actual)` without first hashing them exposes a length-based timing leak.
**Learning:** `timingSafeEqual` in Node.js throws on length mismatch, meaning an early return or `actual.length === expected.length` must be done before calling it. However, this early return leaks the expected token length.
**Prevention:** Always use SHA-256 (or similar hash function) on both strings first to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks.
