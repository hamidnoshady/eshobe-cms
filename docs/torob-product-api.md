# Torob Product API v3 on a managed CMS site

Issue #183 / Biza Miz #894 Wave 3. A Biza Miz managed website served by this CMS answers
Torob's crawler **from the shop's own origin**, independently of the Growth UI:

```http
POST https://<site-domain>/torob/v1/products
X-Torob-Token: <EdDSA JWT minted by Torob>
X-Torob-Token-Version: 1
Content-Type: application/json

{ "page": 1, "sort": "date_added_desc" }
```

There is no second Torob dashboard in the CMS. Growth owns the merchant lifecycle;
the CMS stores a hidden, platform-only enrollment projection and serves the catalogue.

## Discovery and configuration (Biza Miz)

1. Resolve the CMS site id for the shop (the platform already knows it from provisioning).
2. Read the endpoint and audience the CMS will enforce:

   ```http
   GET /api/platform/sites/<siteId>/torob
   Authorization: Bearer <platform key>
   ```

   ```json
   {
     "ok": true,
     "audience": "shop.example.com",
     "endpoint": "https://shop.example.com/torob/v1/products",
     "enrollment": {
       "connected": false,
       "enabled": false,
       "authorizationState": "not_authorized",
       "shopId": null,
       "syncedAt": null
     }
   }
   ```

3. After the merchant authorizes the channel in Growth, sync the **full** state:

   ```http
   PATCH /api/platform/sites/<siteId>/torob
   Authorization: Bearer <platform key>
   Content-Type: application/json

   {
     "connected": true,
     "enabled": true,
     "authorizationState": "authorized",
     "shopId": "<biza-miz shop id>"
   }
   ```

   `authorizationState` is one of `not_authorized | pending_approval | authorized | revoked`.
   A partial patch is refused, so a disconnect cannot leave a stale `enabled: true`.
   `POST /api/platform/sites/<siteId>/torob/disconnect` resets the projection to the
   fail-closed default.

4. Register `endpoint` with Torob. The token audience is the site's stored canonical
   `domain` (`audience` above), never a forwarded or request `Host` header.

Changing the site's domain resets the enrollment until Biza Miz re-syncs it: the old
audience must not keep serving under a new hostname.

## Runtime gates (in order)

1. Tenant from the socket `Host`; unknown/control-plane host → `404 { "error": "not_found" }`.
2. Local enrollment must be `connected && enabled && authorizationState === "authorized"`,
   and the site must be an `active` `store`; otherwise the same `404`.
3. `X-Torob-Token` verified as EdDSA/Ed25519 with `X-Torob-Token-Version: 1`, checking
   `aud`, `exp`, `nbf` against the stored domain. Failure → `401 { "error": "unauthorized: <reason>" }`.
4. Body ≤ 256 KB, exactly one of `page_urls`, `page_uniques`, `page + sort`, `cursor + sort`.
   Torob's exact documented 400 sentences are returned; there is no default page.
5. Only then is the published, site-scoped catalogue read.

Per-host throttle: 5 requests/second → `429 { "error": "too_many_requests" }`.
Non-POST → `405 { "error": "method_not_allowed" }`.

## Catalogue rules

- Only `_status: published` rows of this site; drafts/removed rows are absent (a direct
  lookup answers `total: 0`, not an out-of-stock record).
- Prices are integer Toman from the site's Store currency (`IRT` as-is, `IRR` exactly ÷10).
  Unsupported currencies and non-whole Toman are omitted, never rounded.
- Unavailable ⇒ `availability: false, current_price: 0`. An available zero-price row is
  omitted because CMS checkout cannot sell it; `true + 0` would mean free to Torob.
- Variable products publish one page per active variation (`?variant=<key>`) with
  `product_group_id`; the storefront selects that exact variation at checkout.
- Images are the original public upload URLs on the site origin, with stored dimensions
  ≥ 600×600 (900×900 recommended). SVGs, thumbnails, foreign-site media and private IP
  literals are never sent. No outbound image fetch happens per crawl.
- 100 products/page; deterministic `date_added_desc`, `date_updated_desc`, `product_id_desc`;
  opaque stable cursor over `product_id_desc`; direct URL/unique lookups are exact.

## Contract fixtures

`tests/fixtures/torob-product-api-v3/` holds the language-neutral cases shared with the
Biza Miz platform runtime (provenance and sync rules in that directory's README).
`tests/int/torob.int.spec.ts` runs them against the CMS implementation;
`tests/int/torob-api.int.spec.ts` proves the tenant boundary on a real database.

## Operations

- Optional `TOROB_API_PUBLIC_KEY` overrides Torob's published verification key (PEM or
  bare base64). An unusable configured key fails closed with `401 invalid_token`.
- Migration `20261104_120000_torob_product_api` adds the fail-closed `sites.torob_*` columns.
- Caddy carves out exact `POST /torob/v1/products` before the theme upstream, and the
  control-plane host answers `404` for `/torob*`.
