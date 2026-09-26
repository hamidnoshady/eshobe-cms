#!/bin/sh
# Nightly copy of the platform object-storage media bucket to a second bucket.
#
#   ./scripts/backup-object-storage.sh
#   30 3 * * *  cd /srv/eshobe-cms && ./scripts/backup-object-storage.sh >> /var/log/eshobe-backup.log 2>&1
#
# Why a copy at all, when ArvanCloud object storage is already durable: durability is not
# the risk. The risks are a bad delete, a compromised key, and a bug in a future
# "offboard a site" script — all of which the bucket replicates faithfully. This is the
# undo, and it is why the destination key should be write-only from the app's point of view
# (a different key from the one the platform admin entered in the CMS).
#
# `copy`, never `sync`: `sync` deletes at the destination whatever is gone at the source,
# which propagates exactly the accident this is protecting against. Objects are immutable
# here (Payload writes a new key rather than mutating one), so a copy converges and only
# ever grows.
#
# rclone rather than `aws s3`: one config block for the S3-compatible endpoint and no AWS
# CLI on the host. Configure two remotes named below, or set RCLONE_CONFIG_* env vars.
#
#   rclone config create arvan s3 provider=Other \
#     access_key_id=... secret_access_key=... \
#     endpoint=https://s3.ir-thr-at1.arvanstorage.ir
set -eu

SRC_REMOTE="${STORAGE_REMOTE:-arvan}"
DEST_REMOTE="${STORAGE_BACKUP_REMOTE:-arvan-backup}"
SRC_BUCKET="${STORAGE_BUCKET:?set STORAGE_BUCKET}"
DEST_BUCKET="${STORAGE_BACKUP_BUCKET:-$SRC_BUCKET-backup}"

command -v rclone >/dev/null || {
  echo "rclone is not installed: https://rclone.org/install/" >&2
  exit 1
}

echo "backup: $SRC_REMOTE:$SRC_BUCKET -> $DEST_REMOTE:$DEST_BUCKET"

# --immutable makes a changed source object an error rather than a silent overwrite: under
# this schema that only happens if something is rewriting history.
rclone copy "$SRC_REMOTE:$SRC_BUCKET" "$DEST_REMOTE:$DEST_BUCKET" \
  --immutable \
  --transfers 8 \
  --stats-one-line \
  --stats 1m

echo "backup: media copied"
echo
echo "Files are keyed sites/<site-id>/media/<filename>, so one customer's media is"
echo "one prefix: rclone copy $DEST_REMOTE:$DEST_BUCKET/sites/<id> ./restore"
