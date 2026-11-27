#!/bin/sh
# Which CI jobs a change needs, from the files it touches. Prints one `<job>=true|false`
# line per job (ci.yml's `changes` job appends them to $GITHUB_OUTPUT).
#
#   sh .github/scripts/changed-jobs.sh <base commit>     the files changed since <base>
#   sh .github/scripts/changed-jobs.sh --all             everything (a push to main)
#
# The same rules as `changed_jobs` in the CI container's ci-local.sh
# (.local-env/README.md), plus the desktop and Android jobs that only GitHub runs:
#   docs/, refactor/ and *.md outside backend/      nothing
#   backend/ (its .md files are data), sandbox/, mcp-host/   backend, e2e
#   frontend/                                        frontend, e2e
#     (its API types and focus/timer.ts also: extension)
#   e2e/                                             e2e
#   browser/                                         browser, backend (it tests browserd's guard)
#   claude-runner/  extension/                       their own job
#   desktop/  bridge/                                desktop, desktop-macos
#   android/                                         android
#   docker-compose.yml, docker-compose.dev.yml        backend, browser, claude-runner, e2e
#   docker-compose.prebuilt.yml, deploy/             nothing (no job uses them)
#   anything else (compose, .github, scripts, the Makefile, …)   every job
set -eu

JOBS="backend frontend browser claude-runner extension e2e desktop android"
on=""
add() { for j in "$@"; do case " $on " in *" $j "*) ;; *) on="$on $j" ;; esac; done; }

if [ "${1:-}" = "--all" ]; then
  add $JOBS
else
  base=${1:?usage: changed-jobs.sh <base commit> | --all}
  # One path per line (names may contain spaces); a here-document keeps `on` in this shell.
  files=$(git diff --name-only "$base" HEAD)
  while IFS= read -r f; do
    case "$f" in
      ""|docs/*|refactor/*) ;;
      backend/*|sandbox/*|mcp-host/*) add backend e2e ;;
      *.md) ;;
      # the extension compiles against these two (extension/tsconfig.json paths)
      frontend/src/api/*|frontend/src/features/focus/timer.ts) add frontend e2e extension ;;
      frontend/*) add frontend e2e ;;
      e2e/*) add e2e ;;
      browser/*) add browser backend ;;
      claude-runner/*) add claude-runner ;;
      extension/*) add extension ;;
      desktop/*|bridge/*) add desktop ;;
      android/*) add android ;;
      # Compose: only the jobs that build or start containers. The prebuilt and deploy/
      # files are for installs; no job uses them.
      docker-compose.yml|docker-compose.dev.yml|.github/ci/compose-cache*.yml)
        add backend browser claude-runner e2e ;;
      docker-compose.prebuilt.yml|deploy/*) ;;
      *) add $JOBS; break ;;
    esac
  done <<EOF
$files
EOF
fi

for j in $JOBS; do
  case " $on " in *" $j "*) echo "$j=true" ;; *) echo "$j=false" ;; esac
done
