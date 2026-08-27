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
DATABASE_URL=postgres://eshobe:password@db:5432/eshobe
PAYLOAD_SECRET=long-random-secret
POSTGRES_PASSWORD=another-long-random-secret
```

The control-plane hostname is the only host allowed to access `/admin*` and `/api*`. Customer hosts are routed to the public site and those paths return 404. Caddy stores certificates in the `caddy_data` volume; back it up as part of the deployment backup policy.

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy calls `http://web:3000/api/domain-check?domain=...` before on-demand issuance. A `200` authorizes issuance; a `404` refuses it without retry authorization. The endpoint is deliberately uncached.
