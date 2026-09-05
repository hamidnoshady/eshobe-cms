# eshobe-cms

Multi-tenant website platform on Payload 3 + Next.js. One deployment hosts many
customer sites (business / portfolio / store), each with its own domain, locales,
content and theme.

**Persian-first**: `fa` is the base locale, RTL is the default direction,
Vazirmatn is the only typeface, and every date renders in Shamsi (Jalali).

- Architecture and phasing → [`PLAN.md`](./PLAN.md)
- Production deployment → [`WAVE-4.md`](./WAVE-4.md) (domains, TLS) and [`WAVE-6.md`](./WAVE-6.md) (R2, SEO, jobs, backups)
- Tenant domain, subdomain and alias operations → [`docs/domains.md`](./docs/domains.md)
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

| Command                        | What it does                                       |
| ------------------------------ | -------------------------------------------------- |
| `pnpm dev`                     | Next + Payload in dev                              |
| `pnpm test:int`                | Vitest integration tests                           |
| `pnpm test:e2e`                | Playwright                                         |
| `pnpm typecheck`               | `tsc --noEmit`                                     |
| `pnpm generate:types`          | Regenerate `payload-types.ts` after config changes |
| `pnpm payload migrate:create`  | After config changes, before deploy                |
| `pnpm payload migrate:status`  | Check before touching a shared database            |
| `./scripts/backup-postgres.sh` | Nightly database dump (production host)            |
| `./scripts/backup-r2.sh`       | Nightly media copy to a second bucket              |

Scaffolded from Payload's `website` template at v3.88.0, with the Mongo adapter
replaced by Postgres and the Latin-only fonts replaced by Vazirmatn.

## CI / CD

Two GitHub Actions workflows live under `.github/workflows/`:

- **`ci.yml`** — runs on every pull request to `main` and on every push to
  `main`. Jobs:
  - `lint` — `pnpm lint`
  - `typecheck` — `pnpm typecheck`
  - `build` — `pnpm build` with placeholder build-time env (matches the
    Dockerfile)
  - `docker-build` — builds the production Docker image (Buildx + GHA cache,
    no push) so a Dockerfile regression is caught before merge
  - `test-int` — Vitest integration suites (`tests/int/**`) against a real
    Postgres 16 service container; runs `pnpm payload migrate:fresh` then
    `pnpm seed` before tests
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
  - `NPM_TOKEN` — an npm *Automation* token with publish access to the
    `@eshobe` scope (needed by `publish.yml` → `npm-publish`).
- **Variables** (optional, under Settings → Variables → Actions)
  - `NEXT_PUBLIC_SERVER_URL` — the public control-plane URL baked into the
    Docker image at build time. Defaults to `http://localhost:3000` when
    unset (safe for staging / pre-DNS deploys).
- **Packages permissions** — `GITHUB_TOKEN` is used for GHCR; under
  Settings → Actions → General, set *Workflow permissions* to
  *Read repository contents and packages permissions* and enable
  *Allow GitHub Actions to create and approve pull requests*.
- **Branch protection on `main`** — add the following to *Required status
  checks* before merge: `Lint`, `Typecheck`, `Build`, `Docker build`,
  `Integration tests`, `E2E tests`.
