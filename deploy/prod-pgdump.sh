#!/usr/bin/env bash
#
# prod-pgdump.sh — dump a database from the shared cluster to STDOUT.
# RUNS ON THE PRODUCTION HOST, from the deployment directory. Used by `ps prod backup`.
#
#     ./deploy/prod-pgdump.sh app inmotool | gzip > inmotool.sql.gz
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
[ -f "$ENV_FILE" ] || { echo "prod-pgdump: no $ENV_FILE" >&2; exit 2; }
env_val() {
    grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]\$//"
}

case "${1:-}" in
    admin) PGUSER_="$(env_val POSTGRES_ADMIN_USER)"; PGPASS_="$(env_val POSTGRES_ADMIN_PASSWORD)" ;;
    app)   PGUSER_="$(env_val POSTGRES_USER)";       PGPASS_="$(env_val POSTGRES_PASSWORD)" ;;
    *) echo "usage: prod-pgdump.sh <admin|app> <database>" >&2; exit 2 ;;
esac
DB="${2:?missing database name}"

exec docker run --rm \
    --network "$(env_val SHARED_NETWORK)" \
    -e PGPASSWORD="$PGPASS_" \
    postgres:16-alpine \
    pg_dump -h "$(env_val POSTGRES_HOST)" -U "${PGUSER_:-postgres}" --no-owner --no-acl "$DB"
