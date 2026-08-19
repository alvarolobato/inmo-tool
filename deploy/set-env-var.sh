#!/usr/bin/env bash
#
# set-env-var.sh — set one variable in the deployment's .env from STDIN.
# RUNS ON THE PRODUCTION HOST, from the deployment directory.
#
#     printf '%s' "$secret" | ./deploy/set-env-var.sh ADMIN_API_KEY
#
# Through stdin and not as an argument on purpose: process arguments are
# visible in the host's `ps` output, and this is used for secrets.
set -euo pipefail

KEY="${1:?usage: set-env-var.sh VARIABLE_NAME  (value on stdin)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VALUE="$(cat)" KEY="$KEY" python3 - "${REPO_ROOT}/.env" <<'PY'
import os, pathlib, sys

path = pathlib.Path(sys.argv[1])
key, value = os.environ["KEY"], os.environ["VALUE"]
lines = path.read_text().splitlines(keepends=True)
for i, line in enumerate(lines):
    if line.startswith(key + "="):
        lines[i] = f"{key}={value}\n"
        break
else:
    lines.append(f"{key}={value}\n")
path.write_text("".join(lines))
PY

chmod 600 "${REPO_ROOT}/.env"
