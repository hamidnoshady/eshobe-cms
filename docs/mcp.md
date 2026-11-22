# MCP over HTTP

Model Context Protocol (MCP) support for this CMS: an **inbound** Streamable HTTP MCP
server that lets ChatGPT-style assistants, Claude Code and Bizamiz AI discover and
use a customer site's content tools, under a credential the customer's own staff
mint.

Implemented on `@payloadcms/plugin-mcp` 3.90.2 (the same version family as Payload
itself). Additions in this repository are a capability matrix, three read-only
custom tools, a request gate and an audit hook — see
[What this repository adds](#what-this-repository-adds).

---

## 1. Inbound vs outbound

| Direction | Status | Where |
| --- | --- | --- |
| **Inbound** — an external assistant calls this CMS | **Implemented and tested** | `/api/mcp`, `src/plugins/mcp.ts` |
| **Outbound** — this CMS calls an external MCP server and uses its tools | **Not implemented** | — |

The outbound client is deliberately absent. Nothing in this deployment has a use for
remote MCP tools, and a client that can be pointed at an arbitrary URL is an SSRF
surface that would need its own allowlist, credential store and audit trail. Adding
it because the protocol supports it would be speculative surface area. If a real
requirement appears (a translation service, a search index), it belongs in its own
module with its own credential collection — never bolted onto `/api/mcp`.

**Bizamiz AI is the inverse case and is also blocked on its own side.** Its repository
(`hamidnoshady/biza-miz`) exposes its own MCP **server** (`/api/mcp`,
`/api/platform/mcp`) with `posmcp_` / `pospmcp_` credentials, scopes and an approval
queue. It has **no outbound MCP client**: there is no `tools/list` / `tools/call`
client code, and its `src/lib/mcp/platform-client-config.ts` states that attaching an
external server as a tool provider to its agents is a separate, explicitly-approved
feature. Until that exists, "Bizamiz invokes Payload tools" cannot be delivered by
changing this repository. §8 documents the contract that feature will need.

---

## 2. Endpoint

```
POST https://<control-plane-host>/api/mcp
```

- Transport: **Streamable HTTP** (`application/json` in, `text/event-stream` or JSON
  out). SSE-only transport is disabled (`disableSse: true`); the `GET /api/mcp`
  method answers `405`, which is the plugin's documented behaviour.
- The endpoint lives on the **control-plane host** (`CONTROL_PLANE_HOST`, the admin
  origin). It is **not** carved out for customer domains: `/api/*` on a customer
  domain answers 404 by design (`Caddyfile` → `@control_plane_paths`). A shop's
  homepage must never be one `curl` away from a customer's content API.
- Request body cap: `MCP_MAX_BODY_BYTES` (default 262144). Declared `Content-Length`
  above the cap is refused with `413` before the body is parsed.
- Per-key rate limit: `MCP_RATE_LIMIT` requests per minute (default 120). Refused with
  `429`. Counters are **per process**, so two web replicas allow up to twice the
  figure and a restart clears the window. This bounds a runaway loop; it is not
  billing metering.

---

## 3. Authentication

A caller presents a Payload API key from the `payload-mcp-api-keys` collection:

```
Authorization: Bearer <key>
Accept: application/json, text/event-stream
Content-Type: application/json
```

The key resolves to its **owner user**, and every tool then runs with
`overrideAccess: false`. Authorization is therefore ordinary Payload access control
— collection access, field access, the multi-tenant site scope and the
`writeUnlessPublishing()` rule — not a second permission system that could drift from
it.

### Minting a key

Admin panel: **یکپارچه‌سازی → کلیدهای MCP → Create**.

Over REST, as the user the key will act as:

```bash
curl -X POST https://<host>/api/payload-mcp-api-keys \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
    "label": "ChatGPT — Acme",
    "pages":  { "find": true, "create": true, "update": true },
    "posts":  { "find": true },
    "payload-mcp-tool": { "cmsDescribeCapabilities": true, "cmsContentStatus": true }
  }'
```

Notes that matter:

- **Every capability checkbox defaults to off.** A new key can do nothing until it is
  granted something. Grants are per collection *and* per operation.
- Payload does not return the raw key from a normal read (`apiKey` read access is
  `false`), which is why an API client should generate the value and send it on
  create — the same shape the e2e suite uses. A key minted through the admin panel is
  shown once at creation.
- A key cannot be re-bound to another user: the `user` field is create-defaulted,
  update-locked and access-denied to callers who are not that user.
- `expiresAt` (sidebar, Jalali picker in the Persian admin) is enforced on the next
  request with `401`. Empty means "no expiry", which is what every key minted before
  this field existed has.
- **Revoking** means deleting the row, or setting `expiresAt` in the past. There is no
  soft-disable flag: a credential that still authenticates but is "disabled" by a
  checkbox is the failure mode worth avoiding.

---

## 4. What is exposed

Defined once in `src/mcp/capabilities.ts` and pinned by
`tests/int/mcp.int.spec.ts`:

| Collection | find | create | update | delete |
| --- | --- | --- | --- | --- |
| `pages` | ✓ | ✓ | ✓ | — |
| `posts` | ✓ | ✓ | ✓ | — |
| `media` | ✓ | — | ✓ | — |
| `categories` | ✓ | ✓ | ✓ | — |
| `products` | ✓ | ✓ | ✓ | — |
| `site-branding` | ✓ | — | ✓ | — |
| `header` | ✓ | — | ✓ | — |
| `footer` | ✓ | — | ✓ | — |
| `store` | ✓ | — | ✓ | — |
| `forms` | ✓ | — | ✓ | — |
| `payload-folders` | ✓ | ✓ | ✓ | — |

**No delete operation exists anywhere**, for any key, on any collection. It is not a
permission a caller can grant; the tool is never registered. That also means a
compromised key cannot destroy content, which is the one failure this surface cannot
undo.

Deliberately absent, as collections and as tools: `users`, `sites`, `api-keys`,
`storage-connections`, `payment-gateways`, billing credentials and ledgers, `orders`,
`form-submissions`, `webhook*`, `audit-log`, `site-theme-settings`, `site-deployments`,
`theme-*`, `deploy-targets`, `plans`, `feature-flags`, and every other platform-wide
row. They cannot be enabled by ticking a box because they are not in the matrix at
all.

### Generated tool names

The plugin names tools `<operation><Collection>`:

```
findPages        createPages        updatePages
findPosts        createPosts        updatePosts
findMedia        updateMedia
findCategories   createCategories   updateCategories
findProducts     createProducts     updateProducts
findSiteBranding updateSiteBranding
findHeader       updateHeader
findFooter       updateFooter
findStore        updateStore
findForms        updateForms
findPayloadFolders createPayloadFolders updatePayloadFolders
```

Each tool's input schema is generated from the collection config, so it is the
authoritative field list — including localized fields, relationships and blocks.

### Custom tools (read-only)

Registered in `src/mcp/tools`, each gated by its own checkbox on the key:

| Tool | Answers |
| --- | --- |
| `cms_describe_capabilities` | Which collections and operations **this key** may use, the exact tool names, and the site's languages. |
| `cms_site_context` | The site(s) this key may act on: name, domain, type, lifecycle status, languages. Only those fields — the `sites` document also holds billing and deployment links, which are not selected. |
| `cms_content_status` | Publishing state for `pages` / `posts`: draft vs published, publication date, and whether a publication is scheduled for the future. |

They are read-only by design. The plugin's key form gives a custom tool a checkbox
defaulting to **enabled**, so a mutating custom tool would arrive already granted on
every key ever created. Publishing already works through `updatePages`/`updatePosts`,
where `writeUnlessPublishing()` makes the decision; a second path through a custom
tool would only weaken it.

---

## 5. Business rules still apply

Nothing about the MCP path bypasses the CMS:

- **Validation and hooks** run exactly as in the admin panel (`beforeValidate`,
  `beforeChange`, after-hooks, `revalidateSiteDoc`, unique-slug rules).
- **Quota** (`enforceQuota`) refuses a create on a site over its plan limit.
- **Publishing:** an editor's key can save drafts; only an `owner` of the site can set
  `_status: 'published'`. The refusal is the same function that hides the Publish
  button in the admin.
- **Tenant scope:** reads are narrowed to the key owner's sites — a `find` by another
  site's document id answers "not found", and a `where` clause cannot widen the set.
  A create that names a foreign `site` is rejected by the multi-tenant plugin.
- **Creating needs a site id.** A create has no existing document to read the tenant
  from, so the generated schema carries `site`; take it from `cms_site_context`. A
  site the key does not belong to is refused.
- **No field bypass:** `site`, `createdAt` and relations are injected by Payload and
  the plugins as usual.

---

## 6. Audit

`src/plugins/mcpAudit.ts` appends an `audit-log` row for every MCP write
(`create`/`update`, and `delete` if it is ever enabled), with:

- `action: 'mcp.contentChanged'`
- `actorType: 'apiKey'`, `actorEmail: 'mcp:<key label>'` — the credential, not the
  person who minted it
- `targetCollection`, `targetId`, `site`
- `changes`: field names plus short scalars through `sanitizeChanges`, which drops
  anything matching `/secret|password|token|credential|apikey|…/`

No request body, no header, no token. The write is best-effort: an audit failure is
logged and never fails the content write it describes.

The hook keys on `req.payloadAPI === 'MCP'`, which the plugin sets for the request it
hands every tool. Admin, REST, seeds and jobs are untouched.

---

## 7. Connecting a client

### ChatGPT / any connector that accepts a URL and a header

- URL: `https://<control-plane-host>/api/mcp`
- Authentication: `Bearer <key>` (some UIs label this "API key" or "Authorization
  header")
- Transport: Streamable HTTP

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "eshobe-cms": {
      "type": "http",
      "url": "https://cms.example.com/api/mcp",
      "headers": { "Authorization": "Bearer REPLACE_WITH_MCP_KEY" }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

Desktop accepts only stdio servers, so bridge through `mcp-remote`:

```json
{
  "mcpServers": {
    "eshobe-cms": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://cms.example.com/api/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer REPLACE_WITH_MCP_KEY" }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.eshobe-cms]
url = "https://cms.example.com/api/mcp"
bearer_token_env_var = "ESHOBE_MCP_TOKEN"
```

Never commit a real key. Keys are per user and per site: one per integration, revoked
by deleting the row.

---

## 8. Bizamiz AI integration contract

Payload is ready to be registered as a remote MCP server by any client that speaks
Streamable HTTP. What Bizamiz needs to provide on **its** side is an outbound MCP
client in its existing connector architecture — not a new one:

1. A registry row for the server: label, `url` (`…/api/mcp`), and a credential stored
   **server-side only** (it already has this shape for its own connections table).
2. Credential handling: a static `Authorization: Bearer <key>` header is enough.
   Payload does not implement MCP's OAuth flow, so Bizamiz's OAuth machinery is not
   required for this integration.
3. `initialize` + `tools/list` on connect; convert the returned JSON-Schema tool list
   into its existing tool format (schemas are already JSON Schema).
4. `tools/call` for invocation, with a timeout. Payload answers a refused operation
   as tool text (`ok: false` / "Error …") with HTTP 200, and only authentication,
   rate and body problems as non-200 — so the client must inspect both.
5. Scope mapping: the *Payload key* is the authority. Bizamiz's own scopes cannot
   widen it, and it must not reuse a platform-wide CMS credential for a tenant's
   assistant.
6. Result surfacing: tool output is text; `cms_describe_capabilities` is the intended
   first call so the model knows what exists before it guesses.

Until that client exists, a Bizamiz agent cannot call these tools, and this repository
cannot change that. Nothing in the P0 acceptance criteria above depends on it.

---

## 9. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` on every request | Wrong header shape (`Authorization: Bearer …`, capital A), a key from another collection (site/API keys are a different family), an expired `expiresAt`, or the key row was deleted. |
| `404` on `/api/mcp` | The request landed on a **customer** domain. MCP is only on the control-plane host (§2). |
| `413` | Body above `MCP_MAX_BODY_BYTES`. |
| `429` | Above `MCP_RATE_LIMIT` for this key in the current minute. |
| Tool listed but "not found" when called | The tool belongs to another collection. Call `cms_describe_capabilities` — the list is per key. |
| `findX` returns nothing but the admin shows documents | The key's user is not a member of that site, or the documents are drafts and the key's role reads published content only. |
| Create fails with “invalid field: site” / «سایت اختصاص‌یافته» | The `site` argument is missing or names a site the key's user does not belong to. |
| Create of a page fails on `layout` | `layout` is a required blocks array; send at least one block, or create drafts through the admin. |
| Everything times out | The dev server is hung; see the Playwright note in `CLAUDE.md`. |

---

## 10. Security summary

- HTTPS in production; the endpoint is on the control-plane host only.
- Credential = a Payload API key bound to one user; no shared platform credential.
- Authorization evaluated at tool-execution time by Payload access control, with
  `overrideAccess: false` everywhere.
- Tenant isolation enforced by the multi-tenant plugin, not by tool arguments.
- Destructive operations are not available at all.
- Sensitive collections are absent from the matrix rather than merely unticked.
- Key lifetime, per-key rate limit and body cap enforced on the request.
- Audit rows for mutations, naming the key and never the payload.
- Error text returned to clients is coarse; details go to the server log.
- No secret ever reaches a client bundle: capability groups are read server-side, and
  the key is masked by Payload's field access.

---

## 11. What this repository adds

| File | Role |
| --- | --- |
| `src/mcp/capabilities.ts` | The matrix, the tool names and the discovery surface — one source for the plugin config, the discovery tool and the tests. |
| `src/mcp/auth.ts` | `overrideAuth`: body cap, expiry, rate limit, attribution on `req.context`. |
| `src/mcp/limits.ts` | Per-key window and body-size assertion, both env-tunable per call. |
| `src/mcp/context.ts` | What the request gate hands custom tools; an allowlist, never the key document. |
| `src/mcp/result.ts` | The `{ ok, data }` / `{ ok: false, error }` envelope and the coarse refusal writer. |
| `src/mcp/tools/` | The three read-only tools. |
| `src/plugins/mcp.ts` | Plugin wiring: matrix, instructions, `expiresAt`, gate. |
| `src/plugins/mcpAudit.ts` | `audit-log` rows for MCP writes. |
| `src/migrations/20261122_120000_mcp_key_expiry_and_audit_event.ts` | `expires_at` column and the `mcp.contentChanged` enum values. |
| `tests/int/mcp*.int.spec.ts` | Matrix, gate and custom tools without a database. |
| `tests/e2e/mcp.e2e.spec.ts` | The real endpoint through the official MCP SDK client. |
