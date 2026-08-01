# CLI reference — `ps` command

Single entry point for all operations. **Usage:** `ps <group> [subcommand] [options]`

> **Why this lives here, not in AGENTS.md:** the full table is ~40 rows of mostly-stable operational reference. AGENTS.md keeps a short summary of the groups; this file is the complete map.

## Read-only policy

**CRITICAL:** All SQL operations are read-only. The CLI rejects INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, and TRUNCATE statements. We are extracting data, never modifying the source ERP.

## CLI-first principle

All automation should delegate work to the CLI. This ensures every operation is reproducible locally and in Docker/CI.

## Commands

| Command | Purpose |
|---------|---------|
| `ps setup` | First-time setup: create .env and repo symlink |
| `ps setup check` | Verify prerequisites (Docker, .env, connectivity) |
| `ps stack up` | Start all containers |
| `ps stack down` | Stop all containers |
| `ps stack restart` | Restart all containers |
| `ps stack update` | Pull latest, rebuild images, restart stack |
| `ps stack status` | Show container status and WrenAI UI health |
| `ps stack logs [svc]` | Show logs (follow); optional service name |
| `ps stack open` | Open WrenAI UI in browser |
| `ps stack destroy` | Stop containers and remove volumes (with confirmation) |
| `ps stack migrate` | Apply pending schema migrations |
| `ps stack setup-wren` | Bootstrap WrenAI on first run (semantic model + knowledge push) |
| `ps etl run` | Run ETL sync once (also triggerable via the Dashboard ETL Monitor "Sincronizar ahora" button → `POST /api/etl/run`) |
| `ps etl status` | Show watermark table (last sync per table) |
| `ps etl tables` | Show row counts for synced tables |
| `ps etl logs` | Show ETL container logs |
| `ps sql tables` | List all 4D tables |
| `ps sql describe <table>` | Show columns for a table |
| `ps sql query "<SQL>"` | Run a read-only SQL query |
| `ps sql sample <table> [n]` | Show n sample rows |
| `ps sql count <table>` | Row count for a table |
| `ps sql schema` | Generate the full 4D schema dump locally (git-ignored; contains real data) |
| `ps wren push` | Push source knowledge to WrenAI (instructions + SQL pairs — counts loaded dynamically from source MDs; `ps wren status` shows current numbers) |
| `ps wren validate` | Validate all SQL pairs against PostgreSQL mirror |
| `ps wren crosscheck` | Cross-check WrenAI knowledge against the schema in PostgreSQL (find drift) |
| `ps wren status` | Show instruction and SQL pair counts |
| `ps dashboard open` | Open Dashboard App in browser |
| `ps dashboard logs` | Show dashboard container logs |
| `ps dashboard restart` | Restart the dashboard container |
| `ps dashboard status` | Show dashboard container status |
| `ps prod deploy` | Pull latest Docker Hub images on prod and restart the stack |
| `ps prod update` | Full update: download new compose/config from latest GitHub release + deploy |
| `ps prod restart [svc]` | Restart all services on prod, or a named one |
| `ps prod status` | Container status + version + health checks + token state |
| `ps prod logs [svc]` | Tail prod logs (follow); optional service |
| `ps prod version` | Show the version running on prod |
| `ps prod health` | Run health checks against all prod services |
| `ps prod push-config` | Upload local wren-config.yaml to prod and restart wren-ai-service |
| `ps prod token-status` | Show prod's Claude OAuth access-token expiry hours |
| `ps prod login` | Interactive `ssh -t` to run `claude /login` on prod |
| `ps prod ssh` | Open a shell on prod |
| `ps config` | Show loaded configuration |
