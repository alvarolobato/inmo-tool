#!/bin/sh
# Creates inmo-tool's role and database inside an EXTERNALLY MANAGED
# PostgreSQL cluster (see docker-compose.prod.yml). Idempotent: runs on every
# stack start and does nothing when both already exist.
#
# Why this exists: locally, the postgres:16-alpine image creates the database
# and superuser by itself from POSTGRES_USER/POSTGRES_DB. In production this
# stack does not run PostgreSQL at all — it connects to a cluster that is
# already there and shared with other applications, so something has to create
# the role and the database. That is this script, using the cluster's admin
# credentials, which never reach the etl or dashboard containers.
set -e

: "${APP_DB_USER:?missing APP_DB_USER}"
: "${APP_DB_PASSWORD:?missing APP_DB_PASSWORD}"
: "${APP_DB_NAME:?missing APP_DB_NAME}"

# psql picks up host/port/user/password from the PG* vars the compose file injects.
q() { psql -v ON_ERROR_STOP=1 -tAc "$1"; }

echo "db-init: cluster ${PGHOST}:${PGPORT} as ${PGUSER}"

# Roles are cluster-wide. If the role already exists (e.g. from an earlier
# deploy) only the password is re-synced with the one in .env, so rotating it
# is a matter of editing .env and restarting.
if [ "$(q "SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}'")" = "1" ]; then
    echo "db-init: role '${APP_DB_USER}' already exists — syncing password"
    q "ALTER ROLE \"${APP_DB_USER}\" LOGIN PASSWORD '${APP_DB_PASSWORD}'" >/dev/null
else
    echo "db-init: creating role '${APP_DB_USER}'"
    q "CREATE ROLE \"${APP_DB_USER}\" LOGIN PASSWORD '${APP_DB_PASSWORD}'" >/dev/null
fi

# Deliberately no SUPERUSER and no CREATEDB: this cluster is shared with other
# applications and this role has no business outside its own database. Owning
# the database is enough for init.sql to create every table it needs.
if [ "$(q "SELECT 1 FROM pg_database WHERE datname = '${APP_DB_NAME}'")" = "1" ]; then
    echo "db-init: database '${APP_DB_NAME}' already exists"
else
    echo "db-init: creating database '${APP_DB_NAME}' (owner ${APP_DB_USER})"
    q "CREATE DATABASE \"${APP_DB_NAME}\" OWNER \"${APP_DB_USER}\"" >/dev/null
fi

# PostgreSQL lets PUBLIC connect to every database by default, so any other
# role in this shared cluster could open ours (it could not read a table
# without a grant, but there is no reason to leave the door open). Databases
# belonging to other applications are left untouched — they are not ours to
# harden.
q "REVOKE CONNECT ON DATABASE \"${APP_DB_NAME}\" FROM PUBLIC" >/dev/null
q "GRANT CONNECT ON DATABASE \"${APP_DB_NAME}\" TO \"${APP_DB_USER}\"" >/dev/null
echo "db-init: '${APP_DB_NAME}' now only accepts '${APP_DB_USER}' (and superusers)"

# pg_stat_statements needs a superuser and is optional for the app: init.sql
# wraps it in a DO/EXCEPTION block and carries on without it. Created here,
# where we do have admin rights, so the dashboard's slow-query view works.
psql -v ON_ERROR_STOP=1 -d "${APP_DB_NAME}" \
    -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" >/dev/null 2>&1 \
    && echo "db-init: pg_stat_statements ready" \
    || echo "db-init: pg_stat_statements unavailable — the app works without it"

echo "db-init: done"
