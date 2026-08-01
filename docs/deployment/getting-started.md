# Getting Started

> **This guide is for local development.** For production setup on a dedicated Mac, see [production.md](production.md).

Deploy PowerShop Analytics in 10 minutes.

## Prerequisites

- **Docker** and **Docker Compose v2** — [install Docker](https://docs.docker.com/get-docker/)
- **Network access** to the 4D ERP server on port 19812 (P4D SQL)
- **OpenRouter API key** — get one at [openrouter.ai](https://openrouter.ai)

## Install

### Linux / macOS

```bash
curl -fsSL https://github.com/alvarolobato/powershop-analytics/releases/latest/download/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://github.com/alvarolobato/powershop-analytics/releases/latest/download/install.ps1 | iex
```

> **Windows note:** Restart your terminal after install — the installer adds `ps-analytics` to your user PATH.

## What the installer does

1. Checks for Docker and Docker Compose v2.
2. Creates the project directory:
   - Linux/macOS: `~/.powershop-analytics/` (override with `PS_ANALYTICS_HOME`)
   - Windows: `%APPDATA%\powershop-analytics\` (override with `$env:PS_ANALYTICS_HOME`)
3. Downloads `docker-compose.prod.yml` (saved locally as `docker-compose.yml`) and `wren-config.yaml` from the release.
4. Prompts for credentials and writes `.env`:
   - 4D server hostname/IP, username, password
   - PostgreSQL password (auto-generated if you press Enter)
   - OpenRouter API key
5. Installs the `ps-analytics` CLI wrapper:
   - Linux/macOS: `/usr/local/bin/ps-analytics` or `~/.local/bin/ps-analytics`
   - Windows: `%LOCALAPPDATA%\powershop-analytics\ps-analytics.cmd`

If `.env` already exists the installer skips the interactive prompts. To reconfigure, delete `.env` and re-run the installer (`install.sh` on Linux/macOS, `install.ps1` on Windows). On Linux/macOS you can also run `ps-analytics setup` to reconfigure interactively without re-running the full installer.

## Start the stack

```bash
ps-analytics up
```

This starts 8 containers in the background: `postgres`, `etl`, `bootstrap`, `wren-engine`, `ibis-server`, `wren-ai-service`, `wren-ui`, `qdrant`.

Data is stored in bind mounts under the project directory:
- `./data/postgres` — PostgreSQL data
- `./data/qdrant` — Qdrant vector store
- `./data/wren` — WrenAI config and state

## Verify the stack is running

```bash
ps-analytics status
```

On Linux and macOS this prints container status and checks whether the WrenAI UI is reachable; on Windows it prints container status and the WrenAI URL. Wait 1–2 minutes after `up` for all services to initialise.

## Open the WrenAI UI

```bash
ps-analytics open
```

Or navigate to [http://localhost:3000](http://localhost:3000) (default port; change `HOST_PORT` in `.env` if needed).

See [wren-setup.md](wren-setup.md) to configure the data source and start querying.

## Run the first ETL sync

The ETL container runs nightly by default (at `ETL_CRON_HOUR`, default 2 AM). To load data immediately:

```bash
ps-analytics etl run
```

The initial sync can take 30–60 minutes depending on data volume. Follow progress with:

```bash
ps-analytics etl logs
```

## Verify data loaded

```bash
ps-analytics etl status      # last sync time per table
ps-analytics etl tables      # row counts for all synced tables (ps_*)
```

## Next steps

- [wren-setup.md](wren-setup.md) — configure WrenAI data source and LLM
- [4d-connection.md](4d-connection.md) — 4D database connection details and troubleshooting
- [operations.md](operations.md) — full CLI reference, monitoring, backups, updates
- [troubleshooting.md](troubleshooting.md) — common issues and fixes
