## 2025-03-01 - Timing Attack Vulnerability in Secret Comparison
**Vulnerability:** A simple string equality operator (`!==`) was used to compare the expected secret with the user-provided secret in `src/endpoints/handoff.ts`.
**Learning:** String comparison operators short-circuit, leading to measurable timing differences. This could be exploited by an attacker to guess the secret character by character or determine its length.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing sensitive strings or tokens. Furthermore, when the lengths of the strings can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks or runtime exceptions.

## 2026-10-27 - Length-based Timing Leak in Variable-length Secret Comparison
**Vulnerability:** In `src/lib/admin-bootstrap.ts` and `src/lib/jobs-access.ts`, `timingSafeEqual` was used but preceded by a length check (`expected.length === actual.length`), returning early if lengths didn't match.
**Learning:** While `timingSafeEqual` protects against byte-by-byte timing attacks, doing an early return on variable-length tokens allows an attacker to deduce the exact length of the expected token.
**Prevention:** When comparing tokens of unknown or variable length, always hash them first (e.g., using SHA-256). This ensures the buffers are fixed length and identical, allowing you to pass them directly to `timingSafeEqual` without length-checking early returns.
