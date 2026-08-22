#!/usr/bin/env bash
#
# build-extension-zip.sh — stage the browser extension into the dashboard build context.
#
# WHY THIS EXISTS
# ---------------
# `browser-extension/` lives at the REPO ROOT, but the dashboard Docker image is
# built with context `./dashboard` (see docker-compose.yml `dashboard.build.context`).
# The extension files are therefore NOT visible inside that build, so the running
# container cannot serve them unless we place a packaged copy inside `dashboard/`
# on the host *before* `docker build` runs.
#
# This script zips `browser-extension/` into `dashboard/public/inmo-tool-extension.zip`.
# `dashboard/public/*` is copied verbatim into the image by the Dockerfile
# (`COPY --from=builder /app/public ./public`), and Next.js's standalone server
# serves it — so the admin-gated route `GET /api/extension/download` (which reads
# that file off disk) has something to stream, and a plain `docker build ./dashboard`
# preceded by this script produces an image that already contains the zip.
#
# The zip is a generated artifact (git-ignored, never committed) — regenerate it
# from source on every build. `ps stack` calls this automatically; run it by hand
# before a bare `docker build ./dashboard` when you want the download route live.
#
# Both `ps stack` and `ps prod deploy` call this automatically, from POST-pull
# source immediately before the build (D-060, D-161); run it by hand before a
# bare `docker build ./dashboard` when you want the download route live.
# Paired guards, run right after this script on both paths:
#   scripts/check-extension-zip-fresh.sh     — mtime: source edited after packaging
#   scripts/check-extension-version-sync.sh  — content: staged version != manifest
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC_DIR="${REPO_ROOT}/browser-extension"
OUT_DIR="${REPO_ROOT}/dashboard/public"
OUT_FILE="${OUT_DIR}/inmo-tool-extension.zip"

if [ ! -d "${SRC_DIR}" ]; then
  echo "build-extension-zip: no ${SRC_DIR} — nothing to package (skipping)." >&2
  exit 0
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "build-extension-zip: the 'zip' command is required but not found on PATH." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
rm -f "${OUT_FILE}"

# Zip the CONTENTS of browser-extension/ at the archive root so that unzipping
# yields the extension folder directly (manifest.json at top level), which is
# exactly what Chrome's "Load unpacked" expects the selected folder to contain.
# -j is NOT used: subdirectories (icons/) must be preserved.
( cd "${SRC_DIR}" && zip -q -r -X "${OUT_FILE}" . -x '.*' )

echo "build-extension-zip: wrote ${OUT_FILE} ($(du -h "${OUT_FILE}" | cut -f1))"

# Also emit the served version alongside the zip so the running container can
# tell the dashboard which extension version it serves — WITHOUT hardcoding it
# (browser-extension/ is outside the ./dashboard build context, so the manifest
# itself isn't in the image). The dashboard reads this at request time to prompt
# an update when an older version is linked (#527). Single source: the manifest.
MANIFEST="${SRC_DIR}/manifest.json"
VERSION_FILE="${OUT_DIR}/extension-version.json"
if [ -f "${MANIFEST}" ]; then
  # First "version": "..." line (manifest_version has no leading quote before
  # `version`, so it never matches this pattern).
  # `|| true`: grep exits 1 on no match and `pipefail` would abort the script
  # here, making the "could not parse" branch below unreachable.
  VERSION="$({ grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "${MANIFEST}" || true; } | head -1 | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/')"
  if [ -n "${VERSION}" ]; then
    printf '{"version":"%s"}\n' "${VERSION}" > "${VERSION_FILE}"
    echo "build-extension-zip: wrote ${VERSION_FILE} (v${VERSION})"
  else
    echo "build-extension-zip: could not parse version from ${MANIFEST} — skipping version file." >&2
  fi
fi
