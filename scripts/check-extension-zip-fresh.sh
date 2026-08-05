#!/usr/bin/env bash
#
# check-extension-zip-fresh.sh — fail loudly when the packaged extension zip is
# stale relative to the extension source.
#
# WHY THIS EXISTS
# ---------------
# `dashboard/public/inmo-tool-extension.zip` is a git-ignored build artifact
# produced by `scripts/build-extension-zip.sh` from the repo-root
# `browser-extension/` directory. The dashboard Docker image COPYs whatever zip
# is sitting in `dashboard/public/` — it does NOT regenerate it. So an extension
# source change (a manifest bump, a detection/batch fix) ships to users ONLY if
# the zip was regenerated before the image was (re)built.
#
# The sanctioned redeploy path (`ps stack update`) regenerates the zip from
# post-pull source right before `docker compose --build` (see cli/commands/stack.sh),
# so it is correct by construction. This guard makes the FAILURE MODE LOUD for
# every other path: a bare `docker compose up -d --build dashboard`, a hand-run
# build, or a `build-extension-zip.sh` that silently errored. It exits non-zero
# when the zip is missing or older than any file under `browser-extension/`.
#
# Usage:
#   scripts/check-extension-zip-fresh.sh            # check REPO_ROOT
#   REPO_ROOT=/path scripts/check-extension-zip-fresh.sh
#
# Exit codes:
#   0  zip is fresh, OR there is no browser-extension/ dir (nothing to package)
#   1  zip is missing, or older than at least one extension source file
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC_DIR="${REPO_ROOT}/browser-extension"
ZIP_FILE="${REPO_ROOT}/dashboard/public/inmo-tool-extension.zip"

# No extension source → nothing this guard can protect. Not an error.
if [ ! -d "${SRC_DIR}" ]; then
  echo "check-extension-zip-fresh: no ${SRC_DIR} — nothing to check (ok)."
  exit 0
fi

if [ ! -f "${ZIP_FILE}" ]; then
  echo "check-extension-zip-fresh: MISSING ${ZIP_FILE}" >&2
  echo "  Run: bash scripts/build-extension-zip.sh" >&2
  exit 1
fi

# Find any source file newer than the zip. `find -newer` compares mtimes;
# excluding dotfiles matches what build-extension-zip.sh packages (-x '.*').
newer="$(find "${SRC_DIR}" -type f -not -path '*/.*' -newer "${ZIP_FILE}" -print 2>/dev/null | head -n 5)"

if [ -n "${newer}" ]; then
  echo "check-extension-zip-fresh: STALE ${ZIP_FILE}" >&2
  echo "  These extension source files are newer than the packaged zip:" >&2
  echo "${newer}" | sed 's/^/    /' >&2
  echo "  Regenerate it: bash scripts/build-extension-zip.sh" >&2
  exit 1
fi

echo "check-extension-zip-fresh: ${ZIP_FILE} is up to date with ${SRC_DIR} (ok)."
exit 0
