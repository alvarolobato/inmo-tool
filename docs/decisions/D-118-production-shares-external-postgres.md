---
id: D-118
title: Production runs against an externally managed PostgreSQL, with host details kept out of the repo
date: 2026-08-19
group: Deployment
rule: '`docker-compose.prod.yml` runs no PostgreSQL: it joins an existing Docker network (`SHARED_NETWORK`) and connects to a cluster already running on the host and shared with other applications. inmo-tool gets a role with neither SUPERUSER nor CREATEDB, created idempotently by `deploy/db-init.sh`, which also revokes CONNECT on our database from PUBLIC and leaves every other database untouched. Backups are therefore logical (`pg_dump`), never a data-directory copy. `ADMIN_API_KEY` is mandatory and `ADMIN_COOKIE_SECURE` defaults to true, because unlike the local stack this dashboard is reachable from outside the host. No address, hostname, port or co-tenant name is committed — every such value is read at run time from the operator''s `~/.config/inmo-tool/.env`.'
---

# D-118: Production shares an externally managed PostgreSQL

**Context**: the owner asked for inmo-tool to be deployed alongside two other
applications that already run on a single always-on host, sharing that host's
PostgreSQL rather than adding a third database engine to it.

## The decision

`docker-compose.prod.yml` is a separate file, not an override of the local
one, and the difference that drives everything else is that **it runs no
PostgreSQL**. It declares the cluster's Docker network as `external` and
connects by service name.

Three consequences, none of them cosmetic:

**The app's role is not the cluster superuser.** Locally, inmo-tool connects as
`postgres` and owns everything, which is fine when the cluster is its own. In
production it shares a server with other applications' data, so `db-init`
creates a role with neither `SUPERUSER` nor `CREATEDB`, owning exactly one
database. That is enough for `init.sql` and every migration; it is not enough
to read a neighbour's table. The cluster's admin credentials appear in one
place only — `db-init`, a container that exits — and never reach `etl` or
`dashboard`.

`db-init` also revokes `CONNECT` on our database from `PUBLIC`, which
PostgreSQL grants by default, so nothing else in the cluster can open it. It
does **not** touch other databases: they belong to other applications and are
not ours to harden.

**Backups change shape.** There is no `data/postgres` of ours to tar — the
files live inside another stack's directory. `ps prod backup` runs `pg_dump`
and downloads the result. A directory-copy backup procedure would silently
produce nothing useful here.

**Exposure is real.** The dashboard is published on the host so a proxy or
tunnel can reach it, which makes `ADMIN_API_KEY` mandatory (the compose file
refuses to start without it) and `ADMIN_COOKIE_SECURE` default to true. The
existing `ps_admin` cookie gate is what stands between the internet and the
owner's investment research; the compose file should not be able to start
without it configured.

## Why none of the host details are in this repository

inmo-tool is public. An address, a hostname, a port, or the name of a
co-tenant application is not a secret in the cryptographic sense, but together
they describe someone's private infrastructure, and a public repo is a
permanent, indexed record. So `SHARED_NETWORK`, `POSTGRES_HOST`,
`DASHBOARD_PORT`, `PROD_HOST` and `PROD_PATH` are all read at run time from
`~/.config/inmo-tool/.env`, the same file the CLI already loads for
credentials, and the compose file fails loudly rather than carrying a
revealing default.

The cost is that an agent reading this repository cannot know where production
is. That is handled by telling it where to look instead: `AGENTS.md` §
Configuration and [config/production.md](../../config/production.md) both point
at the operator's config file, and in practice `ps prod status` / `logs` /
`psql` read those values so nobody needs to open it.

## What was rejected

- **Running a second PostgreSQL for inmo-tool.** Simpler isolation, but a
  second engine's memory and a second backup to maintain on a host that
  already has one, for a database of a few tens of MB. It also could not
  publish port 5432 (taken), so the isolation would have been partial anyway.
- **Restoring dumps as the cluster admin.** It works, and it is what makes the
  extension statements in a dump succeed, but every object then ends up owned
  by a role the app is not. Instead the four `CREATE`/`COMMENT ON EXTENSION`
  lines are filtered out of the dump (`db-init` has already created both
  extensions) and the restore runs as the app's own role.
