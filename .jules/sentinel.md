## 2025-03-01 - Timing Attack Vulnerability in Secret Comparison
**Vulnerability:** A simple string equality operator (`!==`) was used to compare the expected secret with the user-provided secret in `src/endpoints/handoff.ts`.
**Learning:** String comparison operators short-circuit, leading to measurable timing differences. This could be exploited by an attacker to guess the secret character by character or determine its length.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing sensitive strings or tokens. Furthermore, when the lengths of the strings can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks or runtime exceptions.
## 2024-05-15 - Timing safe comparison length leaks

**Vulnerability:** Length-based timing leak in token comparisons using `timingSafeEqual()`.

**Learning:** Comparing tokens with an early-return length check before calling `timingSafeEqual()` (e.g. `if (a.length !== b.length) return false; return timingSafeEqual(a, b);`) allows an attacker to deduce the exact length of the secret token. `timingSafeEqual()` will throw on length mismatch, which is why developers are forced to check length or hash first.

**Prevention:** When comparing sensitive strings of potentially variable length, always hash both strings first (e.g., using `createHash('sha256').update(val).digest()`) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks and runtime exceptions.
