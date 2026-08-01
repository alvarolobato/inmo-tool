# Operations

Day-to-day reference for running and maintaining the PowerShop Analytics stack.

## CLI reference

All commands are run as `ps-analytics <command>`.

### Stack management

| Command | What it does |
|---------|--------------|
| `ps-analytics up` | Start all 8 containers in the background |
| `ps-analytics down` | Stop all containers (data is preserved) |
| `ps-analytics restart` | Restart all containers |
| `ps-analytics status` | Show container status and WrenAI UI URL (Linux/macOS also checks reachability) |
| `ps-analytics logs [service]` | Follow logs for all services, or a specific one |
| `ps-analytics open` | Open WrenAI UI in the default browser |

**Service names** for `logs`:

```
postgres   etl   bootstrap   wren-engine   ibis-server
wren-ai-service   wren-ui   qdrant
```

Examples:

```bash
ps-analytics logs                   # all services
ps-analytics logs etl               # ETL container only
ps-analytics logs wren-ai-service   # AI service only
```

### ETL operations

| Command | What it does |
|---------|--------------|
| `ps-analytics etl run` | Run a one-off ETL sync immediately |
| `ps-analytics etl status` | Show watermark table (last sync time and value per table) |
| `ps-analytics etl tables` | Show row counts for all synced tables (`ps_*`) |
| `ps-analytics etl logs` | Follow ETL container logs |

### Maintenance

| Command | What it does |
|---------|--------------|
| `ps-analytics setup` | Interactively reconfigure `.env` — Linux/macOS only; on Windows rerun `install.ps1` |
| `ps-analytics update` | Pull latest release, update compose/config, restart stack |
| `ps-analytics destroy` | Stop containers, remove Docker volumes, delete `./data/` (irreversible — requires typing `yes`) |
| `ps-analytics open` | Open WrenAI UI in browser |
| `ps-analytics version` | Print installed version |
| `ps-analytics help` | Print command reference |

## ETL schedule

The ETL container runs in scheduler mode and syncs all tables once per day at `ETL_CRON_HOUR` (default: **2 AM**). Configure in `.env`:

```env
ETL_CRON_HOUR=3    # run at 3 AM instead
```

Restart the ETL container after changing:

```bash
ps-analytics restart
```

For an immediate sync without waiting for the schedule:

```bash
ps-analytics etl run
```

## Monitoring

**Daily checks:**

```bash
ps-analytics etl status      # confirm last sync completed
ps-analytics etl tables      # spot unexpected row count drops
ps-analytics status          # check all containers are running
```

**Check ETL for errors:**

```bash
ps-analytics etl logs
# Look for ERROR or WARN lines
```

**WrenAI health:**

```bash
ps-analytics status
# On Linux/macOS: output includes "WrenAI UI is reachable at http://localhost:3000"
# On Windows: output includes just the URL "http://localhost:3000"
```

## Backup

Data lives in bind mounts under the project directory. Back up the `data/` subdirectory:

```bash
# Linux/macOS — tar the data directory
tar -czf powershop-backup-$(date +%Y%m%d).tar.gz ~/.powershop-analytics/data/

# Or just back up PostgreSQL (reads POSTGRES_USER / POSTGRES_DB from .env):
source ~/.powershop-analytics/.env
docker compose --project-directory ~/.powershop-analytics \
  --env-file ~/.powershop-analytics/.env \
  -f ~/.powershop-analytics/docker-compose.yml exec -T postgres \
  bash -lc "pg_dump -U \"${POSTGRES_USER:-postgres}\" \"${POSTGRES_DB:-powershop}\"" \
  > powershop-$(date +%Y%m%d).sql
```

The ETL re-syncs all data from the 4D source on a full reload, so PostgreSQL is the only stateful store that needs backing up for analytics continuity. `./data/qdrant` and `./data/wren` contain WrenAI embeddings and config; losing them means WrenAI needs to re-index but no analytics data is lost.

## Updating

`ps-analytics update` does the following in one command:

1. Fetches the latest release tag from GitHub
2. Downloads updated `docker-compose.yml` and `wren-config.yaml`
3. Updates the `ps-analytics` CLI wrapper itself
4. Pulls new Docker images (`docker compose pull`)
5. Restarts the stack

```bash
ps-analytics update
```

Your `.env` is never overwritten by `update`. To reconfigure credentials, run `ps-analytics setup`.

### Pinning versions

To stay on a specific release, set `VERSION` before installing or override image tags in `.env`:

```env
WREN_UI_VERSION=0.32.2
WREN_ENGINE_VERSION=0.22.0
WREN_AI_SERVICE_VERSION=0.29.0
IBIS_SERVER_VERSION=0.22.0
WREN_BOOTSTRAP_VERSION=0.1.5
```

The ETL image (`alobato/powershop-etl`) is pinned to `latest` by default; the update command pulls the newest version.

## Port reference

| Service | Host port | Purpose |
|---------|-----------|---------|
| WrenAI UI | `HOST_PORT` (default 3000) | Web interface |
| WrenAI AI service | `AI_SERVICE_FORWARD_PORT` (default 5555) | Internal; exposed for debugging |
| PostgreSQL | 5432 | Direct DB access if needed |

Internal ports (not exposed to host): wren-engine 8080/7432, ibis-server 8000, qdrant 6333/6334.
