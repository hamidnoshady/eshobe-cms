## 2025-03-01 - Timing Attack Vulnerability in Secret Comparison
**Vulnerability:** A simple string equality operator (`!==`) was used to compare the expected secret with the user-provided secret in `src/endpoints/handoff.ts`.
**Learning:** String comparison operators short-circuit, leading to measurable timing differences. This could be exploited by an attacker to guess the secret character by character or determine its length.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing sensitive strings or tokens. Furthermore, when the lengths of the strings can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks or runtime exceptions.
## 2024-05-18 - Fix timing leak in variable-length token comparison
**Vulnerability:** A length-based timing leak existed in multiple files where `timingSafeEqual` was used on variable-length strings (or strings where length could be inferred if different).
**Learning:** `timingSafeEqual` throws an error if buffer lengths mismatch. If length checking is performed beforehand (or allowed to crash), it can leak the exact length of the expected secret string. `Buffer.from()` was used directly, which preserved string length differences.
**Prevention:** When comparing tokens where the length can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks.
