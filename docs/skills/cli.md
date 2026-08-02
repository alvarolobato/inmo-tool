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
- `ps db query` is our own Postgres mirror, not a vendor ERP — but it still enforces a real allowlist, not just a typo guard: `cli/lib/sql_guard.py`'s `validate_readonly_sql()` (kept from the source project's `sql.sh`, originally written to protect the 4D ERP) rejects anything that isn't a single statement starting with SELECT. This is load-bearing, not a habit — `SET TRANSACTION READ ONLY` alone was tried first during task 1.5 (#13) review and found trivially bypassable (`COMMIT; DELETE ...`, `SET TRANSACTION READ WRITE; ...`, even a psql meta-command like `\! id` for a root shell in the container, since `PG_USER` defaults to the postgres superuser). The transaction-level restriction is still applied on top as defense-in-depth, but `sql_guard` is what actually stops those.
- Colors: RED for errors, CYAN for headings, GREEN for success, YELLOW for warnings
- Tab-separated output for machine-parseable results (e.g. `ps connector list`)
