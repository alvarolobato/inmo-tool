# Production deployment

> **This repository is public.** Nothing here names the deployment host, its
> addresses, its ports or what else runs on it. Every one of those values
> lives in the operator's own config file, described below, and is read from
> there at run time. Keep it that way when editing this page.

## Where the real settings live

One file on the operator's workstation, outside any checkout:

```
~/.config/inmo-tool/.env
```

The CLI loads it (`cli/commands/load-env.sh`) before running any command, so
`ps prod ...` already knows where production is. The two keys that matter for
deployment:

| Key | What it is |
|-----|-----------|
| `PROD_HOST` | ssh target, `user@host` |
| `PROD_PATH` | deployment directory on that host |

Three more are needed only by `ps prod install`, which forwards them to the
host so they never have to be typed there:

| Key | What it is |
|-----|-----------|
| `SHARED_NETWORK` | Docker network the shared PostgreSQL is on |
| `POSTGRES_HOST` | the name that cluster answers to on that network |
| `DASHBOARD_PORT` | host port to publish the dashboard on |
| `ADMIN_ENV_FILE` | *(optional)* a file already on the host holding the cluster's admin credentials, so the installer can pick them up instead of leaving them blank |

A second `.env`, this one **on the host**, holds the deployment's own secrets
(`<PROD_PATH>/.env`, mode 0600). `ps prod install` generates it from
[`.env.prod.example`](../.env.prod.example), which documents every key.
It is never committed, and it is not a copy of the workstation file.

If `ps prod` says `PROD_HOST is not set`, that file is what is missing — not
something in this repository.

## What production looks like

`docker-compose.prod.yml`, project `inmo-tool`, three long-running services
plus one that runs at startup:

| Service | What it does |
|---|---|
| `dashboard` | Next.js app, the only service published outside the host |
| `etl` | connector scheduler: every connector on start, then hourly |
| `otel-collector` | telemetry, same image and config as local |
| `db-init` | one shot: creates the role and database, then exits |

The difference that matters against the local stack: **it does not run
PostgreSQL**. Production connects to a cluster that already exists on the host
and is shared with other applications, joining it by network name. So:

- inmo-tool gets **its own role**, with neither `SUPERUSER` nor `CREATEDB` —
  it shares a server with data that is not its own. `deploy/db-init.sh`
  creates it on every start, idempotently, and is the only place the cluster's
  admin credentials are used.
- That role's database has `CONNECT` revoked from `PUBLIC`, so nothing else in
  the cluster can even open it. Other applications' databases are left exactly
  as they are; they are not ours to harden.
- **Backups are logical, not a directory copy.** There is no data directory of
  ours to tar: `ps prod backup` runs `pg_dump` and downloads the result.

## Commands

```bash
ps prod install --check-only   # verify the host before changing anything
ps prod install                # clone, create data dirs and .env
ps prod copy-data              # operator config + secrets + local database
ps prod status                 # containers, deployed commit, health
ps prod deploy                 # git pull + stage extension + rebuild + up -d
ps prod logs dashboard
ps prod backup
```

`install` deliberately starts nothing: the data goes in first.

`deploy` repackages the browser extension on the host between the pull and
the build. The dashboard image is built with context `./dashboard`, so
`browser-extension/` is outside it and the image can only ever contain the
artifacts staged into `dashboard/public/` beforehand. Skipping that step is
how production served — and reported — extension 0.14.9 for weeks after main
had moved to 0.16.0 (#693). A staged artifact that disagrees with the source
manifest aborts the deploy; see
[D-161](../docs/decisions/D-161-prod-deploy-stages-extension.md).

## Exposure

The dashboard binds to `HOST_BIND` (`0.0.0.0` by default) so a reverse proxy
or tunnel on the host can reach it. Two settings are not optional once
anything outside the host can reach it:

- `ADMIN_API_KEY` — the shared secret behind the `ps_admin` cookie and the
  machine callers. The compose file refuses to start without it.
- `ADMIN_COOKIE_SECURE=true` whenever TLS is terminated in front of the app,
  or the session cookie goes out without the `Secure` flag.

Unlike the local stack, PostgreSQL is not published on a host port by this
deployment at all.

## Things worth knowing before deploying

**The connector scheduler runs for real.** `etl` sweeps every registered
connector on startup and then hourly, from the deployment host's own IP. If a
local stack is also running, both are crawling the same sites at the same
time — stop one.

**The operator config directory is mounted into the containers.** Both `etl`
and `dashboard` mount `~/.config/inmo-tool` from the host (read-only and
read-write respectively), so `config.yaml` has to exist there. `ps prod
copy-data` puts it in place with mode 0600 — it holds API keys.
