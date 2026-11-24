#!/bin/sh
# CI check for pull requests: a change to an app's code must raise that app's version, so
# that auto-release.yml publishes it once the pull request is merged.
#
#   sh .github/scripts/check-app-versions.sh <base commit>
#
# Anemo Voice (android/): versionName must change and versionCode must go up (Android only
# installs an update with a higher versionCode).
# Anemo Desktop (desktop/): <Version> in desktop/Directory.Build.props must change.
# Changes only to docs (*.md) or tests don't count as code changes.
set -eu

base=$1
failed=0

changed() { # $1 = folder; lists changed files that count as the app's code
  git diff --name-only "$base" HEAD -- "$1" | grep -v '\.md$' | grep -v -e '^android/app/src/test/' -e '^desktop/tests/' || true
}

old_file() { git show "$base:$1" 2>/dev/null || true; }

# --- Anemo Voice ---------------------------------------------------------------------------
gradle=android/app/build.gradle.kts
if [ -n "$(changed android/)" ]; then
  name_new=$(sed -n 's/^ *versionName = "\(.*\)"$/\1/p' "$gradle")
  code_new=$(sed -n 's/^ *versionCode = \([0-9]*\)$/\1/p' "$gradle")
  name_old=$(old_file "$gradle" | sed -n 's/^ *versionName = "\(.*\)"$/\1/p')
  code_old=$(old_file "$gradle" | sed -n 's/^ *versionCode = \([0-9]*\)$/\1/p')
  if [ "$name_new" = "$name_old" ] || [ "${code_new:-0}" -le "${code_old:-0}" ]; then
    echo "::error file=$gradle::Anemo Voice's code changed: raise versionName (now $name_new) and versionCode (now $code_new) in $gradle, so the change is released when merged"
    failed=1
  else
    echo "Anemo Voice: $name_old ($code_old) -> $name_new ($code_new)"
  fi
else
  echo "Anemo Voice: no code changes"
fi

# --- Anemo Desktop -------------------------------------------------------------------------
props=desktop/Directory.Build.props
if [ -n "$(changed desktop/)" ]; then
  new=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$props")
  old=$(old_file "$props" | sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p')
  if [ "$new" = "$old" ]; then
    echo "::error file=$props::Anemo Desktop's code changed: raise <Version> (now $new) in $props, so the change is released when merged"
    failed=1
  else
    echo "Anemo Desktop: $old -> $new"
  fi
else
  echo "Anemo Desktop: no code changes"
fi

exit $failed
