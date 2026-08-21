---
id: D-151
title: config.yaml (admin UI) is canonical for etl.* operational tunables; the compose env allowlist is bootstrap-only
date: 2026-08-21
group: Plumbing / process
rule: "For an `etl.*` schema key, the admin config UI's `config.yaml` route (mounted `:rw` for dashboard / `:ro` for etl, unconditional in both compose files) is canonical and needs no compose change. `docker-compose.{yml,prod.yml}`'s `etl` service `environment:` block is a deliberate, bootstrap-only allowlist (DSN, config paths, admin key, otel wiring) — add a key there only when it must be readable before config.yaml can be, or when an operator explicitly wants a `.env`-only workflow for it."
---

# D-151: config.yaml (admin UI) is canonical for etl.* operational tunables; the compose env allowlist is bootstrap-only

*Decided: 2026-08-21*

**Context**: D-150 (issue #654, PR #670) added `etl.retain_capture_html_for`
and documented it as settable via `ETL_RETAIN_CAPTURE_HTML_FOR` in
`~/.config/inmo-tool/.env` + a container restart. After #670 merged and
deployed, the owner set that env var on the production host, redeployed,
and found the running `etl` container still read back an empty retention
set. Root cause: `docker-compose.prod.yml`'s (and `docker-compose.yml`'s)
`etl` service declares `environment:` as an explicit key-by-key list —
`POSTGRES_DSN`, `CONFIG_FILE`, `CONFIG_SCHEMA_PATH`, `ETL_DASHBOARD_BASE_URL`,
`ADMIN_API_KEY`, the OTel vars, `ENVIRONMENT` — not a passthrough of the
host's `.env`. `ETL_RETAIN_CAPTURE_HTML_FOR` was never added to that list,
so it never reached the container regardless of what was set on the host.

Checking whether this is a one-off oversight or a systemic gap: **every
other tunable `etl.*` schema key already shares this same "absent from the
compose allowlist" shape** — `etl.min_restart_sweep_interval_seconds`,
`etl.dedup_max_runtime_seconds`, `etl.manual_trigger_max_runtime_seconds`,
`etl.materialize_reconciler_interval_seconds`,
`etl.default_freshness_interval_hours`,
`etl.freshness_cycle_stuck_after_hours` — none of them are individually
allowlisted either. That is not N latent copies of this bug; it is the
existing, working design: the `environment:` block only carries what the
container needs before `config.yaml` can even be read (the DSN, the config
file's own path, the admin key needed to authenticate the dashboard
callback, otel wiring) — not the tunables themselves. Every one of those
other keys is meant to be set via the admin UI (`/admin/config`, which
writes `config.yaml` on the shared `${INMO_TOOL_CONFIG_DIR}` host directory
— mounted `:rw` for the dashboard, `:ro` for etl, in BOTH compose files,
unconditionally, not gated by the `environment:` allowlist at all) and
picked up on the etl container's next restart (`etl.config_loader`'s
`load_config`: env > `config.yaml` > schema default).

Verified directly (local build, real container, no mocking): with
`config.yaml` containing `etl.retain_capture_html_for: idealista` mounted
at `/config` and `ETL_RETAIN_CAPTURE_HTML_FOR` **unset** in the
container's environment, `etl.config.retain_capture_html_for()` correctly
returns `{"idealista"}` — the config.yaml route already worked, with no
compose change, before this decision's fix even existed. Separately,
rebuilding after adding `ETL_RETAIN_CAPTURE_HTML_FOR: ${ETL_RETAIN_CAPTURE_HTML_FOR:-}`
to both compose files' `etl.environment` and running
`docker compose run --rm --no-deps etl python -c "..."` confirmed the env
route now also works end to end (both the "on" and "off" cases read back
correctly from inside a real container).

**Decision**:
1. `ETL_RETAIN_CAPTURE_HTML_FOR` is added to both `docker-compose.yml` and
   `docker-compose.prod.yml`'s `etl.environment` block, so the env-var
   procedure D-150 documented actually works once this lands — parity, and
   because an operator may reasonably prefer a `.env`-only workflow for a
   value they consider secret-adjacent (though this one isn't sensitive).
2. **config.yaml via the admin UI is the canonical, already-working route**
   for this key (and every other `etl.*` tunable) **today, independent of
   this fix** — the owner does not need to wait for this fix to deploy:
   open `/admin/config`, set `etl.retain_capture_html_for` = `idealista`
   under the "ETL" section, save, then `ps prod restart etl`.
3. The compose `environment:` allowlist stays bootstrap-only by design —
   this decision does NOT propose adding every `etl.*` schema key to it
   (that would fight the existing config.yaml mechanism, not fix a gap).
   A future key gets added there only if it has the same
   before-config.yaml-is-readable bootstrap property as the keys already
   listed, not merely because it exists in the schema.
4. Regression guard: `scripts/tests/test_etl_compose_env_passthrough.py`
   pins `ETL_RETAIN_CAPTURE_HTML_FOR` specifically in both compose files'
   `etl.environment` block, parsed from the real YAML (not string-grepped).
   A blanket "every env-backed schema key must appear in the compose
   allowlist" check was considered and rejected — it would be actively
   wrong given point 3, generating a false "missing" finding for every
   other tunable that is correctly config.yaml-only by design.

**Alternatives rejected**:
- *Add every `etl.*` schema key to the compose allowlist* — rejected: not
  actually the deployment's design (point 3 above); would balloon the
  `environment:` block with the exact class of value config.yaml exists to
  carry, and could re-introduce the "operator sets `.env`, container never
  restarts, drifts silently" failure class config.yaml with
  `requires_restart` metadata already handles more honestly.
- *Retire D-150's env-var instructions entirely, config.yaml-only* —
  rejected: the env route is now genuinely fixed and some operators may
  prefer it; no reason to remove a working option once it's actually wired.

**Rationale**: The proximate bug (one missing compose line) is fixed for
parity, but the more valuable finding is that config.yaml was ALREADY the
correct, working, faster path — the PR that shipped D-150 documented only
the slower, broken one. Future `etl.*` config PRs should default to
"config.yaml via the admin UI" as the documented operator procedure, and
only add a compose `environment:` entry when the key has a genuine
bootstrap dependency, not by habit.

**See**: issue #654, D-150 (the original retention feature this corrects
the operating instructions for), PR #670 (merged with the broken
instructions), the follow-up PR that lands this decision,
`docker-compose.yml`, `docker-compose.prod.yml`,
`dashboard/app/api/admin/config/route.ts` (the admin UI's write path,
unfiltered by component), `etl/config_loader.py` (env > config.yaml >
default precedence).
