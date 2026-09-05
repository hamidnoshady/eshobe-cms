# Tenant domains and subdomains

Each **Site** is a tenant. A tenant may own one canonical hostname and up to 20
aliases; each alias must be verified before it can serve traffic. Hostname ownership is global across the CMS: no primary domain,
`www` name, campaign subdomain, or legacy domain can be attached to two sites.

## In the CMS

Open **Sites → a site**:

1. Enter the public canonical hostname in **دامنهٔ اصلی**. It may be an apex
   domain such as `acme.ir` or a subdomain such as `shop.acme.ir`. Do not include
   `https://`, a port, or a path.
2. Add `www.acme.ir`, `old-acme.ir`, `campaign.acme.ir`, and similar names under
   **دامنه‌ها و زیردامنه‌های فرعی** as needed.
3. Point each name in DNS to the production server.
4. A platform administrator checks the matching verification box only after the
   DNS record is in place. Caddy then obtains TLS on the first HTTPS request.

The primary hostname is the sole public URL emitted by the CMS: previews,
canonical tags, OG URLs, `robots.txt`, and sitemaps all use it. A verified alias
preserves the requested path and query string but responds with a permanent 308
redirect to the primary hostname. This prevents duplicate indexing and split
analytics. Pending aliases do not resolve a tenant and cannot request a
certificate.

Changing the primary hostname clears **دامنهٔ اصلی تأیید شده** automatically;
changing the hostname in an existing alias clears that alias's verification. The
new hostname must be checked again before it can receive TLS.

> DNS verification is intentionally a platform-admin action. A tenant can request
> an alias, but cannot turn an arbitrary `Host` header into an ACME certificate
> request.

## Tenant API (site API key)

A headless tenant can maintain *pending* aliases with its own `role: "site"` API
key. Send the key as `Authorization: Bearer eshobe_live_…`. A browser client calls
its tenant host; a trusted off-domain backend may call the control-plane API with
the same key. In both cases the application resolves the tenant from the key and
verifies it again.

```http
GET /api/site/domains
```

```json
{
  "primary": { "hostname": "acme.ir", "verified": true },
  "aliases": [{ "hostname": "www.acme.ir", "verified": true }]
}
```

```http
POST /api/site/domains
Content-Type: application/json
Authorization: Bearer eshobe_live_…

{ "hostname": "shop.acme.ir" }
```

The new alias is always returned as `verified: false`. A platform administrator
must verify it in the CMS after DNS is configured.

```http
DELETE /api/site/domains
Content-Type: application/json
Authorization: Bearer eshobe_live_…

{ "hostname": "shop.acme.ir" }
```

To change the canonical hostname, keep using the existing dedicated operation:

```http
PATCH /api/site/domain
Content-Type: application/json
Authorization: Bearer eshobe_live_…

{ "domain": "new-acme.ir" }
```

An alias cannot be promoted accidentally. Remove it first, then set it as the
primary hostname; this keeps the global hostname uniqueness rule intact.

## DNS and production proxy

The production Caddy configuration already has one catch-all customer-host block
and on-demand TLS. It calls the internal `GET /api/domain-check?domain=…` endpoint
before asking a certificate authority for any hostname. That endpoint returns 200
only when the hostname belongs to an **active, verified** tenant record; it is not
publicly exposed on the control-plane host.

For DNS:

- Use an **A/AAAA** record to the server IP for an apex domain (`acme.ir`) when
  your DNS provider requires it.
- Use a **CNAME** to the platform's public hostname, or an A/AAAA record to the
  server IP, for `www`, `shop`, and other subdomains.
- Do not point wildcard DNS at the server unless every individual hostname is
  still registered and verified in the CMS. Wildcard DNS alone does not authorise
  certificates: the Caddy ask endpoint is the authority.
- Keep the control-plane hostname (`CONTROL_PLANE_HOST`) out of tenant domains.

Development uses `*.localhost` names such as `acme.localhost`. They can be used
as a primary or alias for routing tests, but are intentionally never authorised
for public ACME TLS.

## Built-in CDN control plane (Cloudflare and ArvanCloud)

The platform includes CDN management in **زیرساخت → zoneهای CDN**. It is not a Payload plugin and it does not run in the tenant-facing API. A CDN provider token can create DNS records, change TLS and block traffic, so only authenticated platform administrators (superadmins) can save a connection, run a sync or purge cache. API keys of every kind, tenant users and customers cannot access it.

