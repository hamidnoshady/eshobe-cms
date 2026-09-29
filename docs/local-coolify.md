# Local Coolify — deploying a theme on your own machine

How the theme-deployment pipeline ([`theme-deployments.md`](./theme-deployments.md)) runs end to
end on Windows + Docker Desktop: a real Coolify, a real Traefik proxy, the real published GHCR
image, and the CMS running on the host.

```
browser ──► studio.localhost:80 ──► Traefik (coolify-proxy) ──► theme container ──┐
                                                                                   │ ESHOBE_CMS_URL
browser ──► studio.localhost:3000 ──► CMS (pnpm dev, on the host) ◄────────────────┘ host.docker.internal:3000
                  │  Coolify API  http://localhost:8000
                  └──────────────► Coolify ──ssh──► coolify-testing-host ──docker.sock──► Docker Desktop
```

## What lives where

| Piece | Where |
|---|---|
| Coolify stack (`coolify`, `coolify-db`, `coolify-redis`, `coolify-testing-host`, proxy, sentinel) | `D:\Development\coolify-local` — **outside** this repo, git-ignored, its `.env` holds the admin login and `api-token.txt` the API token |
| Coolify UI | <http://localhost:8000> |
| CMS | `pnpm dev` → <http://localhost:3000> (the `.claude/launch.json` entry `eshobe-cms`) |
| CMS Postgres | `docker compose up -d db` → `127.0.0.1:5433` |
| A theme on its customer domain | <http://studio.localhost/> (port 80, Traefik) |

## Bring it up

```bash
docker compose -f D:/Development/coolify-local/docker-compose.yml up -d   # Coolify (restart: always)
docker compose up -d db                                                   # CMS database
pnpm dev                                                                  # CMS
```

First time only, once Coolify is healthy and the CMS is running:

```bash
pnpm seed:demo      # Persian pages, posts, products and generated images for all three dev sites
pnpm dev:coolify    # projects + deploy target + Graphite package + artifact + slot bindings
```

then deploy from the site's «استقرار پوسته» tab, or over the API
(`POST /api/platform/sites/:id/deployment` with `{ "lane": "preview" | "production", "package": "graphite" }`).

## The `.env` switches that make a local proxy work

| Variable | Why |
|---|---|
| `DEPLOY_CMS_URL=http://host.docker.internal:3000` | `NEXT_PUBLIC_SERVER_URL` is `localhost:3000`, which inside a container is the container. |
| `DEPLOY_PUBLIC_SCHEME=http` | `*.sslip.io` / `*.localhost` cannot get a certificate. Coolify domains, the health check, `ESHOBE_PUBLIC_ORIGIN`, the renderer webhook and the preview link all follow it. Unset in production. |
| `ESHOBE_THEME_ARTIFACT_SECRET` | Signs the artifact registration callback `pnpm dev:coolify` sends (what CI does upstream). |

`vitest.setup.ts` clears the first two so the suite still asserts the production (https) behaviour.

## Things that are different from production

- **The deployed image is whatever `main` last published to GHCR**, not your working tree. The CMS
  refuses any image that is not the package's configured `ghcr.io/…` repository (`GHCR_IMAGE_PATTERN`),
  so a local `docker build` cannot be deployed. Push the theme, let its CI publish, re-run
  `pnpm dev:coolify` (or register the new digest) and redeploy.
- **The customer domain is `studio.localhost`.** Chromium and `curl` resolve `*.localhost` to
  loopback; Node does not on Windows. The health check therefore probes the application's own
  `*.127.0.0.1.sslip.io` hostname (which the app claims alongside the customer domain in `direct` mode).
- **A production publish stops the site's preview**, as designed — deploy a preview again to see one.
- `coolify-testing-host` is built from `D:\Development\coolify-local\th\Dockerfile`: the upstream
  image is not published, and `download.docker.com` / GitHub releases are unreachable from a build here,
  so the docker CLI, compose and buildx are copied from `docker:28-cli`. Its `authorized_keys` carries
  Coolify's built-in *Testing-host* public key — the private half is the one Coolify seeds into its own
  database. If Coolify shows the server unreachable, that pair no longer matches.
- Coolify's realtime port (6001) is not served by this image, so the compose health check only asks
  `:8080`. The UI works; pages just do not live-update — refresh.
- **Run the int suite on its own database, and recreate it before a full run.** `create database eshobe_test`,
  `DATABASE_URL=…/eshobe_test pnpm seed`, then `pnpm test:int`. The suite expects the vanilla seed (it would
  otherwise rewrite the demo data), and it leaves rows behind — the billing outbox specs read a fixed-size
  batch, so a second full run on a used database fails them (`billing.int.spec.ts`, "usage outbox").
