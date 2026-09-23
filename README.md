# eshobe-cms

Multi-tenant website platform on Payload 3 + Next.js. One deployment hosts many
customer sites (business / portfolio / store), each with its own domain, locales,
content and theme.

**Persian-first**: `fa` is the base locale, RTL is the default direction,
Vazirmatn is the only typeface, and every date renders in Shamsi (Jalali).

- Architecture and phasing → [`PLAN.md`](./PLAN.md)
- **srv1 / Komodo deployment** → [Production deployment](#production-deployment-srv1--komodo) below
- Other production infrastructure → [`WAVE-4.md`](./WAVE-4.md) (domains, TLS) and [`WAVE-6.md`](./WAVE-6.md) (object storage, SEO, jobs, backups)
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
| `./scripts/backup-object-storage.sh` | Nightly media copy to a second bucket              |

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

Set both in Komodo's deployment environment, together with the existing secrets,
`CONTROL_PLANE_HOST` and **`APP_DATABASE_ROLE`** (the runtime role's name, e.g.
`eshobe_app` — see below). URL-encode passwords in connection URLs. **Never
replace web's `DATABASE_URL` with the privileged URL**, pass the whole
deployment `.env` through `env_file`, or pass either URL as a build arg. Both
variables are required: neither connection silently falls back to the other.

`eshobe` must own (or have the authority to alter) the existing schema objects.
Do not fix ownership errors by making `eshobe_app` a superuser, granting it
membership in `eshobe`, or elevating it to `CREATEDB`/`CREATEROLE`.

### Ownership model: the runtime role owns schema `public`

The srv1 database has **no explicit grants anywhere**: every pre-existing table
is owned by `eshobe_app`, `relacl` is NULL (owner-only access) and
`pg_default_acl` is empty. Keep that model — do not adopt a parallel GRANT-based
one. The one-shot migrator therefore finishes every successful run by handing
the whole of schema `public` to the runtime role:

- **`APP_DATABASE_ROLE`** tells the migrate step which role that is. It is never
  hardcoded or guessed: compose passes it explicitly (the `DATABASE_URL`
  username on srv1), while a bare `pnpm migrate` can export `DATABASE_URL`
  alongside `MIGRATE_DATABASE_URL` and let the role be derived from its
  username. If neither is available the step refuses to run.
- After Payload's transactional runner finishes, the step reassigns **tables,
  sequences, views (incl. materialised) and types** in `public` to the runtime
  role — including the **pre-existing enum types** still owned by the privileged
  role, which were the original reason migrations had to run privileged
  (`ALTER TYPE … ADD VALUE` needs ownership). Indexes and array/row types follow
  their owning object automatically. Objects already owned by the runtime role
  are skipped, so a re-run with nothing changed issues no DDL at all.
- A **verification gate** then fails the step (non-zero exit, so compose never
  starts `web`) if anything in `public` is left inaccessible to the runtime
  role — `SELECT` on tables/views, `USAGE`+`SELECT` on sequences, `USAGE` on
  types — or not owned by it. In particular this must stay 0:

  ```sql
  SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
    AND NOT has_table_privilege('<runtime role>', schemaname || '.' || tablename, 'SELECT');
  ```

- With the enums runtime-owned after the first normalised deploy, the root cause
  is gone: the restricted role could `ALTER TYPE` again. Migrations still run
  privileged by design — that is what lets the migrator fix ownership in the
  first place.

Provision any new runtime login separately as `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION NOBYPASSRLS`, and set its password via a secure admin
session (e.g. psql's `\password`), not a committed SQL file. The migrator does
not create roles or grant privileges; it only reassigns ownership of objects in
`public`.

### Deploy / recover the crash-loop

1. Back up the database and uploads first. The backup script defaults to the
   generic production compose file; on srv1 explicitly select this one:

   ```sh
   COMPOSE_FILE=docker-compose.srv1.yml ./scripts/backup-postgres.sh
   ```

2. Set `MIGRATE_DATABASE_URL` and `APP_DATABASE_ROLE=eshobe_app` in Komodo,
   retaining the restricted `DATABASE_URL`.
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
   `domain_reseller`, in order, then normalises `public` ownership to
   `APP_DATABASE_ROLE` and runs the accessibility gate. Already-recorded
   migrations are skipped; a re-run with nothing new reassigns nothing.

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
from the `migration-tools` stage with **production dependencies only** (the full
dev tree — playwright, vitest, typescript, eslint — once took the image from
411MB to 1.68GB on a host that also serves the live sites), source, workspace
packages, and the entrypoint; next's optional compile/test tooling
(`@next/swc`, `@playwright/test`) is pruned after install. Both services use the
exact same final image; only the one-shot process receives the privileged
credential. This still costs image size in exchange for one build/tag and no
runtime downloads or mismatched migrator/app releases — the remaining mass is
the genuine runtime graph (next, monaco via `@payloadcms/ui`, sharp, the Payload
ecosystem). The default command is still `node server.js`; it never launches
migrations.

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

Two GitHub Actions workflows live under `.github/workflows/`. Both run
automatically; `publish.yml` calls `ci.yml`, so there is exactly one definition
of "the tests pass" and the deployment uses it.

### `ci.yml` — the full suite, on every pull request

Also available as `workflow_dispatch`, and exposed as `workflow_call` so
`publish.yml` can reuse it. There is no `push` trigger on purpose: a merge to
`main` starts `publish.yml`, whose gate is this same workflow, so `main` is
covered on every merge without running the suite twice. Jobs:

- `lint` — `pnpm lint`
- `typecheck` — `pnpm typecheck`
- `build` — `pnpm build` with placeholder build-time env (matches the
  Dockerfile), then fails if the committed Payload import map is stale
- `docker-build` — builds/loads the production Docker image (Buildx + GHA
  cache, no push), then runs `tests/deployment/compose-smoke.sh`. On an isolated
  pre-wave10 Postgres database, the smoke test injects a broken migration to
  verify rollback and blocked web startup, then applies all pending migrations,
  waits for web health, checks runtime credential isolation, and verifies a
  second migration run is a no-op. It also checks the srv1 topology/hardening.
- `test-int` — Vitest integration suites (`tests/int/**`) against a real
  Postgres 16 service container; `pnpm seed` creates the schema/data in
  dev/push mode before tests (separate from the migrated Docker smoke
  database). Then the ownership replay (`tests/deployment/ownership.ts`) on its
  own scratch database.
- `test-e2e` — Playwright suites (`tests/e2e/**`) against `pnpm dev`;
  uploads the Playwright HTML report as an artifact on failure
- `ci-success` — the aggregate gate. It `needs` every job above and fails if any
  of them is not `success` (a cancelled or skipped job is not a pass). **Require
  this one check in branch protection**, not the six individually:
  `tests/int/ci-workflows.int.spec.ts` asserts its `needs` list equals every
  other job in the file, so a new job cannot silently fall outside the gate.

A run on a pull request is cancelled when the branch is force-pushed; a run
called by `publish.yml` is never cancelled, because a deploy is waiting on it.

### `publish.yml` — build, test, publish to GHCR

Runs on every push to `main`, on `v*` tags, and on `workflow_dispatch`. It must
stay automatic: **Coolify watches `ghcr.io/<owner>/<repo>:latest` and deploys it
by itself**, so a merge that publishes nothing leaves production running the
previous image while appearing to have shipped.

1. **`ci`** — `uses: ./.github/workflows/ci.yml`. Nothing below runs unless the
   entire suite is green on this exact commit.
2. **`docker-publish`** — builds and pushes to `ghcr.io/<owner>/<repo>:<sha>`
   (long) and `ghcr.io/<owner>/<repo>:latest` on `main`. `vX.Y.Z` tags
   additionally push `X.Y.Z`, `X.Y`, and `X`. Provenance and SBOM are attached.
   It then pulls each published tag back with `docker buildx imagetools inspect`
   and fails if the digest is not the one it just pushed, and writes a job
   summary recording the digest, commit and tags.

**There is no deploy job.** This repo holds no Coolify URL, token or service
UUID, and sends no webhook. Coolify is responsible for noticing the new
`:latest` and rolling the service; this workflow is responsible for never
publishing a `:latest` that should not be deployed.

That split is why `docker-publish` needs the *whole* suite rather than a subset:
nobody presses a button between a green merge and production, so CI is the last
gate there is. `tests/int/ci-workflows.int.spec.ts` asserts `publish.yml` has
exactly the jobs `ci` and `docker-publish`, so adding a deploy job back is a
visible decision.

The pull-back check exists for the same reason. `docker/build-push-action`
reporting success means the upload completed, which is not the same as "GHCR
serves a manifest Coolify can pull" — without a human in the loop, a
half-propagated manifest or a tag moved by a concurrent publish would otherwise
be discovered by Coolify pulling it into production.

### Required repository configuration

- **Variables** (Settings → Secrets and variables → Actions → _Variables_)
  - `NEXT_PUBLIC_SERVER_URL` — the public control-plane URL baked into the
    Docker image at build time. Defaults to `http://localhost:3000` when unset
    (safe for staging / pre-DNS deploys). This is a **build-time** value inlined
    into the client bundle; changing it in Coolify's runtime env does nothing,
    it has to be right when CI builds.
- **Packages permissions** — `GITHUB_TOKEN` pushes to GHCR; under
  Settings → Actions → General, set _Workflow permissions_ to
  _Read repository contents and packages permissions_. The workflow itself grants
  `packages: write` to the publishing job only.
- **The GHCR package must be public** — under the package's settings, set
  visibility to Public. srv1 pulls through the `ghcr-mirror.liara.ir`
  pull-through cache (ghcr.io is DPI-blocked there) and the mirror has no
  upstream credentials, so a private package returns 404 through it. Coolify
  likewise needs either a public package or its own registry credential.
- **Branch protection on `main`** — require the single check **`CI success`**.
  It covers lint, typecheck, build, the Docker/compose smoke test, the
  integration suites and the e2e suites.

No secrets beyond the automatic `GITHUB_TOKEN` are needed.
