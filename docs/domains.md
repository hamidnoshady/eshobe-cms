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
