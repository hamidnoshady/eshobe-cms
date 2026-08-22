# eshobe-cms

Multi-tenant website platform on Payload 3 + Next.js. One deployment hosts many
customer sites (business / portfolio / store), each with its own domain, locales,
content and theme.

**Persian-first**: `fa` is the base locale, RTL is the default direction,
Vazirmatn is the only typeface, and every date renders in Shamsi (Jalali).

- Architecture and phasing → [`PLAN.md`](./PLAN.md)
- The rules that bind the code → [`CLAUDE.md`](./CLAUDE.md)
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
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For multi-domain dev, Windows needs hosts entries — `*.localhost` does not
resolve on its own. Run once, as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-hosts.ps1
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next + Payload in dev |
| `pnpm test:int` | Vitest integration tests |
| `pnpm test:e2e` | Playwright |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm generate:types` | Regenerate `payload-types.ts` after config changes |
| `pnpm payload migrate:create` | After config changes, before deploy |
| `pnpm payload migrate:status` | Check before touching a shared database |

Scaffolded from Payload's `website` template at v3.88.0, with the Mongo adapter
replaced by Postgres and the Latin-only fonts replaced by Vazirmatn.
