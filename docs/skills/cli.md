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
- Python scripts use the venv at `${REPO_ROOT}/.venv/bin/python3`
- SQL operations must be read-only (reject modification keywords)
- Colors: RED for errors, CYAN for headings, GREEN for success, YELLOW for warnings
- Tab-separated output for machine-parseable results
