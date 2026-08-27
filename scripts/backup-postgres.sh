#!/bin/sh
# Nightly Postgres backup for the production stack.
#
#   ./scripts/backup-postgres.sh [destination-dir]
#   0 3 * * *  cd /srv/eshobe-cms && ./scripts/backup-postgres.sh >> /var/log/eshobe-backup.log 2>&1
#
# `pg_dump -Fc` (custom format), not plain SQL: it restores with `pg_restore`,
# which can run in parallel and skip individual objects — a plain dump can only be
# replayed whole, and a single duplicate-key error part-way through leaves the
# database half restored with no way to resume.
#
# The dump runs *inside* the db container, so the host needs no Postgres client and
# the version always matches the server. `docker compose exec -T`: without -T the
# command allocates a TTY and cron has none, which is the classic "works by hand,
# empty file at 3am".
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEST="${1:-${BACKUP_DIR:-./backups}}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DB_USER="${POSTGRES_USER:-eshobe}"
DB_NAME="${POSTGRES_DB:-eshobe}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DEST/eshobe-$STAMP.dump"

mkdir -p "$DEST"

# A partial dump must never be mistaken for a good one: write to .part, rename only
# after pg_dump exits 0. `set -e` plus this rename is the whole integrity story.
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner >"$FILE.part"

mv "$FILE.part" "$FILE"

echo "backup: $FILE ($(wc -c <"$FILE") bytes)"

# Retention last, and only on success: pruning before the new dump exists would
# turn one failed night into an empty backup directory.
find "$DEST" -name 'eshobe-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete

echo "backup: pruned dumps older than $KEEP_DAYS days"
echo
echo "Restore into a running stack with:"
echo "  docker compose -f $COMPOSE_FILE exec -T db pg_restore -U $DB_USER -d $DB_NAME --clean --if-exists < $FILE"
echo
echo "Verify a backup by restoring it somewhere else at least once a quarter."
echo "An untested backup is a hypothesis."
