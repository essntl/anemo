#!/bin/sh
# Back up a running Anemo: the database, the data volume (uploads, saved tool
# outputs, undo copies) and the workspace (your files and documents).
#
#   scripts/backup.sh [target-folder]        (default: ./backups)
#
# Run it from the folder with docker-compose.yml. For an install without that file
# (e.g. ZimaOS), name the project instead; `docker compose ls` shows the name:
#
#   COMPOSE="docker compose -p <name>" sh backup.sh /DATA/Backups
#
# Keep your APP_SECRET_KEY with the backup: saved API keys are encrypted with it
# and cannot be read without it. The backup itself does not contain the key.
set -eu
# Git Bash on Windows would otherwise rewrite container paths like /data.
export MSYS_NO_PATHCONV=1

COMPOSE=${COMPOSE:-docker compose}
DEST="${1:-backups}/anemo-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

echo "Backing up to $DEST"
# A consistent snapshot of the database, taken while the app keeps running.
$COMPOSE exec -T postgres pg_dump -U aiw -d aiw --format=custom > "$DEST/database.dump"
# Pack what is inside each folder, not the folder itself: on restore the mounted
# folder keeps its own owner and permissions.
pack() { $COMPOSE exec -T app sh -c "cd $1 && find . -mindepth 1 -maxdepth 1 -print0 | tar -czf - --null -T -"; }
pack /data > "$DEST/data.tar.gz"
pack /workspace > "$DEST/workspace.tar.gz"
$COMPOSE exec -T app python -c "from app import __version__; print(__version__)" > "$DEST/VERSION"

# An empty file means that step failed (for example the container is not running).
for part in database.dump data.tar.gz workspace.tar.gz; do
  if [ ! -s "$DEST/$part" ]; then
    echo "Backup failed: $part is empty" >&2
    exit 1
  fi
done
echo "Done: version $(cat "$DEST/VERSION"), $(du -sh "$DEST" | cut -f1)"
