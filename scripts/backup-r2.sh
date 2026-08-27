#!/bin/sh
# Nightly copy of the R2 media bucket to a second bucket.
#
#   ./scripts/backup-r2.sh
#   30 3 * * *  cd /srv/eshobe-cms && ./scripts/backup-r2.sh >> /var/log/eshobe-backup.log 2>&1
#
# Why a copy at all, when R2 is already durable: durability is not the risk. The
# risks are a bad delete, a compromised API token, and a bug in a future
# "offboard a site" script — all of which R2 replicates faithfully. This is the
# undo, and it is why the destination token should be write-only from the app's
# point of view (a different token from the one in the app's environment).
#
# `copy`, never `sync`: `sync` deletes at the destination whatever is gone at the
# source, which propagates exactly the accident this is protecting against.
# Objects are immutable here (Payload writes a new key rather than mutating one),
# so a copy converges and only ever grows.
#
# rclone rather than `aws s3`: one config block for both S3-compatible endpoints and
# no AWS CLI on the host. Configure two remotes named below, or set
# RCLONE_CONFIG_* env vars.
#
#   rclone config create r2 s3 provider=Cloudflare \
#     access_key_id=... secret_access_key=... \
#     endpoint=https://<account>.r2.cloudflarestorage.com
set -eu

SRC_REMOTE="${R2_REMOTE:-r2}"
DEST_REMOTE="${R2_BACKUP_REMOTE:-r2-backup}"
SRC_BUCKET="${R2_BUCKET:?set R2_BUCKET}"
DEST_BUCKET="${R2_BACKUP_BUCKET:-$SRC_BUCKET-backup}"

command -v rclone >/dev/null || {
  echo "rclone is not installed: https://rclone.org/install/" >&2
  exit 1
}

echo "backup: $SRC_REMOTE:$SRC_BUCKET -> $DEST_REMOTE:$DEST_BUCKET"

# --immutable makes a changed source object an error rather than a silent
# overwrite: under this schema that only happens if something is rewriting history.
rclone copy "$SRC_REMOTE:$SRC_BUCKET" "$DEST_REMOTE:$DEST_BUCKET" \
  --immutable \
  --transfers 8 \
  --stats-one-line \
  --stats 1m

echo "backup: media copied"
echo
echo "Files are keyed sites/<site-id>/media/<filename>, so one customer's media is"
echo "one prefix: rclone copy $DEST_REMOTE:$DEST_BUCKET/sites/<id> ./restore"
