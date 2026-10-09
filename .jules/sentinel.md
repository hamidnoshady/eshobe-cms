## 2025-03-01 - Timing Attack Vulnerability in Secret Comparison
**Vulnerability:** A simple string equality operator (`!==`) was used to compare the expected secret with the user-provided secret in `src/endpoints/handoff.ts`.
**Learning:** String comparison operators short-circuit, leading to measurable timing differences. This could be exploited by an attacker to guess the secret character by character or determine its length.
**Prevention:** Always use `crypto.timingSafeEqual()` when comparing sensitive strings or tokens. Furthermore, when the lengths of the strings can vary, hash both strings first (e.g., using SHA-256) to ensure the buffers passed to `timingSafeEqual()` are exactly the same length, preventing length-based timing leaks or runtime exceptions.

## 2024-10-10 - Open Redirect via Protocol-Relative URLs
**Vulnerability:** Open redirect in handoff and preview endpoints due to insufficient validation of relative paths.
**Learning:** Checking `path.startsWith('/')` is not enough to guarantee a relative path, as `//evil.com` passes this check but acts as an absolute (protocol-relative) URL in browsers.
**Prevention:** Always validate relative paths strictly by checking `path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')`.
