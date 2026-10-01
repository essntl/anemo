#!/bin/sh
# Restore a backup made by backup.sh into this install. It REPLACES the database
# and overwrites files of the same name in the data volume and the workspace.
#
#   scripts/restore.sh backups/anemo-20261001-120000
#
# Use it on an install of the same (or a newer) version, started at least once, and
# with the same APP_SECRET_KEY as the install the backup came from: otherwise
# saved API keys cannot be decrypted and have to be entered again.
# For an install without a compose file: COMPOSE="docker compose -p <name>" sh restore.sh <folder>
set -eu
# Git Bash on Windows would otherwise rewrite container paths like /data.
export MSYS_NO_PATHCONV=1

COMPOSE=${COMPOSE:-docker compose}
SRC=${1:?Usage: restore.sh <backup-folder>}
for part in database.dump data.tar.gz workspace.tar.gz; do
  [ -s "$SRC/$part" ] || { echo "Not a backup folder: $SRC/$part is missing" >&2; exit 1; }
done

if [ "${RESTORE_YES:-}" != "1" ]; then
  printf 'This replaces the database of the running install with the backup from %s.\nType "restore" to continue: ' "$SRC"
  read -r answer
  [ "$answer" = "restore" ] || { echo "Cancelled."; exit 1; }
fi

echo "Stopping the app and the worker"
$COMPOSE stop app worker

echo "Restoring the database"
$COMPOSE exec -T postgres pg_restore -U aiw -d aiw --clean --if-exists --no-owner < "$SRC/database.dump"

echo "Restoring files"
# --no-overwrite-dir: keep the owner and mode of folders that already exist
# (the mounted workspace folder itself cannot be changed from inside the container).
$COMPOSE run --rm --no-deps -T --entrypoint tar app -C /data --no-overwrite-dir -xzf - < "$SRC/data.tar.gz"
$COMPOSE run --rm --no-deps -T --entrypoint tar app -C /workspace --no-overwrite-dir -xzf - < "$SRC/workspace.tar.gz"

echo "Starting again (this also brings the database up to the current version)"
$COMPOSE up -d
echo "Restored from $SRC"
