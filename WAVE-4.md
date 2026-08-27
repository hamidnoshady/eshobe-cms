# Wave 4 deployment: custom domains and TLS

## DNS

For each site, enter the hostname only (for example `www.client.example.com`), then create either:

- an **A** record pointing to the server's public IPv4 address, or
- a **CNAME** record pointing to the deployment hostname.

Do not enter `https://`, a port, or a path. Wait for DNS propagation before marking **دامنه تأیید شده** in the Sites admin panel. Unverified, inactive, and unknown domains receive no certificate authorization.

## Production deployment

Set these values in the production environment:

```dotenv
CONTROL_PLANE_HOST=admin.example.com
ACME_EMAIL=ops@example.com
DATABASE_URL=postgres://eshobe:password@db:5432/eshobe
PAYLOAD_SECRET=long-random-secret
POSTGRES_PASSWORD=another-long-random-secret
CRON_SECRET=long-random-secret-2
PREVIEW_SECRET=long-random-secret-3
```

`NEXT_PUBLIC_SERVER_URL` is derived from `CONTROL_PLANE_HOST` and passed as a **build arg** — it is inlined into client bundles and the CSP `frame-ancestors` header at build time, so changing the control-plane host requires an image rebuild, not just a restart.

Customer uploads live in the `media_uploads` volume (mounted at `/app/media`, `MEDIA_DIR`); include it in the backup policy alongside `pgdata` and `caddy_data`.

The control-plane hostname is the only host allowed to access `/admin*` and `/api*`. Customer hosts are routed to the public site and those paths return 404, with two carve-outs the public site itself depends on: `POST /api/form-submissions` (the Wave 3 contact form posts from the customer's own origin) and `GET /api/media/file/*` (locally stored uploads). Port 80 redirects every host to HTTPS. Caddy stores certificates in the `caddy_data` volume; back it up as part of the deployment backup policy.

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy calls `http://web:3000/api/domain-check?domain=...` before on-demand issuance. A `200` authorizes issuance; a `404` refuses it without retry authorization. The endpoint is deliberately uncached, and it is only reachable over the internal Docker network — the control-plane vhost returns 404 for it, so outsiders cannot enumerate configured domains.

## Database migrations

Development keeps Payload's push mode, but the production image runs `node server.js` with no CLI step, so the Postgres adapter is configured with `prodMigrations`: in production, pending migrations from `src/migrations` run automatically on startup before the app serves traffic. After any schema change, regenerate the migration set:

```sh
pnpm payload migrate:create <name>
```

and commit the files in `src/migrations`.
