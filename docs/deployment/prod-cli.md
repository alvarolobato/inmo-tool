# `ps prod` CLI Reference

All `ps prod` subcommands run **from your local developer Mac** over SSH. They require `PROD_HOST` and `PROD_PATH` set in `~/.config/powershop-analytics/.env`.

```bash
# Minimum configuration (in ~/.config/powershop-analytics/.env):
PROD_HOST=your-user@your-prod-host-ip
PROD_PATH=/Users/your-user/powershop
```

Source: `cli/commands/prod.sh`.

---

## deploy

```
ps prod deploy [--skip-knowledge]
```

Pulls the latest Docker Hub images already referenced in prod's `docker-compose.yml` and restarts the stack with `docker compose up -d`. After the stack is healthy, automatically pushes WrenAI knowledge (instructions + SQL pairs) unless `--skip-knowledge` is given.

**When to use**: after a new ETL or Dashboard image has been pushed to Docker Hub (e.g. after a CI release build). Does **not** download a new `docker-compose.yml` — use `ps prod update` for that.

**Side effects**: brief service interruption during `up -d` restart (typically < 10 s). WrenAI re-indexes knowledge after restart.

**Options**:
- `--skip-knowledge` — skip the automatic `push-knowledge` step after restart.

**Example**:

```bash
ps prod deploy
# Deploying to user@192.168.1.100 → /Users/user/powershop
# Pulling latest Docker Hub images...
# Restarting stack...
# Deploy complete.
# Pushing WrenAI knowledge...
# All done. Run 'ps prod health' to verify.
```

---

## update

```
ps prod update
```

Full update: checks the latest GitHub release, downloads a new `docker-compose.yml` and `wren-config.yaml` from the release assets to prod, then calls `deploy` (pull images + restart + knowledge push).

**When to use**: when a release includes changes to the compose file (new services, version pins, config changes) or `wren-config.yaml`. Checks current `.version` vs latest release and reports if already up to date.

**Side effects**: replaces `docker-compose.yml` and `wren-config.yaml` on prod; updates `.version`; restarts the stack.

**Example**:

```bash
ps prod update
# Checking for updates...
# Updating from v0.1.2-beta.4 to v0.1.2-beta.5...
# Downloading stack files from release v0.1.2-beta.5...
# Stack files updated to v0.1.2-beta.5.
# [deploy output follows]
```

---

## restart

```
ps prod restart [<service>]
```

Restarts all services (`docker compose restart`) or a single named service.

**When to use**: when a service has hung or needs a config reload without a full deploy. Faster than `deploy` because it does not pull images.

**Side effects**: the named service (or all services) restarts. No image pull. No knowledge push.

**Example**:

```bash
ps prod restart                 # restart full stack
ps prod restart wren-ai-service # restart only WrenAI AI service
```

---

## status

```
ps prod status
```

Prints: installed version (from `.version`), `docker compose ps` output, and token state (calls `token-status` internally).

**When to use**: quick health snapshot; first command to run when something seems wrong.

**Side effects**: none (read-only).

**Example**:

```bash
ps prod status
# Production: user@192.168.1.100 → /Users/user/powershop
#   Version: v0.1.2-beta.5
#
# Services:
# NAME       STATUS    PORTS
# postgres   running   ...
# wren-ui    running   ...
# ...
#
# Prod token state:
#   access_token expires in 6h (OK)
```

---

## logs

```
ps prod logs [<service>]
```

Tails logs with `docker compose logs -f --tail 100`. If a service name is given, tails only that service. Follows (streams) until you Ctrl-C.

**When to use**: diagnosing a failing service; watching an ETL sync in real time.

**Side effects**: none. Opens a TTY connection — will keep the terminal open until interrupted.

**Example**:

```bash
ps prod logs           # tail all services
ps prod logs etl       # tail ETL sync only
ps prod logs dashboard # tail Dashboard app only
```

---

## version

```
ps prod version
```

Prints the version string from `~/powershop/.version` on prod.

**When to use**: confirming which release is running on prod.

**Side effects**: none.

**Example**:

```bash
ps prod version
# prod: v0.1.2-beta.5
```

---

## health

```
ps prod health
```

Runs HTTP/Postgres health checks against all prod services and prints a pass/fail summary:

- **PostgreSQL**: `pg_isready` via `docker exec`
- **WrenAI UI**: `curl http://localhost:3000`
- **WrenAI AI Service**: `curl http://localhost:5555`
- **Dashboard**: `curl http://localhost:4000/api/health`

