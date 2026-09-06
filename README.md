# eshobe-cms

Multi-tenant website platform on Payload 3 + Next.js. One deployment hosts many
customer sites (business / portfolio / store), each with its own domain, locales,
content and theme.

**Persian-first**: `fa` is the base locale, RTL is the default direction,
Vazirmatn is the only typeface, and every date renders in Shamsi (Jalali).

- Architecture and phasing → [`PLAN.md`](./PLAN.md)
- **srv1 / Komodo deployment** → [Production deployment](#production-deployment-srv1--komodo) below
- Other production infrastructure → [`WAVE-4.md`](./WAVE-4.md) (domains, TLS) and [`WAVE-6.md`](./WAVE-6.md) (R2, SEO, jobs, backups)
- Tenant domain, subdomain and alias operations → [`docs/domains.md`](./docs/domains.md)
- Built-in IRPower / ResellerArea domain-reseller setup and tenant API → [`docs/domain-reseller.md`](./docs/domain-reseller.md)
- The rules that bind the code → [`CLAUDE.md`](./CLAUDE.md)
- Per-wave operational notes → [`WAVE-4.md`](./WAVE-4.md) (domains, TLS, migrations),
  [`WAVE-7.md`](./WAVE-7.md) (the store: the ecommerce-plugin spike, its decision, and money),
  [`WAVE-9.md`](./WAVE-9.md) (the headless contract for a separately deployed site builder),
  [`WAVE-10.md`](./WAVE-10.md) (Iranian payment gateways: ZarinPal, Digipay, Snapp!Pay, Torob Pay)
- Payment gateway operator & headless guide → [`docs/payment-gateways.md`](./docs/payment-gateways.md)
- Waves are tracked as GitHub issues #1–#9 under #10

## Getting started

```bash
docker compose up -d db     # Postgres on 5433
cp .env.example .env        # then fill PAYLOAD_SECRET
pnpm install
pnpm dev                    # http://localhost:3000 — admin at /admin
```

Generate a real secret rather than reusing the dev placeholder:

```bash
openssl rand -base64 48
```

A production process refuses to start on a placeholder or short secret — see
[`WAVE-6.md`](./WAVE-6.md).

For multi-domain dev, Windows needs hosts entries — `*.localhost` does not
resolve on its own. Run once, as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-hosts.ps1
```

## Commands

| Command                        | What it does                                             |
| ------------------------------ | -------------------------------------------------------- |
| `pnpm dev`                     | Next + Payload in dev                                    |
| `pnpm test:int`                | Vitest integration tests                                 |
| `pnpm test:e2e`                | Playwright                                               |
| `pnpm typecheck`               | `tsc --noEmit`                                           |
| `pnpm generate:types`          | Regenerate `payload-types.ts` after config changes       |
| `pnpm payload migrate:create`  | After config changes, before deploy                      |
| `pnpm payload migrate:status`  | Read migration status via the runtime URL                |
| `pnpm migrate`                 | Apply pending migrations via `MIGRATE_DATABASE_URL` only |
| `./scripts/backup-postgres.sh` | Nightly database dump (production host)                  |
| `./scripts/backup-r2.sh`       | Nightly media copy to a second bucket                    |

Scaffolded from Payload's `website` template at v3.88.0, with the Mongo adapter
replaced by Postgres and the Latin-only fonts replaced by Vazirmatn.

## Production deployment (srv1 / Komodo)

**Use only `docker-compose.srv1.yml` on srv1.** Do not base it on
`docker-compose.prod.yml`: that file starts Caddy on host 80/443, which belong to
OpenLiteSpeed and live customer websites. Web stays on **`127.0.0.1:3001`**.
Keep Komodo's project name **`eshobe-cms`**, image **`eshobe-cms-web`**, and volume
keys **`pgdata` / `media_uploads`** unchanged. Changing the project/volume names
or running `down -v` can disconnect or destroy the live database and uploads.

### Two database roles, two connections

Both URLs target the **same database** (`db:5432/eshobe` inside Compose):

| Variable               | Role                      | Passed to      | Purpose                                      |
| ---------------------- | ------------------------- | -------------- | -------------------------------------------- |
| `DATABASE_URL`         | restricted `eshobe_app`   | `web` only     | Runtime data access, not schema ownership    |
| `MIGRATE_DATABASE_URL` | owner/privileged `eshobe` | `migrate` only | Apply committed schema migrations, then exit |

Set both in Komodo's deployment environment, together with the existing secrets
and `CONTROL_PLANE_HOST` (see `.env.example`). URL-encode passwords in connection
URLs. **Never replace web's `DATABASE_URL` with the privileged URL**, pass the
whole deployment `.env` through `env_file`, or pass either URL as a build arg.
The new variable is required: neither connection silently falls back to the other.

`eshobe` must own (or have the authority to alter) the existing schema objects,
including `enum_orders_payment_provider` and `enum_store_payment_provider`.
Do not fix ownership errors by making `eshobe_app` a superuser, granting it
membership in `eshobe`, or transferring schema ownership to it.

For an already-provisioned `eshobe_app`, verify these grants once in an
administrator SQL session connected to the application database. This gives it
DML access to existing **and future** tables created by `eshobe`, without DDL or
ownership rights:

```sql
GRANT CONNECT ON DATABASE eshobe TO eshobe_app;
GRANT USAGE ON SCHEMA public TO eshobe_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eshobe_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eshobe_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eshobe IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eshobe_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eshobe IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eshobe_app;
```

Default privileges are **per creating role**, not global. Without them migrations
can succeed while runtime queries against the new tables fail. Provision any new
runtime login separately as `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS`, and set its password via a secure admin session (e.g. psql's
`\password`), not a committed SQL file. The migrator does not create roles,
change ownership, or grant privileges automatically.

### Deploy / recover the crash-loop

1. Back up the database and uploads first. The backup script defaults to the
   generic production compose file; on srv1 explicitly select this one:

   ```sh
   COMPOSE_FILE=docker-compose.srv1.yml ./scripts/backup-postgres.sh
   ```

2. Set `MIGRATE_DATABASE_URL` in Komodo, retaining the restricted `DATABASE_URL`.
   Keep **Pre Build Images** enabled. For recovery or a maintenance deploy, stop
   the old/crash-looping web container first, leaving the database and volumes in
   place. Compose dependency conditions gate **new starts**; they do not stop an
   already-running old container:

   ```sh
   docker compose -f docker-compose.srv1.yml stop web
   docker compose -f docker-compose.srv1.yml up -d
   ```

   `web` owns the shared image build (also rebuilt/cached by `up`), then the order
   is **healthy db → migrate exits 0 → web starts**. The one-shot service has no
   restart policy, no published ports, no media mount, and the same resource/
   `no-new-privileges` limits as web. On the pre-wave10 database it applies
   `wave10_payment_gateways`, `tenant_domain_aliases`, `cdn_integration`, and
   `domain_reseller`, in order. Already-recorded migrations are skipped.

3. Verify completion and health without printing container credentials:

   ```sh
   docker compose -f docker-compose.srv1.yml ps -a
   docker compose -f docker-compose.srv1.yml logs --no-color migrate
   docker compose -f docker-compose.srv1.yml exec -T web node -e '
     if ("MIGRATE_DATABASE_URL" in process.env) process.exit(1);
     if (new URL(process.env.DATABASE_URL).username !== "eshobe_app") process.exit(1);
     console.log("Runtime role and credential isolation OK");
   '
   ```

   Expect `migrate` **Exited (0)** and `web` **healthy**. The healthcheck expects
   the domain-check endpoint's deliberate 404 for a missing domain, not an HTTP 500. For a failed migration, `migrate` exits non-zero and Compose refuses to
   start web. Fix the cause and rerun `up -d`; do not bypass dependencies with
   `--no-deps`, manually mark migrations applied, or enable boot-time migrations.
   Payload commits each migration separately: a failed migration rolls back, but
   earlier successful migrations remain recorded and are skipped on retry.

Outside Compose, use **`pnpm migrate`** with `MIGRATE_DATABASE_URL` and
`PAYLOAD_SECRET` in the command's environment. Serialize deployments/migration
jobs against the same database. Dev still uses `DATABASE_URL` and Payload's push
mode exactly as before; never point dev at production or migrate a push-created
database. The entrypoint rejects Payload's `batch = -1` dev marker without an
interactive prompt, and refuses `PAYLOAD_DROP_DATABASE=true`.

**Image tradeoff:** Next's standalone `node server.js` output alone has no Payload
CLI/TypeScript loader. The Dockerfile packages a separate `/app/migrator` tree
from the `migration-tools` stage with full dependencies, source, workspace
packages, and the entrypoint. Both services use the exact same final image; only
the one-shot process receives the privileged credential. This intentionally
increases image size (including development tooling) in exchange for one build/
tag and no runtime downloads or mismatched migrator/app releases. The default
command is still `node server.js`; it never launches migrations.

To run the Docker acceptance smoke test yourself, use a **clean CI/staging host,
never srv1**: build `eshobe-cms-web` with this Dockerfile, then run
`bash tests/deployment/compose-smoke.sh`. It uses synthetic credentials and a
separate disposable test project; it refuses a host with `eshobe-cms` containers
or production volumes. No tests modify the committed migration files.

**Credential rotation:** Komodo stores expanded `docker compose config` in deploy
logs **in plaintext**, including `MIGRATE_DATABASE_URL`. Treat those logs as
secret-bearing, restrict access/retention, and put this privileged credential on
the rotation list along with the credentials already exposed. Avoid printing
expanded config or `docker inspect` environment dumps in tickets/CI. Changing
`POSTGRES_PASSWORD` in Compose does not rotate a role in the existing `pgdata`;
change the actual database password securely and update the corresponding URL(s)
in Komodo together. No credential rotation is performed by this repo change.

## CI / CD

Two GitHub Actions workflows live under `.github/workflows/`:

- **`ci.yml`** — runs on every pull request to `main` and on every push to
  `main`. Jobs:
  - `lint` — `pnpm lint`
  - `typecheck` — `pnpm typecheck`
  - `build` — `pnpm build` with placeholder build-time env (matches the
    Dockerfile)
  - `docker-build` — builds/loads the production Docker image (Buildx + GHA
    cache, no push), then runs `tests/deployment/compose-smoke.sh`. On an isolated
    pre-wave10 Postgres database, the smoke test injects a broken migration to
    verify rollback and blocked web startup, then applies all pending migrations,
    waits for web health, checks runtime credential isolation, and verifies a
    second migration run is a no-op. It also checks the srv1 topology/hardening.
  - `test-int` — Vitest integration suites (`tests/int/**`) against a real
    Postgres 16 service container; `pnpm seed` creates the schema/data in
    dev/push mode before tests (separate from the migrated Docker smoke database)
  - `test-e2e` — Playwright suites (`tests/e2e/**`) against `pnpm dev`;
    uploads the Playwright HTML report as an artifact on failure
- **`publish.yml`** — runs after every merge to `main`, on `v*` tags, and on
  `workflow_dispatch`. Re-runs the lint/typecheck/build gates on the exact
  merge commit, then:
  - **Docker** — builds and pushes the image to
    `ghcr.io/<owner>/<repo>:<sha>` (long) and `ghcr.io/<owner>/<repo>:latest`
    on `main`. `vX.Y.Z` tags additionally push `X.Y.Z`, `X.Y`, and `X`.
    Provenance and SBOM are attached.
  - **npm** — publishes `@eshobe/site-runtime` (`packages/site-runtime`) to
    npm. Every push to `main` publishes a prerelease
    (`<version>-dev.<short-sha>`); a `vX.Y.Z` tag publishes that exact
    version as the stable release with npm provenance.

### Required repository configuration

- **Secrets**
  - `NPM_TOKEN` — an npm _Automation_ token with publish access to the
    `@eshobe` scope (needed by `publish.yml` → `npm-publish`).
- **Variables** (optional, under Settings → Variables → Actions)
  - `NEXT_PUBLIC_SERVER_URL` — the public control-plane URL baked into the
    Docker image at build time. Defaults to `http://localhost:3000` when
    unset (safe for staging / pre-DNS deploys).
- **Packages permissions** — `GITHUB_TOKEN` is used for GHCR; under
  Settings → Actions → General, set _Workflow permissions_ to
  _Read repository contents and packages permissions_ and enable
  _Allow GitHub Actions to create and approve pull requests_.
- **Branch protection on `main`** — add the following to _Required status
  checks_ before merge: `Lint`, `Typecheck`, `Build`, `Docker build`,
  `Integration tests`, `E2E tests`.
