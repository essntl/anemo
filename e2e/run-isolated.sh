#!/bin/sh
# Runs ALL end-to-end tests against a fresh, throwaway copy of the app:
# its own containers, volumes and port, with the scripted "fake" model provider,
# so no test is skipped and no real install or real model is touched.
#
#   sh e2e/run-isolated.sh            (from the repository root)
#   E2E_BROWSER=1 sh e2e/run-isolated.sh    also start the agents' browser container
#   KEEP=1 sh e2e/run-isolated.sh           leave the stack running afterwards
#
# Used by CI, and handy before a release.
set -eu

PROJECT=anemo-e2e
PORT=${E2E_PORT:-8090}
BASE="http://localhost:$PORT"
TMP=e2e/.tmp
mkdir -p "$TMP/workspace"

# A random hex string without needing openssl.
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
PASSWORD=$(rand 12)

cat > "$TMP/env" <<EOF
APP_VERSION=e2e
APP_SECRET_KEY=$(rand 32)
POSTGRES_PASSWORD=$(rand 16)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$PASSWORD
ADMIN_PASSWORD_HASH=
WORKSPACE_PATH=./$TMP/workspace
APP_PORT=$PORT
PUBLIC_URL=$BASE
COOKIE_SECURE=false
ENABLE_FAKE_PROVIDER=true
EOF

# On Linux the containers must run as the current user to write the workspace folder.
if [ "$(uname -s)" = "Linux" ]; then
  printf 'PUID=%s
PGID=%s
' "$(id -u)" "$(id -g)" >> "$TMP/env"
fi

PROFILE=""
[ "${E2E_BROWSER:-}" = "1" ] && PROFILE="--profile browser"
COMPOSE="docker compose -p $PROJECT --env-file $TMP/env $PROFILE"

cleanup() {
  if [ "${KEEP:-}" = "1" ]; then
    echo "Left running at $BASE (stop with: $COMPOSE down -v)"
  else
    $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

echo "Starting a throwaway stack on $BASE"
$COMPOSE up -d --build --wait

# First-time setup, as a user would do it: the fake provider and a default model.
E2E_BASE_URL="$BASE" E2E_PASSWORD="$PASSWORD" node e2e/scripts/seed-fake.mjs

# In a subshell, so the clean-up above still runs from the repository root.
(cd e2e && E2E_BASE_URL="$BASE" E2E_PASSWORD="$PASSWORD" npx playwright test "$@")
