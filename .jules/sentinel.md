## 2025-03-01 - Timing Attack Vulnerability in Secret Comparison
**Vulnerability:** A simple string equality operator (`!==`) was used to compare the expected secret with the user-provided secret in `src/endpoints/handoff.ts`.
**Learning:** String comparison operators short-circuit, leading to measurable timing differences. This could be exploited by an attacker to guess the secret character by character or determine its length.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing sensitive strings or tokens. Furthermore, when the lengths of the strings can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks or runtime exceptions.

## 2025-03-01 - Length-Based Timing Leaks via early return before `timingSafeEqual`
**Vulnerability:** Before passing arbitrary-length tokens to `crypto.timingSafeEqual()`, a length comparison check (`supplied.length === expected.length`) was executed, returning early if lengths didn't match.
**Learning:** While `timingSafeEqual()` itself compares buffers in constant time, wrapping it in an early return short-circuits the comparison based on length. An attacker can observe response times to definitively deduce the exact length of the expected secret.
**Prevention:** When comparing variables of arbitrary or unknown lengths, do not use an early length check. Instead, hash both values using a fast algorithm like SHA-256 to ensure they are the exact same length (e.g., 32 bytes) before passing them to `timingSafeEqual()`.