**When to use**: after a deploy to confirm all services came up; during incident diagnosis.

**Side effects**: none (read-only checks).

**Example**:

```bash
ps prod health
# Running health checks on user@192.168.1.100...
#   PostgreSQL:          healthy
#   WrenAI UI:           healthy
#   WrenAI AI Service:   healthy
#   Dashboard:           healthy
# All services healthy.
```

---

## push-config

```
ps prod push-config
```

Copies your local `wren-config.yaml` to `~/powershop/wren-config.yaml` on prod (via `scp`), then restarts `wren-ai-service` to pick up the new config.

**When to use**: when you've updated `wren-config.yaml` locally (LLM model, timeout, or other WrenAI settings) and want to apply it to prod without a full `update`.

**Side effects**: replaces `wren-config.yaml` on prod; restarts `wren-ai-service` (brief interruption to WrenAI queries).

**Example**:

```bash
ps prod push-config
# Uploading wren-config.yaml to prod...
# Restarting wren-ai-service to pick up new config...
# Config pushed and service restarted.
```

---

## push-knowledge

```
ps prod push-knowledge [--dry-run]
```

Transfers the source knowledge Markdown files to prod and runs `scripts/wren-push-metadata.py` on prod to update WrenAI's instructions and SQL pairs in SQLite + Qdrant.

Prod has no git checkout, so the script transfers files over SSH via `tar`. A temp directory on prod is created and cleaned up automatically.

> **Prerequisite**: `python3` must be available on the prod Mac. Install via Xcode Command Line Tools (`xcode-select --install`) if missing.

**When to use**: after updating source knowledge MDs (instructions, SQL pairs) when no full deploy is planned. `ps prod deploy` already calls this automatically unless `--skip-knowledge` was given.

**Options**:
- `--dry-run` — prints knowledge counts without pushing. Files are still transferred (to count them) but SQLite and Qdrant are not modified.

**Side effects**: updates WrenAI SQLite (`instruction` and `sql_pair` tables) + Qdrant collections; restarts `wren-ui` to pick up new data.

**Example**:

```bash
ps prod push-knowledge
# Pushing WrenAI knowledge to user@192.168.1.100...
# Temp dir on prod: /tmp/ps-knowledge.abc123
# Transferring script and source MDs...
# Running wren-push-metadata.py on prod...
# Knowledge push complete. WrenAI instructions and SQL pairs are up to date.

ps prod push-knowledge --dry-run
# [same output but SQLite/Qdrant unchanged]
```

---

## token-status

```
ps prod token-status
```

Reads `~/.claude/.credentials.json` on prod (managed by the launchd agent) and prints how many hours remain on the current OAuth access token.

**When to use**: when the Dashboard shows a CLI provider error, or as part of `ps prod status`.

**Side effects**: none. Does not touch the Keychain and does not refresh the token.

**Output states**:
- `OK` — more than 6 hours remain.
- `WARN: near expiry` — 1–6 hours remain.
- `EXPIRED` — token has expired; run `ps prod login` immediately.

**Example**:

```bash
ps prod token-status
# Prod token state:
#   access_token expires in 4h (WARN: near expiry)
```

---

## login

```
ps prod login
```

Opens an interactive `ssh -t` session to prod and runs `claude /login` to re-authenticate. After `/login` completes, the launchd agent syncs the new token to `~/.claude/.credentials.json` within 5 minutes.

**When to use**: when `token-status` reports EXPIRED, or when the Dashboard is showing "CLI provider error" and the token is stale.

**Side effects**: the host `claude` OAuth token is refreshed (this is the intended, D-025-compliant path). The launchd agent picks up the new token within 5 minutes.

> **D-025**: this is the only correct way to refresh the token. Never run the OAuth refresh from a script, the container, or any automated path — it will rotate the refresh_token and invalidate the Keychain copy.

**Example**:

```bash
ps prod login
# Opening interactive ssh to run `claude /login` on user@192.168.1.100.
# After /login completes, the next launchd cycle (within 5 min) will sync the token.
# [interactive claude /login session opens]
```

---

## ssh

```
ps prod ssh
```

Opens an interactive shell on prod (`exec ssh -t $PROD_HOST`).

**When to use**: for ad-hoc debugging or maintenance that requires a shell. Prefer `ps prod logs` / `ps prod health` / `ps prod restart` for routine operations.

**Side effects**: none by default; whatever you run in the shell is your responsibility.

**Example**:

```bash
ps prod ssh
# [interactive shell on prod Mac opens]
```
