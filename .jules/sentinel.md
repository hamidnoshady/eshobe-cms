## 2025-03-01 - Timing Attack Vulnerability in Secret Comparison
**Vulnerability:** A simple string equality operator (`!==`) was used to compare the expected secret with the user-provided secret in `src/endpoints/handoff.ts`.
**Learning:** String comparison operators short-circuit, leading to measurable timing differences. This could be exploited by an attacker to guess the secret character by character or determine its length.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing sensitive strings or tokens. Furthermore, when the lengths of the strings can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks or runtime exceptions.
## 2025-02-14 - Fix timing attack vulnerability in preview route
**Vulnerability:** Timing attack vulnerability due to string comparison for `previewSecret`.
**Learning:** Checking equality of secrets directly using string comparisons (`!==`) instead of using constant-time comparisons (`timingSafeEqual`) leaves the check vulnerable to timing attacks where the time difference in early returns allows attackers to brute-force the length and content of the secret.
**Prevention:** Use `timingSafeEqual` with `createHash` from `node:crypto` to securely compare string hashes and prevent timing attacks.
