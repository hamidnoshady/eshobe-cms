# Wave 6 — production hardening

Wave 4 put the stack on a VPS behind Caddy ([`WAVE-4.md`](./WAVE-4.md)). Wave 6 makes
it deployable, observable and correct across a restart: media on R2, per-site SEO
documents, the jobs queue actually running, and a boot that refuses to serve traffic
with a placeholder secret.

## Media on Cloudflare R2

`@payloadcms/storage-s3` is pointed at R2 in [`src/plugins/storage.ts`](./src/plugins/storage.ts).
Set all four variables to switch a deployment over; leave them unset and uploads stay
on the local volume, which is what development does.

```dotenv
R2_ACCOUNT_ID=...
R2_BUCKET=eshobe-media
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
# only if the bucket is not at https://<account>.r2.cloudflarestorage.com
# R2_ENDPOINT=
```

**All four or none.** A partial set is treated as "not configured": the dangerous
middle state is an adapter that takes over the media collection and then fails on
every upload.

Three R2 specifics the adapter has to respect, all of which fail at upload time
rather than at boot:

- `region: 'auto'` — R2 has no regions, but the AWS SDK will not sign without one.
- **No ACL.** R2 rejects `x-amz-acl`; a bucket is public or it is not.
- `forcePathStyle` — the bucket is the first path segment, not a subdomain.

### Files are namespaced per site

Every media document gets `prefix = sites/<site-id>/media`, stamped by a
`beforeChange` hook ([`src/hooks/mediaPrefix.ts`](./src/hooks/mediaPrefix.ts)), so the
object key is `sites/<site-id>/media/<filename>`. Without it, two tenants uploading
`logo.png` are one object in one bucket — filenames are unique per collection, not
per site. The prefix also makes per-customer operations possible at all: backup,
lifecycle rules and offboarding are prefix operations.

**The prefix is written once and never rewritten.** The file already sits at the old
key; re-deriving it for a document that changed site would point the record at a key
that does not exist and orphan the real object on delete. Moving media between sites
is a copy, not an update.

Files keep being served through `/api/media/file/*` (Payload access control stays in
front of the bucket), so the bucket needs no public access, the Caddy carve-out for
media keeps working, and `next/image` keeps treating them as local images. The
`?prefix=` query the plugin appends is matched by the existing `localPatterns` entry —
an entry with no `search` key matches any query string.

The schema carries the `prefix` column whether or not R2 is configured
(`alwaysInsertFields: true`), so the committed migration describes both environments.

## Per-site SEO

`next-sitemap` is gone. It wrote one `robots.txt` and one sitemap, at build time, for
one origin — on a deployment that serves many domains from rows created without a
deploy, every line of it was wrong for every tenant but one.

| URL                                            | Source                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `https://acme.com/robots.txt`                  | [`[domain]/robots.txt/route.ts`](<./src/app/(site)/[domain]/robots.txt/route.ts>)   |
| `https://acme.com/sitemap.xml`                 | [`[domain]/sitemap.xml/route.ts`](<./src/app/(site)/[domain]/sitemap.xml/route.ts>) |
| `https://acme.com/og?slug=about&locale=en&v=…` | [`[domain]/og/route.tsx`](<./src/app/(site)/[domain]/og/route.tsx>)                 |

All three resolve the site from the `Host` header, exactly as a page render does, and
all three 404 (or, for `robots.txt`, `Disallow: /`) on a host that belongs to no
active site. `src/proxy.ts` no longer excludes `robots.txt` and `sitemap.xml` from the
host rewrite — that exclusion existed for the build-time files.

**Sitemaps are per locale.** Each published page appears once per locale it is
_actually translated into_, and every entry lists the whole group as
`<xhtml:link rel="alternate">`. The same set drives the `hreflang` tags and
`x-default` on the page itself. The reason translations are checked rather than
assumed: `slug` is localized and locale fallback is on, so an untranslated page still
reports the Persian slug for `en` — while `where: { slug }` does not fall back, so
`/en/<persian-slug>` 404s. Everything that enumerates locales reads with
`fallbackLocale: false` (see [`src/lib/alternates.ts`](./src/lib/alternates.ts)).

A single-locale site emits no `hreflang` at all: one self-referencing alternate says
nothing the canonical has not said.

Posts are absent from the sitemap because they have no public route yet. Add them
here in the same change as the route.

### OG images

A card is generated per document _per locale_ — the Persian and English titles are
different words, in different scripts, reading in opposite directions. The title
comes from the database by slug, never from a query parameter: a `?title=` would let
anyone render arbitrary text on the customer's branded card. `generateMeta` adds
`v=<updatedAt>` so a re-share after an edit is a new URL, which is the only way past a
social network's image cache. An uploaded `meta.image` still wins.

