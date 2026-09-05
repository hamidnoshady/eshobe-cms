# Built-in IRPower / ResellerArea domain reseller

The CMS contains a server-side adapter for the [IRPower ResellerArea API document](https://reseller.irpower.com/files/resellerarea-api.pdf). The platform owns the registrar account. A site owner uses a site API key against the CMS; they never receive the platform's `X-Api-Key`, endpoint credential, or another tenant's rows.

## Important limits of the supplied provider contract

The supplied ResellerArea document describes the following registrar commands:

- `RegisterDomain`, `TransferDomain`, `RenewDomain`;
- `GetDomainNameServers`, `UpdateDomainNameServers`;
- `GetDomainLockStatus`, `UpdateDomainLockStatus`, `GetDomainTransferCode`;
- child nameserver add/update/remove;
- `GetContactInfo`, `IsValidTransfer`, `GetDomainWhoisInfo`, and `UpdateDomainWhoisInfo`.

It does **not** describe commands for availability search, TLD/wholesale price lookup, domain expiry, or order/provisioning status. The CMS consequently does not claim to know those facts:

- `GET /api/site/registrar/quote` returns `availability: "unknown"` unless the name is already in this platform's own workflow. It means “not checked by the documented provider API”, not “available globally”. The actual registrar request remains the authority.
- A superadmin maintains the wholesale annual price in the global **کاتالوگ TLDهای نمایندگی** collection. The CMS applies the global registration/transfer/renewal margin configured in **نمایندگی دامنه** and snapshots both cost and selling price when a request is made.
- A `success: true` from `RegisterDomain`, `TransferDomain`, or `RenewDomain` becomes `providerAccepted`, not `active` and not `paid`. The provider contract does not give a status/expiry confirmation command. A platform operator may set a domain to `active` after independently verifying it.

When IRPower supplies availability, price, expiry, or status commands, add them to `src/domain-reseller/service.ts` and replace the manual/unknown projections above; do not infer endpoint names from a different reseller API.

## One-time platform setup

1. Sign in as a platform admin and open **زیرساخت → نمایندگی دامنه**.
2. Enter the IRPower/ResellerArea HTTPS endpoint (the documented default is `https://resellerarea.net/api`) and the platform `X-Api-Key`. For credential-exfiltration protection, the CMS accepts only `resellerarea.net`/its subdomains or `irpower.com`/its subdomains.
3. Enter three global profit percentages: registration, transfer, and renewal. They apply to all sites.
4. Add each sellable suffix to **زیرساخت → کاتالوگ TLDهای نمایندگی**, with its annual wholesale registration, transfer, renewal costs and currency.
5. Only then turn on **فروش دامنه فعال است**.

The API key is AES-256-GCM encrypted at rest. Its form field is write-only after saving, it is omitted from normal Local/REST/GraphQL reads, and only `resellerConfiguration()` temporarily obtains the plaintext immediately before a server-to-server call. Set `DOMAIN_RESELLER_KEY` to use a dedicated sealing key; otherwise the deployment's `PAYLOAD_SECRET` is used.

## Tenant API

Every route below requires `Authorization: Bearer <site API key>`. A platform key is deliberately not accepted; no request accepts a `site` id in its body.

### Quote/search workflow

```http
GET /api/site/registrar/quote?domain=example.ir&operation=register&period=1
Authorization: Bearer eshobe_live_...
```

`operation` is one of `register`, `transfer`, `renew`; `period` is an integer from 1 to 5. The result contains an honest availability state, a manual-catalogue quote, currency, source cost, applied margin, and final price. If the suffix is absent or disabled, the CMS refuses the request rather than guessing a price.

### Create and submit a billable request

```http
POST /api/site/registrar/domains
Authorization: Bearer eshobe_live_...
content-type: application/json

{
  "operation": "register",
  "domain": "example.ir",
  "period": 1,
  "nameservers": ["ns1.example.net", "ns2.example.net"],
  "contact": {
    "first_name": "…",
    "last_name": "…",
    "email": "…",
    "phone": "…",
    "address": "…",
    "city": "…",
    "state": "…",
    "postcode": "…",
    "country": "IR"
  },
  "fields": {
    "irnic_holder_handle": "…",
    "irnic_admin_handle": "…",
    "irnic_tech_handle": "…",
    "irnic_bill_handle": "…"
  }
}
```

`contact` and `fields` use the spelling documented by ResellerArea. For a `.ir` request, `irnicHandles` may also contain the documented IRNIC handle fields; the CMS merges it into provider `fields` (explicit `fields` values win). `TransferDomain` also accepts `eppCode`; it is forwarded as `epp_code` in that one provider request and is **never persisted, returned, or audited**. Register/transfer require one to five nameservers. Renewals use only the existing assigned domain, the period, and the price catalogue.

The selected policy is immediate submission: after the CMS creates its local request record it sends the provider command using the platform account. This can consume the platform reseller balance. The local operation still has `paymentState: "pendingIntegration"`; another payment platform must later connect a real payment/settlement state, and neither browser completion nor the registrar's successful command may be treated as payment confirmation.

Read the local safe lifecycle:

```http
GET /api/site/registrar/domains
GET /api/site/registrar/operations
Authorization: Bearer eshobe_live_...
```

A provider rejection becomes `failed`; no raw provider payload, contacts, platform key, or transfer authorization code is saved in the audit record.

### Manage an assigned domain

```http
POST /api/site/registrar/manage
Authorization: Bearer eshobe_live_...
content-type: application/json

{ "id": "<reseller-domain UUID>", "action": "nameservers.update", "nameservers": ["ns1.example.net", "ns2.example.net"] }
```

Only domains for the key's own site in `providerAccepted` or manually confirmed `active` state can be managed. Supported `action` values map directly to documented provider commands:

| CMS action | Provider command | Additional request fields |
| --- | --- | --- |
| `nameservers.get` | `GetDomainNameServers` | — |
| `nameservers.update` | `UpdateDomainNameServers` | `nameservers: string[]` |
| `lock.get` | `GetDomainLockStatus` | — |
| `lock.update` | `UpdateDomainLockStatus` | `lockStatus: boolean` |
| `transfer-code.get` | `GetDomainTransferCode` | — |
| `child-nameserver.add` | `AddDomainChildNameServer` | `nameserver`, `ip` |
| `child-nameserver.update` | `UpdateDomainChildNameServer` | `nameserver`, `currentIp`, `newIp` |
| `child-nameserver.remove` | `RemoveDomainChildNameServer` | `nameserver` |
| `irnic-contact.get` | `GetContactInfo` | `irnicHandle` |
| `transfer.validate` | `IsValidTransfer` | `transferType`, and for `OwnerTransfer`, `transferContacts.holder/admin/tech/bill` |
| `whois.get` | `GetDomainWhoisInfo` | — |
| `whois.update` | `UpdateDomainWhoisInfo` | `contacts.registrant/administrative/technical/billing` |

WHOIS contacts and a transfer code are returned only for this site's key and are not included in the safe event log. The API document contains conflicting field spellings in a few tables/examples; the adapter follows its cURL examples: `epp_code`, `transfer_type`, `irnic_handle`, `lock_status`, `current_ip`, `new_ip`, and `administrative`.

## Attaching a registered domain to the website

A registrar request does not give Caddy/TLS permission to serve a hostname. After the nameservers and DNS are verified, use the established site-domain workflow to add it as a pending alias or change the canonical hostname. A platform admin must verify the DNS/TLS mapping before the platform serves the new host. This separation prevents a pending transfer or failed registration from becoming a web-serving hostname.

## Operations and safety

- Collections `reseller-domains`, `reseller-domain-operations`, and `reseller-domain-events` are tenant-scoped through the multi-tenant plugin. The cross-site relationship check in the endpoint is an additional hard boundary.
- `domain-reseller-products` and the `domain-reseller` global are platform-admin only; a site's key sees a derived quote, never wholesale catalogue rows or margins.
- Management calls run only on the server and use `POST` JSON plus `x-api-key`, as prescribed by the provider document. Provider request bodies are not logged and cross-origin redirects are rejected rather than forwarding the API key.
- `DOMAIN_RESELLER_TIMEOUT_MS` limits a provider call (default 10 seconds; allowed range 1–60 seconds). A timeout becomes a failed local request that an operator can investigate safely.
