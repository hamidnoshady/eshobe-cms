# eshobe-cms

Multi-tenant website platform on Payload 3 + Next.js. One deployment hosts many
customer sites (business / portfolio / store), each with its own domain, locales,
content and theme. Architecture and phasing: [`PLAN.md`](./PLAN.md).

Stack: Next 16, React 19, Payload 3, Postgres, Tailwind v4, pnpm.

---

## Persian is the base, not an option

- `defaultLocale: 'fa'`. New user-facing strings are written in Persian first.
- **Every** rendered date goes through `formatDate()` in `src/lib/format.ts` — Shamsi (Jalali) on `fa`, Gregorian on `en`. Never render a raw `Date`, ISO string, or `toLocaleDateString()` directly.
- **Every** rendered number goes through `formatNumber()` — Persian-Indic digits on `fa`. Same for prices and phone numbers.
- Both are `Intl`-based (`calendar: 'persian'`). Do not add a date library.
- Vazirmatn is the only font family. Never introduce a second face for Persian text, and never a Latin-only font on a page that can render Persian.
- Body `line-height: 1.8`. Persian needs more vertical room than Latin.

## RTL

- Logical Tailwind utilities only: `ps-*` `pe-*` `ms-*` `me-*` `start-*` `end-*` `text-start` `text-end` `border-s` `border-e`.
- Never `pl-*` `pr-*` `ml-*` `mr-*` `left-*` `right-*` `text-left` `text-right`. They pass review and fail silently in production.
- `rtl:` / `ltr:` variants only where direction genuinely differs — directional icons, carousel arrows, shadow offsets.
- `dir` comes from the active locale's `rtl` flag, per request. Never hardcode it; a bilingual site flips.
- Set `dir` on rich-text wrappers or `@tailwindcss/typography` mis-places list markers.

## Multi-tenancy — the leak rules

- **Never call `payload.find` / `findByID` in front-end code.** Use `findForSite()` in `src/lib/site-query.ts`, which always sets `overrideAccess: false` and scopes by site. The Local API skips access control by default, so a direct call serves one customer's content on another's domain.
- **Every new collection must be registered in the multi-tenant plugin's `collections` map.** An unregistered collection is shared across all tenants — a silent leak, not an error.
- Per-site singletons are collections marked `isGlobal: true`. Never Payload globals; they cannot be tenant-scoped.
- Public `read` access returns a `Where` constraint (`{ _status: { equals: 'published' } }`), never a boolean. `draft: true` on a read does not filter drafts.
- `cleanupAfterTenantDelete` stays `false`. It cascade-deletes every document a site owns.
- Slug uniqueness is enforced per `{ site, locale }` by hook — the plugin does not do it.
- `revalidatePath` calls include domain and locale: `/{domain}/{locale}/{slug}`.

## Payload

- **Never add `localized: true` to a field that already holds data** — it destroys that field's data. Needs a written migration.
- Localize the text fields *inside* blocks, never the `layout` array itself.
- `push` is dev-only. Never mix it with `migrate` against the same database. Commit every migration file.
- Env var is `DATABASE_URL`, not `DATABASE_URI`.
- Keep `i18n.supportedLanguages` to `fa` and `en`. Each one adds to the admin bundle.

## Commands

```bash
pnpm dev                     # Next + Payload
pnpm payload migrate:create  # after config changes, before deploy
pnpm payload migrate:status  # check before touching a shared DB
docker compose up -d db      # local Postgres
```

## Gotchas

- Windows does not resolve `*.localhost`. Add hosts entries (`scripts/dev-hosts.ps1`) or multi-domain dev silently fails.
- Live preview iframe stays blank unless `frame-ancestors` allows the admin origin.
- Payload's admin date picker is Gregorian. A Jalali picker needs a custom field component — not yet built.
- `filterAvailableLocales` resolves once at the app root and goes stale on tenant switch; `router.refresh()` on change.

## Working style

- Read `PLAN.md` before starting a wave. Waves are tracked as GitHub issues #1–#9 under #10.
- Wave 1 gates everything: do not start Wave 2 until its cross-tenant and draft-leak tests pass.
- When adding a collection, add its cross-tenant leak test in the same change.