Vazirmatn is vendored as four `.woff` files next to the route
([`og/fonts`](<./src/app/(site)/[domain]/og/fonts>), SIL OFL). Satori cannot read the
`woff2` that `next/font` downloads and has no system fonts, so a missing face is not a
fallback — it is a card full of blank boxes, which on a Persian-first platform is
every card. Three details there are load-bearing and each was a bug first: the arabic
and latin subsets must be registered under **different family names** (satori keys a
face by name + weight + style, so sharing a name drops one — English titles rendered
as a single letter); the font URL must be a **literal per file**, or the bundler traces
the whole directory and hands back `LICENSE`; and RTL alignment comes from
`justifyContent` on an **LTR** wrapper, because satori moves nothing for
`direction: rtl` on the flex container itself.

## Jobs queue and scheduled publish

`autoRun` runs the queue inside the web container, once a minute — a VPS process that
outlives a request, which is what makes it usable at all.

Two things were needed to make scheduled publishing actually work, and neither of them
errors when missing:

1. **`getPayload({ cron: true })` at startup.** Payload only schedules the cron there,
   and every other `getPayload` call in the codebase is a page render. With `autoRun`
   configured and no `cron: true`, a due `schedulePublish` job sits in `payload_jobs`
   with `total_tried: 0` forever. [`src/instrumentation.ts`](./src/instrumentation.ts)
   is the one hook that runs once per server process, before traffic.
2. **Revalidation that tolerates having no request.** The cron fires from a timer, so
   `revalidatePath` throws `Invariant: static generation store missing`, the task
   fails, Payload retries it to its limit, and the document stays a draft. The hooks
   now route through [`tryRevalidate`](./src/hooks/revalidate.ts), which logs and
   carries on — a cache hint is best-effort, a publish is not.

```dotenv
JOBS_AUTORUN=true    # unset means "production only"; dev and tests stay quiet
```

**One replica, or turn it off.** Every replica runs the same cron against the same
queue and every scheduled publish happens once per replica — silently. Scaling `web`
means `JOBS_AUTORUN=false` plus a container running `payload jobs:run`. Never on
serverless: there is no process to hold a cron.

## Secrets and cookies

The admin session cookie is `Secure` in production and stays `SameSite=Lax`
(`src/collections/Users`). It is conditional because a `Secure` cookie is dropped over
plain http, and hardcoding it makes dev logins silently fail to stick.

Payload's `onInit` now refuses to start a production process with an unsafe
environment ([`src/lib/env.ts`](./src/lib/env.ts)): a missing, placeholder, or short
`PAYLOAD_SECRET` / `CRON_SECRET` / `PREVIEW_SECRET`, or a non-https
`NEXT_PUBLIC_SERVER_URL`. A container that refuses to start is a deploy that fails
loudly; the alternative is a platform signing every tenant's sessions with
`YOUR_SECRET_HERE`. The check stands down during `next build`, which the Dockerfile
deliberately runs with placeholders.

```sh
openssl rand -base64 48    # PAYLOAD_SECRET, CRON_SECRET, PREVIEW_SECRET, POSTGRES_PASSWORD
```

`PAYLOAD_SECRET` must survive restarts and redeploys: rotating it logs out every
editor and makes every encrypted field unreadable.

## Backups

| What              | Script                                                       | Where it lives         |
| ----------------- | ------------------------------------------------------------ | ---------------------- |
| Postgres          | [`scripts/backup-postgres.sh`](./scripts/backup-postgres.sh) | `pgdata` volume        |
| R2 media          | [`scripts/backup-r2.sh`](./scripts/backup-r2.sh)             | R2 bucket              |
| Uploads before R2 | in the Postgres backup's sibling volume                      | `media_uploads` volume |
| TLS certificates  | Caddy re-issues them; nothing to restore                     | `caddy_data` volume    |

```crontab
0  3 * * *  cd /srv/eshobe-cms && ./scripts/backup-postgres.sh >> /var/log/eshobe-backup.log 2>&1
30 3 * * *  cd /srv/eshobe-cms && ./scripts/backup-r2.sh      >> /var/log/eshobe-backup.log 2>&1
```

The database dump is `pg_dump -Fc` (restorable object by object, resumable) written to
`.part` and renamed only on success, with retention pruned _after_ the new dump lands.
The media copy is `rclone copy`, never `sync`: `sync` propagates a bad delete, which is
the accident the backup exists for. Restore commands are printed by each script.

Verify a backup by restoring it somewhere else at least once a quarter. An untested
backup is a hypothesis.

## Deploying

```sh
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec web node -e "1" # container is up
docker compose -f docker-compose.prod.yml logs -f web          # migrations, then "Jobs queue autoRun started"
```

Migrations run at boot from `prodMigrations` — no CI database access. After any config
change:

```sh
pnpm payload migrate:create <name>   # commit src/migrations/*
pnpm payload migrate:status          # clean before and after a deploy
```

Never point a production container at a database that was built with dev push mode:
Payload stops on an interactive prompt ("you've run Payload in dev mode… proceed?") and
the container never becomes healthy.
