# To use this Dockerfile, you have to set `output: 'standalone'` in your next.config.js file.
# From https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile

# 24, not 22: package.json `engines` requires node >=24, and pnpm warns (or
# fails under engine-strict) on the mismatch.
FROM node:24-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager.
# pnpm-workspace.yaml carries pnpm 11's build-script approvals (allowBuilds);
# without it native postinstalls (sharp, esbuild) are silently skipped.
# COREPACK_HOME is pinned so the pnpm that `corepack enable` downloads here
# lives at a known path that later stages can COPY instead of re-downloading
# (see the builder stage).
ENV COREPACK_HOME=/corepack
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* pnpm-workspace.yaml* ./
# Required for the root's workspace:* dependency, including in the migrator.
COPY packages/site-runtime/package.json ./packages/site-runtime/package.json
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \
  else echo "Lockfile not found." && exit 1; \
  fi


# The standalone output does not contain Payload's CLI or its TS loader. Keep a
# separate tool tree with source + dependencies for the one-shot command. It is
# copied into the SAME final image as web so schema and app cannot drift.
# Installed with --prod from the same lockfile: the migrator only loads
# payload.config.ts (server code), so runtime dependencies suffice — payload
# ships its own tsx loader. Carrying the full dev tree here (playwright,
# vitest, typescript, eslint, …) previously grew the image 411MB -> 1.68GB on a
# host that also serves the live sites. Still zero downloads/installs at
# container start: everything is baked into this layer.
FROM base AS migration-tools
RUN apk add --no-cache libc6-compat
ENV COREPACK_HOME=/corepack
WORKDIR /app

COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* pnpm-workspace.yaml* ./
# Required for the root's workspace:* dependency, including in the migrator.
COPY packages/site-runtime/package.json ./packages/site-runtime/package.json
# Reuse the pnpm binary the deps stage already downloaded: without this, every
# rebuild of this stage re-fetches pnpm from the npm registry before it can
# even start installing packages.
COPY --from=deps /corepack /corepack
RUN \
  if [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile --prod; \
  else echo "Lockfile not found." && exit 1; \
  fi

# Prune next's OPTIONAL tooling, which the migrator never loads: @next/swc only
# compiles (the image is already built) and next 16's optional @playwright/test
# tree is test-only. Both are optional dependencies, so next runs without them.
# sharp's optional platform binaries are NOT pruned — sharp resolves its native
# binding at import time and the config graph imports it eagerly.
# compose-smoke.sh exercises this image's real migrator twice (plus a failure
# path), so an over-eager prune fails CI before any deploy.
RUN rm -rf node_modules/.pnpm/@next+swc-* \
           node_modules/.pnpm/playwright@* \
           node_modules/.pnpm/playwright-core@* \
           node_modules/.pnpm/@playwright+test@*

COPY tsconfig.json ./
COPY src ./src
COPY packages ./packages
COPY scripts/migrate.ts ./scripts/migrate.ts

# Rebuild the source code only when needed
FROM base AS builder
ENV COREPACK_HOME=/corepack
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# The build below runs `corepack enable pnpm && pnpm run build` on a fresh
# stage: corepack's cache does not survive the stage boundary, so it would
# download pnpm from the npm registry on EVERY image build — the only network
# request `next build` still needs (fonts are bundled, the DB is not touched).
# A transient registry/CDN failure there fails CI with the build step's exit
# code 1 (publish run 35871619894, 2026-09-23). Copy the copy the deps stage
# already downloaded and the builder becomes fully hermetic.
COPY --from=deps /corepack /corepack
COPY . .

# NEXT_PUBLIC_* values are inlined into client bundles and next.config headers
# at build time — runtime env cannot fix them afterwards. Compose passes this
# through `build.args`.
ARG NEXT_PUBLIC_SERVER_URL
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL
# `next build` loads payload.config.ts, which needs these to exist. No page is
# prerendered from the database, so dummy values are safe at build time.
ENV DATABASE_URL="postgres://build:build@localhost:5432/build"
ENV PAYLOAD_SECRET="build-time-placeholder"

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN \
  if [ -f yarn.lock ]; then yarn run build; \
  elif [ -f package-lock.json ]; then npm run build; \
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm run build; \
  else echo "Lockfile not found." && exit 1; \
  fi

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Remove this line if you do not have this folder
COPY --from=builder /app/public ./public

# Upload target for the media collection; compose mounts a volume here so
# customer uploads survive redeploys. Must exist and be writable by `nextjs`
# BEFORE the volume is first created, or Docker seeds it root-owned.
RUN mkdir -p /app/media && chown nextjs:nodejs /app/media
ENV MEDIA_DIR=/app/media

# WAVE-11 — the Caddy host → theme-upstream map. The app rewrites it (atomically) when
# THEME_ROUTES_FILE points here; docker-compose.prod.yml mounts a named volume on this
# directory, shared read-only with Caddy. A fresh named volume is seeded from the
# image, so the committed empty map is what a new deployment starts from — and it is
# owned by `nextjs`, or the app could not replace it.
RUN mkdir -p /app/theme-routes && chown nextjs:nodejs /app/theme-routes
COPY --from=builder --chown=nextjs:nodejs /app/theme-routes.caddy /app/theme-routes/theme-routes.caddy

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Deliberately isolated from the standalone module tree. Both services run as
# nextjs, but only `migrate` gets MIGRATE_DATABASE_URL. No .env files or build-time
# dummy DATABASE_URL/PAYLOAD_SECRET are inherited from a build stage.
COPY --from=migration-tools /app /app/migrator

USER nextjs

EXPOSE 3000

ENV PORT=3000

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
CMD HOSTNAME="0.0.0.0" node server.js
