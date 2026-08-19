#!/usr/bin/env bash
#
# prod-psql.sh — psql against the shared PostgreSQL cluster.
# RUNS ON THE PRODUCTION HOST, from the deployment directory.
#
#   ./deploy/prod-psql.sh app   inmotool -c 'SELECT count(*) FROM listing'
#   ./deploy/prod-psql.sh admin postgres -c '\l'
#   gunzip -c dump.sql.gz | ./deploy/prod-psql.sh admin inmotool -q
#
# Uses a throwaway container on the shared network rather than exec'ing into
# the PostgreSQL container: that cluster belongs to more than this stack, and
# this stack should never run anything inside it.
#
# First argument picks the role:
#   admin  cluster superuser — create databases, restore dumps with extensions
#   app    inmo-tool's own role, which reaches nothing outside its database
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
[ -f "$ENV_FILE" ] || { echo "prod-psql: no $ENV_FILE" >&2; exit 2; }

# Read with grep, and strip the quotes by hand: docker compose interprets a
# quoted value in a .env file, `cut` does not, and a quoted username reaches
# psql with the quotes still attached.
# Two seds instead of one back-reference: BSD sed (macOS) does not support \1
# inside an -E pattern.
env_val() {
    grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]\$//"
}

case "${1:-}" in
    admin) PGUSER_="$(env_val POSTGRES_ADMIN_USER)"; PGPASS_="$(env_val POSTGRES_ADMIN_PASSWORD)" ;;
    app)   PGUSER_="$(env_val POSTGRES_USER)";       PGPASS_="$(env_val POSTGRES_PASSWORD)" ;;
    *) echo "usage: prod-psql.sh <admin|app> <database> [psql args...]" >&2; exit 2 ;;
esac
DB="${2:?missing database name}"
shift 2

# env_val returns an empty string for a missing key rather than failing, so
# the default goes through parameter expansion, not `||`.
PGPORT_="$(env_val POSTGRES_PORT)"

exec docker run --rm -i \
    --network "$(env_val SHARED_NETWORK)" \
    -e PGPASSWORD="$PGPASS_" \
    postgres:16-alpine \
    psql -h "$(env_val POSTGRES_HOST)" -p "${PGPORT_:-5432}" \
         -U "${PGUSER_:-postgres}" -d "$DB" -v ON_ERROR_STOP=1 "$@"
