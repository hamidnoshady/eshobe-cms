# Wave 4 deployment: custom domains and TLS

## DNS

For each site, enter the hostname only (for example `www.client.example.com`), then create either:

- an **A** record pointing to the server's public IPv4 address, or
- a **CNAME** record pointing to the deployment hostname.

Do not enter `https://`, a port, or a path. Wait for DNS propagation before marking **دامنه تأیید شده** in the Sites admin panel. Unverified, inactive, and unknown domains receive no certificate authorization.

## Production deployment

**On srv1 / Komodo use [README's deployment procedure](./README.md#production-deployment-srv1--komodo)
and `docker-compose.srv1.yml` only.** The generic Caddy deployment described here
is for a dedicated host; it must not bind 80/443 on srv1 alongside OpenLiteSpeed.

Set these values in the production environment:

```dotenv
CONTROL_PLANE_HOST=admin.example.com
ACME_EMAIL=ops@example.com
DATABASE_URL=postgres://eshobe_app:<runtime-password>@db:5432/eshobe
MIGRATE_DATABASE_URL=postgres://eshobe:<owner-password>@db:5432/eshobe
PAYLOAD_SECRET=long-random-secret
POSTGRES_PASSWORD=another-long-random-secret
CRON_SECRET=long-random-secret-2
PREVIEW_SECRET=long-random-secret-3
```

`NEXT_PUBLIC_SERVER_URL` is derived from `CONTROL_PLANE_HOST` and passed as a **build arg** — it is inlined into client bundles and the CSP `frame-ancestors` header at build time, so changing the control-plane host requires an image rebuild, not just a restart.

Customer uploads live in the `media_uploads` volume (mounted at `/app/media`, `MEDIA_DIR`); include it in the backup policy alongside `pgdata` and `caddy_data`.

The control-plane hostname is the only host allowed to access `/admin*` and `/api*`. Customer hosts are routed to the public site and those paths return 404, with three carve-outs the public site itself depends on: `POST /api/form-submissions` (the Wave 3 contact form posts from the customer's own origin), `/api/checkout` and `/api/checkout/*` (the Wave 7 storefront's purchase POST, the buyer's return from the gateway and the gateway's callback — all on the customer's own origin, which is how the payment is attributed to the right site), and `GET /api/media/file/*` (locally stored uploads). Port 80 redirects every host to HTTPS. Caddy stores certificates in the `caddy_data` volume; back it up as part of the deployment backup policy.

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy calls `http://web:3000/api/domain-check?domain=...` before on-demand issuance. A `200` authorizes issuance; a `404` refuses it without retry authorization. The endpoint is deliberately uncached, and it is only reachable over the internal Docker network — the control-plane vhost returns 404 for it, so outsiders cannot enumerate configured domains.

## Database migrations

Development keeps Payload's push mode. Production **never runs migrations during
app startup**: web runs `node server.js` with the restricted `DATABASE_URL`, and
the separate `pnpm migrate` command uses the privileged `MIGRATE_DATABASE_URL`
without any fallback. On srv1, Compose runs the one-shot `migrate` service from
the same image and blocks web until it exits successfully. On other deployments,
run the migration command in a separate step before starting web; the generic
Caddy compose file does not orchestrate this for you. See README for the two-role
grants, image tradeoff and failure/retry procedure.

After any schema change, regenerate the migration set:

```sh
pnpm payload migrate:create <name>
```

and commit the files in `src/migrations`.