### One active edge provider per zone

Choose **either Cloudflare or ArvanCloud for a zone**. They are alternative authoritative DNS/reverse-proxy providers; routing one hostname through both is not a supported or safe configuration. A site can use a separate CDN zone for each independently delegated DNS zone, but each DNS zone may only belong to one CMS site.

### Safe setup sequence

1. Add the CDN zone with `active` off and enter a least-privilege provider token. The token is AES-256-GCM encrypted using `CDN_INTEGRATIONS_KEY` (or, as a fallback, `PAYLOAD_SECRET`), is write-only, and is never returned by the admin, REST, GraphQL or tenant APIs. Use a distinct `CDN_INTEGRATIONS_KEY` of at least 32 random characters in production.
2. Run `POST /api/cdn/sync` from an authenticated superadmin session with `{ "id": "<zone UUID>" }`. While inactive this only discovers the remote zone and its nameservers; it does not change DNS, TLS, cache or security settings.
3. If the zone does not exist, review the provider account and nameserver change, then explicitly select **ساخت خودکار zone اگر وجود ندارد** and activate the row. Cloudflare zone creation also requires its Account ID. Update registrar nameservers only after the provider reports them.
4. Add only the DNS records the CMS owns. The sync updates records whose provider IDs were previously recorded by CMS. It never deletes a remote record simply because a row was removed from the CMS, and Cloudflare records are marked `eshobe-cms:<zone>:<row>` so manually managed rules are not overwritten.
5. Confirm the canonical tenant domain in **سایت‌ها** only after DNS is live. Caddy's existing verified-domain control remains the source of truth for origin TLS/routing; CDN activation never makes an unverified tenant hostname routable.

A proxied record is limited to `A`, `AAAA` and `CNAME`, which carry HTTP/HTTPS only. MX, TXT and CAA records are rejected before an API call rather than being accidentally put behind the CDN.

### TLS, caching and security

- Use **Full (strict)** unless the provider and origin are deliberately configured otherwise. The Caddy origin needs a valid certificate for the hostname. CDN edge TLS does not eliminate the origin's TLS requirement.
- HSTS must be enabled only after every affected hostname works over HTTPS. In particular, `includeSubdomains` and preload are hard to reverse for browsers.
- The default caching policy respects origin `Cache-Control`. The CMS does not cache HTML, `/admin`, `/api`, or cookie-bearing responses by default. The optional static-assets policy only manages `/_next/static` and `/media` and leaves customer-created rules intact.
- A whole-zone purge is `POST /api/cdn/purge` with `{ "id": "<zone UUID>" }`; URL purge adds `"urls": ["https://example.com/media/a.jpg"]`. These responses are `Cache-Control: no-store`. Every sync/purge leaves a safe, immutable outcome in **رویدادهای CDN**; it contains action summaries only, never provider tokens or upstream response bodies.
- General TLS, HTTP redirect, Cloudflare zone security level, Arvan WAF mode and Arvan DDoS challenge mode are reconciled as configured. Custom firewall/WAF rules are owned by CMS only when the relevant entitlement is explicitly confirmed.

### Plans, premium capabilities and origin protection

Provider plans and token permissions vary. The **قابلیت‌ها و entitlement پلن** checkboxes are deliberately opt-in evidence that the platform has purchased/confirmed a capability. Without the relevant entitlement, advanced cache behavior that ignores cookies and custom WAF/firewall rules are reported as **blocked**, not silently attempted or claimed successful. This lets future platform premium plans use the same capability model without granting a paid provider feature by mistake.

Cloudflare API tokens should be scoped to the one zone and only the permissions needed (DNS edit, Zone settings edit, Cache purge, and Rulesets/WAF edit only if used). ArvanCloud uses the CDN API key associated with that domain/account. Rotate either token by entering a new value; leave the field empty to retain the prior encrypted value, or use the explicit clear checkbox to remove it.

Finally, CDN proxy mode does **not** itself prevent direct requests to the origin IP. At the network firewall/load-balancer layer, allow only Cloudflare or ArvanCloud published edge ranges (plus required health-check/administration paths) to reach ports 80/443. Keep that list maintained from the provider's official IP ranges; do not trust a client-supplied `X-Forwarded-For` header.
