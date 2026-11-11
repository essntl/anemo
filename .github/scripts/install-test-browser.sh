#!/bin/sh
# Installs Chromium for Playwright. Run it from a directory that has Playwright in its
# node_modules (e2e/, extension/).
#
# `--with-deps` also installs system packages from Ubuntu's mirror, and a GitHub runner
# at times cannot reach that mirror for hours: on 11 November 2026 every run failed here
# for more than two hours with "Temporary failure resolving 'azure.archive.ubuntu.com'",
# before a single test had started. So the full install gets four minutes (it takes about
# one when the mirror answers). If it fails, the browser is installed alone: the runner
# image already has the libraries Chromium needs, and what is missing then is a handful
# of extra fonts, which no test depends on.
set -u

if timeout 240 npx playwright install --with-deps chromium; then
  exit 0
fi

echo "::warning::Chromium's system packages could not be installed (Ubuntu's mirror unreachable?). Installing the browser alone."
exec npx playwright install chromium
