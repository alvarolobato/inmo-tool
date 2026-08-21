---
id: D-151
title: config.yaml is the only route for etl.* tunables; the compose env allowlist stays bootstrap-only
date: 2026-08-21
group: Plumbing / process
rule: "Set `etl.*` tunables only via config.yaml (`/admin/config`); never add one to a compose `environment:` block — an etl-only env var the admin UI cannot see makes OFF a silent no-op."
---

# D-151: config.yaml is the only route for etl.* tunables; the compose env allowlist stays bootstrap-only

*Decided: 2026-08-21*

**Context**: D-150 (issue #654, PR #670) added `etl.retain_capture_html_for`
and documented it as settable via `ETL_RETAIN_CAPTURE_HTML_FOR` in the
operator's `.env` plus a container restart. After #670 merged and deployed,
that env var was set on the host, the stack was redeployed, and the running
`etl` container still read back an empty retention set.

The first read of this was "a missing compose line — the env var never
reaches the container." That framing was wrong, and the audit is what shows
it. `docker-compose.{yml,prod.yml}`'s `etl` service declares `environment:`
as an explicit key-by-key allowlist rather than a `.env` passthrough. Parsing
`config/schema.yaml` against both compose files, the `etl.*` keys with
`components: [etl]` are:

| Schema key | In the etl `environment:` allowlist? |
|---|---|
| `etl.dashboard_base_url` | **yes** — how etl reaches the dashboard, needed before config.yaml is read |
| `etl.dashboard_callback_timeout_seconds` | no |
| `etl.min_restart_sweep_interval_seconds` | no |
| `etl.dedup_max_runtime_seconds` | no |
| `etl.manual_trigger_max_runtime_seconds` | no |
| `etl.materialize_reconciler_interval_seconds` | no |
| `etl.default_freshness_interval_hours` | no |
| `etl.freshness_cycle_stuck_after_hours` | no |
| `etl.retain_capture_html_for` | no |

(`etl.zero_result_regression_runs` is namespaced `etl.*` but declares
`components: [dashboard]`, so it is not part of this set.)

**Not one operational tunable is in the allowlist.** The block carries only
what must be readable *before* `config.yaml` can be: the DSN, the config
file's own path, the schema path, the dashboard base URL and admin key for
the callback, otel wiring, `ENVIRONMENT`. Nothing was broken by #670's code.
The *documentation* was: it described a route the deployment deliberately
does not offer for tunables. The working route — `/admin/config` writes
`config.yaml` on the shared config directory, mounted `:rw` for the
dashboard and `:ro` for etl in both compose files, picked up by etl on next
restart — was already live and needed no change at all. Verified directly on
a real built container with the env var unset and `config.yaml` mounted:
`etl.config.retain_capture_html_for()` returns the configured value.

Adding the var to the compose allowlist was therefore not a fix but a
regression, for two reasons:

1. **It would break the off switch.** The var would go on the `etl` service
   only; the admin config UI runs in the **dashboard** container, whose
   `environment:` block does not carry it. `ConfigForm.tsx` renders its
   "Variable de entorno activa — tiene prioridad sobre el fichero" warning
   from the *dashboard's* `source` for the key, so the UI would read
   `file`/`default` and never warn, while etl read `env`. Since
   `etl/config_loader.py` resolves a non-empty env value over the file,
   clearing the value in `/admin/config` would write a config.yaml that etl
   then ignores — retention would keep accumulating large HTML blobs of
   third-party content with no signal anywhere. For a knob whose entire
   framing in D-150 is temporary-and-reversible, a silent off switch is the
   worst available failure mode. D-150's premise that the two sources
   "don't conflict if both happen to be set" holds for turning a key ON and
   fails for turning it OFF.
2. **The repo already documents the opposite policy.** `docker-compose.yml`'s
   dashboard service states verbatim that `DASHBOARD_LLM_PROVIDER` /
   `DASHBOARD_LLM_MODEL_*` / `DASHBOARD_LLM_CLI_*` are *intentionally not set
   here* because doing so "would silently override the operator's config.yaml
   choice and block editing from the admin /config UI (env-sourced keys are
   surfaced as read-only)." Same mechanism, same conclusion, already applied
   to a sibling service. This decision generalises that convention from
   `DASHBOARD_LLM_*` to every `etl.*` tunable rather than carving out an
   exception to it.

**Decision**:
1. **`config.yaml` via `/admin/config` is the only route for an `etl.*`
   operational tunable.** Set the key there, save, restart the etl container.
   No compose change is needed, ever, for a tunable.
2. **The compose `environment:` allowlist stays bootstrap-only.** Add a key
   there only when the container must read it *before* `config.yaml` can be
   read (the DSN, the config/schema paths, the dashboard callback's URL and
   key, otel wiring). Never because a key exists in the schema, and never to
   make a `.env` workflow available for a tunable — that converts a clean
   single-source design into a two-source one whose second source the
   canonical UI cannot see.
3. **The same rule bars it from `.env.example`.** Listing an `etl.*` tunable
   there advertises exactly the second source point 2 rejects.
4. **Guard the route that is actually canonical**:
   `scripts/tests/test_etl_config_yaml_route.py` pins, from parsed YAML in
   both compose files, the shared config-directory mount (`:ro` on etl,
   `:rw` on the dashboard, same source on both) and `CONFIG_FILE` /
   `CONFIG_SCHEMA_PATH` on the services that read it. Nothing pinned this
   before: deleting the mount or dropping `CONFIG_FILE` would make the etl
   loader fall back to a path that does not exist inside the container,
   silently reverting every `etl.*` key to its schema default with all other
   tests green.

**Alternatives rejected**:
- *Add `ETL_RETAIN_CAPTURE_HTML_FOR` to both compose files' `etl.environment`
  (the original shape of this change)* — rejected for the two reasons above.
  It fixes nothing that was broken and breaks the off switch for a feature
  explicitly designed to be switched off.
- *Also add the var to the dashboard service so the UI's `source` is honest* —
  rejected: it makes the UI's warning correct but makes the key permanently
  **read-only** in the admin UI (env-sourced keys are surfaced as read-only),
  which removes the off switch a different way. Two sources cannot be made
  safe here; one must go, and it is the env one.
- *Add the var to `.env.example`* — rejected, see decision point 3.
- *A blanket "every env-backed schema key must appear in the compose
  allowlist" test* — rejected: it asserts the exact opposite of this
  decision and would flag all eight correctly-config.yaml-only tunables.
- *Retire the env route in `etl/config_loader.py` outright* — not done here.
  Env precedence is load-bearing for the bootstrap keys and for tests; the
  rule is about which keys get *wired* into a container, not about the
  loader's precedence order.

**Rationale**: The deployment already had one coherent story for
operational configuration — a single source, editable by the owner from the
admin UI, visible to the person changing it — and #670 documented a
different one. The correct repair is to the documentation, not the
deployment. Making the exception would have cost the property that makes the
UI trustworthy: that what it shows for a key is what the service reads.

**See**: issue #654; D-150 (`docs/decisions/D-150-config-driven-capture-html-retention.md`,
whose operator instructions this corrects); PR #670 (merged with the
`.env`-first instructions); `docker-compose.yml` and `docker-compose.prod.yml`
(the `etl`/`dashboard` `environment:` blocks and the shared config mount, plus
the `DASHBOARD_LLM_*` comment this generalises);
`dashboard/app/admin/config/ConfigForm.tsx` (the env-precedence warning);
`dashboard/app/api/admin/config/route.ts` (the admin write path);
`etl/config_loader.py` (env > config.yaml > default);
`scripts/tests/test_etl_config_yaml_route.py` (the guard).
