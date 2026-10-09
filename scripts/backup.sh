#!/usr/bin/env bash
# Consistent logical backup of the database + uploaded media.
#   DATABASE_URL=postgres://... UPLOAD_DIR=server/uploads ./scripts/backup.sh /backups
# Restore:  pg_restore --clean --if-exists -d "$DATABASE_URL" <file>.dump  &&  tar -xzf <file>-uploads.tgz -C <UPLOAD_DIR parent>
set -euo pipefail
DEST="${1:-./backups}"; mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --no-owner "${DATABASE_URL:?DATABASE_URL required}" > "$DEST/smartcard-$STAMP.dump"
UPLOADS="${UPLOAD_DIR:-server/uploads}"
[ -d "$UPLOADS" ] && tar -czf "$DEST/smartcard-$STAMP-uploads.tgz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
echo "Backup written to $DEST (smartcard-$STAMP.*)"
