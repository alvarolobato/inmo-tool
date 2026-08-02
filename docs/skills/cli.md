# Skill: CLI Development

**Use when**: Modifying or extending the `ps` CLI tool.

## Architecture

- **Stub**: `cli/ps` -- place in PATH, finds project root via `.ps-project` marker
- **Dispatcher**: `cli/ps.sh` -- routes to `cli/commands/<group>.sh`, loads credentials first
- **Commands**: `cli/commands/<group>.sh` -- one file per command group
- **Credentials**: `cli/commands/load-env.sh` -- sourced before any command

## Adding a new command group

1. Create `cli/commands/<group>.sh` (executable)
2. Add usage entry in `cli/ps.sh` usage() function
3. Update AGENTS.md CLI table

## Adding a subcommand

1. Add a case to the existing `cli/commands/<group>.sh`
2. Update the usage() function in that file
3. Update AGENTS.md if user-facing

## Conventions

- All scripts use `set -e`
- Python one-liners run inside the `etl` service/image via `docker compose exec`/`run` (see `cli/commands/connector.sh`'s `_run_etl_python` helper), not a local venv — this only requires Docker, matching `ps stack`'s own requirement, and guarantees the same Python environment the real connectors run in. (Task 1.5, #13 — the source project's `sql.sh` used a local `${REPO_ROOT}/.venv/bin/python3`, which this project doesn't rely on for CLI commands.)
- No SQL modification-keyword rejection: the source project's `sql.sh` rejected INSERT/UPDATE/DELETE/etc. because it queried a vendor-managed ERP (4D) that must never be written to from an analytics path. This project's database is our own Postgres mirror — `ps db query` runs inside a read-only *transaction* as a safety habit against fat-fingered SQL (see `cli/commands/db.sh`), not because a hard block is a project requirement.
- Colors: RED for errors, CYAN for headings, GREEN for success, YELLOW for warnings
- Tab-separated output for machine-parseable results (e.g. `ps connector list`)
