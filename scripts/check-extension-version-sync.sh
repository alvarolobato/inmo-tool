#!/usr/bin/env bash
#
# check-extension-version-sync.sh — fail loudly when the extension version the
# dashboard SERVES disagrees with the extension version in source.
#
# WHY THIS EXISTS (issue #693)
# ---------------------------
# `dashboard/public/extension-version.json` and
# `dashboard/public/inmo-tool-extension.zip` are git-ignored build artifacts
# staged from `browser-extension/` by scripts/build-extension-zip.sh. The
# dashboard image COPYs whatever is sitting in `dashboard/public/` — it never
# regenerates them (browser-extension/ is outside the ./dashboard build context).
# `GET /api/extension/status` reports the staged version as `servedVersion`, and
# the CTA compares it against the installed one to offer an update.
#
# So if staging is skipped, the dashboard reports a stale `servedVersion`, decides
# no update is available, and serves that same stale zip to anyone who asks. That
# is exactly how production sat frozen at 0.14.9 while main had moved on: the
# artifacts were baked on the host once by hand and `ps prod deploy` never
# re-staged them, nor ran any freshness guard over them (see #693, D-060, D-161).
#
# HOW THIS DIFFERS FROM check-extension-zip-fresh.sh
# --------------------------------------------------
# That guard compares **mtimes** (`find -newer`) and catches "someone edited the
# extension and rebuilt the image without repackaging" — the broader net, and the
# one that DOES catch #693: `git pull` rewrites the mtime of every file it
# changes, so a manifest bump leaves the source newer than a frozen zip. #693
# shipped because that guard was never invoked on the `ps prod deploy` path, not
# because it was blind to the state (see D-161).
#
# This guard compares **content**: the version string, three ways. It covers the
# narrower case mtime genuinely cannot see — a staged artifact whose bytes predate
# an un-versioned source edit but whose timestamp does not, which is reachable
# when artifacts are copied in from elsewhere rather than built in place. Neither
# guard subsumes the other; run both.
#
# WHAT IS CHECKED
#   browser-extension/manifest.json            (source of truth)
#     == dashboard/public/extension-version.json      -> what status reports
#     == manifest.json inside inmo-tool-extension.zip -> what download serves
#
# ABSENT ARTIFACTS ARE NOT AN ERROR. A missing version file makes
# readServedExtensionVersion() fall back to the source manifest, and failing that
# yields null -> the CTA shows no update prompt. Degrading to "no prompt" is safe;
# degrading to "wrong version" is the bug. Only a PRESENT-AND-DISAGREEING artifact
# fails. Freshness of a *missing* zip is check-extension-zip-fresh.sh's job.
#
# Usage:
#   scripts/check-extension-version-sync.sh          # check REPO_ROOT
#   REPO_ROOT=/path scripts/check-extension-version-sync.sh
#
# Exit codes:
#   0  versions agree, or nothing staged to compare, or no browser-extension/
#   1  a staged artifact reports a different version than the source manifest
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC_DIR="${REPO_ROOT}/browser-extension"
MANIFEST="${SRC_DIR}/manifest.json"
PUBLIC_DIR="${REPO_ROOT}/dashboard/public"
VERSION_FILE="${PUBLIC_DIR}/extension-version.json"
ZIP_FILE="${PUBLIC_DIR}/inmo-tool-extension.zip"

# Extract a JSON string `version` field. Deliberately the SAME expression
# build-extension-zip.sh uses to WRITE the version file, so the writer and the
# checker cannot disagree about what "the version" is. `"manifest_version": 3`
# never matches: the key needs a literal leading quote, and the value must be a
# quoted string.
#
# The `|| true` is load-bearing under `set -euo pipefail`: `grep` exits 1 when it
# matches nothing, `pipefail` propagates that out of the pipeline, and the
# command substitution at the call site would then abort the whole script — so
# every "could not parse" / "<unparseable>" branch below became dead code and an
# unparseable file exited 1 with NO diagnostic at all. Swallow it here and return
# the empty string, so the callers can actually report what they found.
extract_version() {
  { grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$1" 2>/dev/null || true; } \
    | head -1 | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/'
}

if [ ! -d "${SRC_DIR}" ]; then
  echo "check-extension-version-sync: no ${SRC_DIR} — nothing to check (ok)."
  exit 0
fi

if [ ! -f "${MANIFEST}" ]; then
  echo "check-extension-version-sync: no ${MANIFEST} — nothing to check (ok)."
  exit 0
fi

SRC_VERSION="$(extract_version "${MANIFEST}")"
if [ -z "${SRC_VERSION}" ]; then
  echo "check-extension-version-sync: could not parse a version from ${MANIFEST}" >&2
  exit 1
fi

fail=0

# 1. What GET /api/extension/status reports as servedVersion.
if [ -f "${VERSION_FILE}" ]; then
  STAGED_VERSION="$(extract_version "${VERSION_FILE}")"
  if [ "${STAGED_VERSION}" != "${SRC_VERSION}" ]; then
    echo "check-extension-version-sync: STALE ${VERSION_FILE}" >&2
    echo "  manifest.json says '${SRC_VERSION}' but the staged version file says '${STAGED_VERSION:-<unparseable>}'." >&2
    echo "  The dashboard would report servedVersion='${STAGED_VERSION:-null}' and offer no update." >&2
    fail=1
  fi
fi

# 2. What GET /api/extension/download actually hands out. Read with whatever the
#    host has; `zip` (needed to BUILD) does not imply `unzip` (needed to READ).
#    No reader available -> skip this leg rather than fail: check 1 already
#    covers the realistic failure, since both artifacts are staged together.
if [ -f "${ZIP_FILE}" ]; then
  zip_manifest=""
  if command -v unzip >/dev/null 2>&1; then
    zip_manifest="$(unzip -p "${ZIP_FILE}" manifest.json 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    zip_manifest="$(python3 -c 'import sys,zipfile
try:
    sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read("manifest.json").decode("utf-8"))
except Exception:
    pass' "${ZIP_FILE}" 2>/dev/null || true)"
  else
    echo "check-extension-version-sync: neither unzip nor python3 on PATH — skipping the in-zip check." >&2
  fi

  if [ -n "${zip_manifest}" ]; then
    ZIP_VERSION="$({ printf '%s' "${zip_manifest}" | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' || true; } | head -1 | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/')"
    if [ "${ZIP_VERSION}" != "${SRC_VERSION}" ]; then
      echo "check-extension-version-sync: STALE ${ZIP_FILE}" >&2
      echo "  manifest.json says '${SRC_VERSION}' but the packaged zip contains '${ZIP_VERSION:-<unparseable>}'." >&2
      echo "  Anyone downloading the extension would get the old version back." >&2
      fail=1
    fi
  fi
fi

if [ "${fail}" -ne 0 ]; then
  echo "  Regenerate both artifacts: bash scripts/build-extension-zip.sh" >&2
  exit 1
fi

if [ ! -f "${VERSION_FILE}" ] && [ ! -f "${ZIP_FILE}" ]; then
  echo "check-extension-version-sync: nothing staged in ${PUBLIC_DIR} — servedVersion degrades to null, no update prompt (ok)."
  exit 0
fi

echo "check-extension-version-sync: staged extension artifacts agree with ${MANIFEST} (v${SRC_VERSION}) (ok)."
exit 0
