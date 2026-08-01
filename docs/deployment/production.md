# Production Deployment

This is the definitive guide for setting up and operating PowerShop Analytics on the production Mac.

> **This guide is for the production Mac itself (or a new Mac you are standing up).** If you want to operate prod remotely from your local machine, see the [PROD_HOST / PROD_PATH](#configure-remote-operations) section below and the [`ps prod *` CLI reference](prod-cli.md).

---

## TL;DR

```bash
# One-time bootstrap on the prod Mac:
curl -fsSL https://raw.githubusercontent.com/alvarolobato/powershop-analytics/main/deploy/install-prod.sh | bash
# Then complete the steps in One-time install below (claude /login + launchd agent).
```

The app stack runs entirely in Docker — no git checkout, no Python virtualenv. `install-prod.sh` downloads everything the stack needs. The launchd token-sync agent (Step 3) requires fetching one additional script from the repo (see Step 3 below).

---

## What production is

Production runs the same Docker Compose stack on a dedicated Mac. Key differences from local dev:

- **Flat deployment**: no git checkout. The directory (`~/powershop/` by default) contains only `docker-compose.yml`, `wren-config.yaml`, `.env`, `.version`, and `./data/` bind mounts.
- **Images from Docker Hub**: `alobato/powershop-etl` and `alobato/powershop-dashboard` are pre-built and pinned by tag. WrenAI images come from `ghcr.io/canner/*`.
- **Operated remotely**: all day-to-day commands (`ps prod deploy`, `ps prod status`, etc.) run from a developer's local machine over SSH. No manual SSH is needed except for the one-time `claude /login` step.

---

## Prerequisites

### macOS version

- **Supported**: macOS 14 (Sonoma) and macOS 15 (Sequoia). macOS 13 and earlier are unsupported — Docker Desktop minimum is macOS 13, but the launchd plist paths and `security` CLI have diverged enough on older releases to cause subtle failures.
- **Recommended**: latest patch release of macOS 15.

### Apple Silicon vs Intel

- **Apple Silicon (arm64)** — fully supported and recommended.
- **Intel (x86_64)** — may work (Docker Hub images are multi-arch) but is **not tested**. The launchd plist uses `__HOME__` which is the same on both architectures, so the launchd agent itself is not the limiting factor. Proceed with caution and report any issues.

### Docker Desktop

- **Minimum**: Docker Desktop 4.28 (engine 25.0). Earlier versions lack the Compose v2 plugin and have had networking regressions with multi-container bridge networks.
- **Recommended**: latest stable release.
- Install from: <https://www.docker.com/products/docker-desktop/>
- After install, ensure Docker Desktop is running before proceeding (`docker info` should succeed).

### Docker Compose v2

Docker Desktop bundles Compose v2 as a CLI plugin (`docker compose`). Verify:

```bash
docker compose version   # must print Compose version v2.20 or later
```

### Network

**Outbound** (the prod Mac needs to reach):

| Destination | Port | Purpose |
|-------------|------|---------|
| `YOUR_4D_SERVER_IP` | 19812 | P4D SQL (ETL data source) |
| `YOUR_4D_SERVER_IP` | 8080 | SOAP web services |
| `openrouter.ai` | 443 | LLM + embeddings API |
| `registry-1.docker.io`, `ghcr.io` | 443 | Docker image pulls |
| `github.com`, `api.github.com` | 443 | Release asset downloads |

**Inbound**: no public inbound ports are required. `install-prod.sh` binds service ports to `0.0.0.0` for LAN access. If you want to expose services over the internet, put a Cloudflare Tunnel or reverse proxy in front — see [TLS / reverse proxy](#tls--reverse-proxy) below.

### SSH access

The prod Mac must have Remote Login enabled so `ps prod *` commands can connect from developer laptops:

```
System Settings → General → Sharing → Remote Login → On
```

Add the developer's SSH public key to `~/.ssh/authorized_keys` on the prod Mac. Verify from the developer's machine:

```bash
ssh your-prod-user@your-prod-host echo ok
```

### Python 3

Python 3 is required on the prod Mac for the token-sync launchd agent and for `ps prod push-knowledge` (which runs `scripts/wren-push-metadata.py` on prod).

macOS 14/15 ships with Python 3 via Xcode Command Line Tools. Install if missing:

```bash
xcode-select --install   # installs Xcode CLT (includes python3)
python3 --version        # must print 3.8 or later
```

### Disk space

Plan for at least 50 GB free for Docker images + `./data/` growth over time (Postgres mirror, Qdrant vectors, WrenAI SQLite).

### Pre-validate with `--check-only`

Before running the full install, you can verify that this Mac meets all prerequisites without making any changes:

```bash
curl -fsSL https://raw.githubusercontent.com/alvarolobato/powershop-analytics/main/deploy/install-prod.sh -o /tmp/install-prod.sh
bash /tmp/install-prod.sh --check-only
```

The script checks and reports:

| Check | Minimum | Hard fail? |
|-------|---------|------------|
| macOS (Darwin) | — | Yes — Linux/other unsupported |
| macOS version | 14 (Sonoma) | Yes |
| CPU architecture | arm64 (Apple Silicon) | Warn only (Intel untested) |
| Docker engine | 25.0 | Yes |
| Docker Compose v2 | 2.20 | Yes |
| Free disk space | 50 GB | Warn only |
| SSH / Remote Login | enabled | Warn only |

Exit 0 means the Mac is ready; exit non-zero means at least one hard-fail check failed with a clear error message.

---

## One-time install on the prod Mac

> Run all of these steps **on the prod Mac** (or SSH in if the Mac is already accessible).

### Step 1 — Run the bootstrap script

> Optionally run `--check-only` first (see [Pre-validate with `--check-only`](#pre-validate-with---check-only)) to confirm the Mac is ready before making any changes.

```bash
curl -fsSL https://raw.githubusercontent.com/alvarolobato/powershop-analytics/main/deploy/install-prod.sh | bash
```

The script:
1. Runs preflight checks (macOS version, architecture, Docker version, disk space, SSH).
2. Creates `~/powershop/` (or `$PS_PROD_HOME` if set) with `data/{postgres,qdrant,wren}/` subdirs.
3. Downloads `docker-compose.yml` and `wren-config.yaml` from the latest GitHub release.
4. Prompts for credentials (4D server IP/user/password, OpenRouter key, Postgres password) and writes them to `~/powershop/.env` with mode `0600`. **These credentials never leave the host.**
5. Writes `~/powershop/.version` with the installed tag.

After the script finishes, start the stack to verify it pulls images cleanly:

```bash
cd ~/powershop
docker compose pull
docker compose up -d
docker compose ps   # all services should reach "running" within ~60 s
```

### Step 2 — Authenticate Claude (OAuth)

The Dashboard App's CLI provider needs a valid Claude OAuth token. This is a **one-time step per Mac** and whenever the token expires. See [D-025](../decisions/D-025-oauth-single-refresher.md) for the full rationale.

```bash
claude /login
```

> **D-025 rule**: only the host `claude` CLI ever creates or refreshes the OAuth token. Never run OAuth refresh code from a script or from inside a container — doing so rotates the refresh_token and invalidates the Keychain copy, forcing a manual `claude /login` again.

### Step 3 — Install the token-sync launchd agent

The agent mirrors the macOS Keychain entry `Claude Code-credentials` into `~/.claude/.credentials.json` every 5 minutes (`StartInterval=300` in the plist) so the Dashboard container can read it without any manual intervention. Some older script output may still mention a 2-hour interval — that messaging is stale; the installed plist always uses 5 minutes.

Run this from the **repo checkout** on the prod Mac (the bootstrap above does not clone the repo; if you are doing a fresh Mac install with no checkout, clone the repo first or transfer the scripts directory):

```bash
# If you need the scripts (no local checkout), clone minimally:
git clone --depth 1 https://github.com/alvarolobato/powershop-analytics.git /tmp/ps-repo
bash /tmp/ps-repo/scripts/install-claude-token-launchd.sh
rm -rf /tmp/ps-repo
```

Or if you already have a checkout:

```bash
bash scripts/install-claude-token-launchd.sh
```

Verify:

```bash
launchctl list | grep com.powershop.claude-token-sync
tail -n 10 ~/Library/Logs/com.powershop.claude-token-sync.log
```

The log should show a successful sync with no errors.

### Step 4 — Verify the full stack

```bash
cd ~/powershop
docker compose ps       # all containers running
curl http://localhost:3000   # WrenAI UI responds
curl http://localhost:4000/api/health  # Dashboard responds
```

From a developer's local machine (after [configuring remote ops](#configure-remote-operations)):

```bash
ps prod status
ps prod health
```

---

## Configure remote operations

`ps prod *` commands operate the prod stack **from your local developer machine** over SSH. Two variables must be set in `~/.config/powershop-analytics/.env` on **your local Mac** (not the prod Mac):

```env
PROD_HOST=your-prod-user@your-prod-host-ip
PROD_PATH=/Users/your-prod-user/powershop   # absolute path on prod
```

These are **local-operator** variables. The prod Mac itself doesn't need them. Verify the setup:

```bash
ps prod status   # should print container list + version + token state
```

For the full `ps prod *` CLI reference, see [prod-cli.md](prod-cli.md).

---

## Routine operations

See [prod-cli.md](prod-cli.md) for the full reference. Quick-reference:

| Goal | Command |
|------|---------|
| Pull latest images + restart | `ps prod deploy` |
| Full update (new compose/config) | `ps prod update` |
| Check container status | `ps prod status` |
| Health check all services | `ps prod health` |
| Tail logs | `ps prod logs [service]` |
| Restart one service | `ps prod restart <service>` |
| Push WrenAI knowledge | `ps prod push-knowledge` |
| Check OAuth token expiry | `ps prod token-status` |
| Re-authenticate Claude | `ps prod login` |

---

## Backup and restore

### What to back up

| Path | Contents | Method |
|------|----------|--------|
| `~/powershop/data/postgres/` | PostgreSQL data files | Cold (stop stack) or `pg_dump` |
| `~/powershop/data/qdrant/` | Qdrant vector store | Cold only |
| `~/powershop/data/wren/` | WrenAI SQLite + config | Cold only |
| `~/powershop/.env` | All credentials | Copy to secure off-host storage |

The macOS Keychain entry `Claude Code-credentials` is **not** in `data/` and cannot be backed up as a file. On a Mac OS reinstall or migration you must run `claude /login` again.

### Cold backup (recommended for simplicity)

Stop the stack, tar the data directory, restart:

```bash
cd ~/powershop
docker compose down
tar -czf ~/powershop-backup-$(date +%Y%m%d).tar.gz data/
docker compose up -d
```

Store the `.tar.gz` and `.env` in an off-host location (external drive, S3, etc.).

### Warm Postgres backup (no downtime)

If stopping the stack is not acceptable:

```bash
docker compose exec postgres pg_dump -U postgres powershop | gzip > ~/powershop-pg-$(date +%Y%m%d).sql.gz
```

This safely dumps the running database. Qdrant and WrenAI data still require a cold backup.

### Restore procedure

```bash
cd ~/powershop
docker compose down
tar -xzf ~/powershop-backup-YYYYMMDD.tar.gz   # restores data/ in place
docker compose up -d
```

To restore only Postgres from a `pg_dump`:

```bash
docker compose down
# Remove just the postgres data dir so Postgres reinitialises:
rm -rf data/postgres/*
docker compose up -d postgres
sleep 10
gunzip -c ~/powershop-pg-YYYYMMDD.sql.gz | docker compose exec -T postgres psql -U postgres powershop
docker compose up -d
```

---

## Disaster recovery

### Token expiry (most common issue)

Symptom: Dashboard shows "CLI provider error" or `ps prod token-status` reports EXPIRED.

```bash
ps prod login        # opens interactive ssh, run `claude /login` on prod
# The launchd agent syncs the new token within 5 minutes.
```

### Container crash

```bash
ps prod logs [service]   # identify the failing service
ps prod restart [service]
ps prod health           # verify recovery
```

### Postgres corruption

Follow the [restore procedure](#restore-procedure) above. If no backup exists, the ETL can re-sync all data from the 4D source (overnight run).

### Mac OS reinstall

1. Re-run the bootstrap (skips `.env` if it already exists):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/alvarolobato/powershop-analytics/main/deploy/install-prod.sh | bash
   ```
2. Run `claude /login`.
3. Install the launchd agent using the no-checkout path in [Step 3](#step-3--install-the-token-sync-launchd-agent) above.
4. Run `docker compose up -d` from `~/powershop`.

If `data/` survived the reinstall (external drive, separate partition), the databases come up immediately. If not, the ETL re-syncs from the 4D source.

---

## Upgrades

| Scenario | Command | What it does |
|----------|---------|-------------|
| New ETL/Dashboard images pushed to Docker Hub | `ps prod deploy` | Pulls latest image tags, restarts stack |
| New `docker-compose.yml` or `wren-config.yaml` in a release | `ps prod update` | Downloads new files from GitHub release, then does a deploy |
| Updated WrenAI knowledge (instructions, SQL pairs) | `ps prod push-knowledge` | Transfers source MDs to prod and re-indexes |
| Updated `wren-config.yaml` only | `ps prod push-config` | Uploads local config, restarts `wren-ai-service` |

---

## Monitoring

Use `ps prod status` for a quick overview:

```bash
ps prod status   # containers + version + token state
ps prod health   # curl checks on all service endpoints
```

For log tailing:

```bash
ps prod logs dashboard   # dashboard app logs
ps prod logs etl         # ETL sync logs
ps prod logs wren-ui     # WrenAI UI logs
```

Once [#721](https://github.com/alvarolobato/powershop-analytics/issues/721) Phase 6 lands, `ps prod health` and `ps prod status` will also include the OpenTelemetry collector status; the observability doc will be linked here.

---

## TLS / reverse proxy

The stack binds ports to `0.0.0.0` (default) or a specific IP (configurable via `HOST_BIND` in `.env`). Services are:

- WrenAI UI: port `HOST_PORT` (default 3000)
- Dashboard: port `DASHBOARD_PORT` (default 4000)
- PostgreSQL: port 5432 (LAN only — do not expose publicly)

**For LAN-only use** (typical): no reverse proxy needed. Access via `http://mac-ip:3000` and `http://mac-ip:4000`.

**For internet-facing access**: place a Cloudflare Tunnel or an Nginx/Caddy reverse proxy in front. Set `APP_PUBLIC_URL` and `WREN_PUBLIC_URL` in `.env` to your public URLs. Set `ADMIN_COOKIE_SECURE=true` in `.env` when serving over HTTPS.

```nginx
# Minimal Nginx config fragment for Dashboard on a public domain
server {
    listen 443 ssl;
    server_name analytics.example.com;
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Do **not** expose port 5432 publicly. PostgreSQL is for internal use only.

---

## Troubleshooting

For prod-applicable troubleshooting (Docker, Postgres recovery, WrenAI restart), see [troubleshooting.md](troubleshooting.md#prod-applicable-issues).

Quick runbook:

| Symptom | First step |
|---------|-----------|
| Container not starting | `ps prod logs <service>` |
| ETL not connecting to 4D | Check `P4D_HOST` in `.env`; test `nc -zv <P4D_HOST> 19812` from prod |
| WrenAI blank after restart | Wait 2 min; then `ps prod logs wren-ui` |
| Dashboard "CLI provider error" | `ps prod token-status`; if EXPIRED → `ps prod login` |
| Data stale / no recent sync | `ps prod logs etl`; check ETL_CRON_HOUR in `.env` |
