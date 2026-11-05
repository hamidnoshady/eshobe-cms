## 2026-11-05 - Missing Parameter Check Allows Authorization Bypass
**Vulnerability:** The `/api/handoff` endpoint skipped its secret validation block entirely if an expected secret was configured but the caller omitted the `secret` parameter from the request (`if (expectedSecret && secret != null)`).
**Learning:** Checking for the presence of a user-supplied parameter inside the same `if` condition that gates the security check itself can lead to a fail-open scenario where missing input bypasses validation.
**Prevention:** Always structure security checks such that if a requirement exists (e.g., `expectedSecret` is configured), the absence of the required input (`secret == null`) results in an explicit and immediate failure (`403 Forbidden`) before proceeding.
