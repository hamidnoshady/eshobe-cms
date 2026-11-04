# Torob Product API v3 — shared contract fixtures

These JSON cases are the language-neutral contract shared by the two Torob Product API
v3 runtimes:

- Biza Miz platform runtime: `src/lib/torob/{contract,auth,feed}.ts`
- Eshobe CMS site-origin runtime (this repo): `src/lib/torob/{contract,auth,feed}.ts`

They were extracted from `hamidnoshady/biza-miz` at commit
`dde49a2aa7b3f44eb3f6593a4cfbc20d2c8ff9ec` (`src/lib/torob/*.test.ts`,
`tests/integration/torob-api.integration.test.ts`) and from the WordPress connector
tests in the same commit. Both runtimes MUST pass the same cases; a change to the
contract is made here and in the platform repo together, never in one runtime only.

| File | Covers |
| --- | --- |
| `request-cases.json` | the four modes, exact 400 sentences, no default page |
| `auth-cases.json` | EdDSA token/version/audience/expiry/nbf reasons |
| `price-cases.json` | Toman conversion, unsupported currency, unavailable ⇒ false+0 |
| `feed-cases.json` | ordering, paging, cursor, direct lookups, envelope shape |
