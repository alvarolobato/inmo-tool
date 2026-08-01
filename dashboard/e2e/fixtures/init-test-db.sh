#!/usr/bin/env bash
# Initialize a throwaway Postgres for dashboard e2e tests:
#   1. apply the mirror schema (etl/schema/init.sql)
#   2. load the synthetic, production-faithful seed (seed.sql)
#
# Idempotent — seed.sql TRUNCATEs the tables it populates first, so re-running
# refreshes the data. NEVER point this at production: it writes test rows.
#
# Usage:
#   dashboard/e2e/fixtures/init-test-db.sh [DSN]
#   E2E_DATABASE_URL=postgres://... dashboard/e2e/fixtures/init-test-db.sh
#
# DSN precedence: $1 > $E2E_DATABASE_URL > a localhost default.
set -euo pipefail

DSN="${1:-${E2E_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/powershop_e2e}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SAFE_DSN=$(sed 's|//[^:@]*:[^@]*@|//<redacted>@|' <<< "$DSN")

case "$DSN" in
  *prod*|*powershop:5432*|*"@${PROD_HOST:-__never__}"*)
    echo "Refusing to seed what looks like a production DSN: $SAFE_DSN" >&2; exit 1 ;;
esac

echo "→ schema: etl/schema/init.sql"
psql "$DSN" -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/etl/schema/init.sql"

echo "→ seed:   dashboard/e2e/fixtures/seed.sql"
psql "$DSN" -v ON_ERROR_STOP=1 -q -f "$HERE/seed.sql"

echo "✓ test DB ready: $SAFE_DSN"
