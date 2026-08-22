# Connector & ETL Ops Hardening — roadmap addition

*Design proposal, 2026-08-04. Not yet approved — see [AGENTS.md § Issue and PR format](../../AGENTS.md) for how this turns into issues.*

> **Route names below are stale (noted 2026-08-22).** Every "What exists today"
> section is a snapshot taken on 2026-08-04, and the admin IA has been rebuilt
> twice since: issue #642 P1 (D-154) merged `/etl/connectors` + `/etl/captura`
> into `/admin/fuentes[/name]`, and #642 P2 ([D-168](../decisions/D-168-admin-six-sections-etl-tree-deleted.md))
> deleted the whole `/etl` tree — `app/etl/page.tsx`, `RunList` and
> `EvolutionCharts` no longer exist. Read the surfaces named here as *the
> capability*, not *the file*: run history and the live "currently running"
> row are Actividad (`/admin/actividad`, #644/D-166), connector config and
> per-source health are Fuentes, and the fleet-wide "what needs my attention"
> view §5 asks for is the Estado board (`/admin`, #638/#640). The problem
> statements and the proposed deltas are unaffected; only the file paths are.

## Why this roadmap addition

The owner's stated priority is: **harden how we get the data, how we use it, and how we decide on it — before anything else** (rental data #211, deal-workspace, kanban, chat, and Fotocasa-zone expansion all come after this). Phase 1's connector framework and Phase 2's dedup engine are built and running, but the last dozen or so issues closed against them (#66, #99, #100, #109 area, #171, #179, #185, #186, #197, #206, #209/#213, #214, #217/D-030, #221/D-025) are almost all *"we shipped this and then discovered it was silently wrong/invisible/unfair in production"* — a data-quality incident followed by a fix, repeatedly. That pattern, not a feature gap, is the actual argument for a dedicated hardening pass: the owner needs to **trust** what's in Postgres before there's any point building more product on top of it (scoring, chat, deal workspace).

This document proposes new capability across seven areas the owner named. It does **not** re-propose what already exists — Phase 1/2 built more operational tooling than a first skim suggests (connector enable/disable, per-connector scope/filter config, an ETL monitor with live polling, a dedup review queue). Each section below states what's there today, with file/table/decision citations, before proposing the delta.

This is a **single-operator, laptop/small-Mac deployment** (D-001, no named volumes; no prod environment yet at all — see ARCHITECTURE.md § Production). Proposals are sized accordingly: no RBAC, no multi-tenant config, no alerting-as-a-service integration — just enough visibility and control for one person to look at the dashboard and know whether to trust what it's showing them.

---

## 1. Manage the connectors (controls / config / enable-disable / health / guardrails)

**Problem statement.** The owner wants a single place to see every connector, control what it does, and trust that the control actually takes effect.

**What exists today.** This is the most-built area already:
- `connector_config` (`etl/schema/init.sql` ~L1005) — per-connector `enabled`, `geography_override`, `filters` (JSONB), `min_refetch_interval_seconds`. Written via `PATCH /api/etl/connectors/:name` (`dashboard/app/api/etl/connectors/[name]/route.ts`), rendered via `ConnectorCard.tsx`.
- `connector_registry` (issue #100) — what connectors *exist* (Python is the source of truth; `etl.orchestrator.sync_connector_registry()` upserts it at ETL startup), including `supports_discovery` (capture-only connectors like Idealista get no scope/filter controls) and `supported_filters` (only filter keys live-verified per connector are offered — issue #99 confirmed exactly one, Fotocasa `rooms`).
- The connectors page (`dashboard/app/etl/connectors/page.tsx` — now `app/admin/fuentes/[[...name]]/page.tsx`, D-154) renders a `ScopeSummary` per connector — plain-language "this is what will actually run next" (derived-from-profiles / explicit-override / capture-only / none), closing the exact gap issue #96 was filed about.
- New connectors are born `enabled=false` (issue #100 review) — nothing ingests until the owner opts in.
- Circuit breaker (`etl/connectors/circuit_breaker.py`) and rate limiter are per-run, per-connector — real guardrails against hammering a site, already in the hot path (`etl/orchestrator.py run_connector`).

**What's missing.**
1. **No "run this connector now" control from the UI.** Everything above configures the *next scheduled* run; there's no way to ask "did my config change actually work?" without SSH + `ps connector run <name>`. This is capability 3 below (ad-hoc execution) — called out here because the connector-management page is where the button belongs.
2. **Circuit-breaker/rate-limit state isn't visible per connector.** `rate_limit_per_minute`, `circuit_breaker_error_rate_threshold`, etc. are Python class attributes (D-017 documents Milanuncios' `2/min` as "measured, not proven sufficient" — exactly the kind of number an owner watching real failures would want to see and sanity-check over time). Read-only display only — the owner has code access and edits the Python directly, no need for an editable UI (avoid gold-plating a single-operator tool).
3. **No connector-level "last successful run" surfaced on the management page itself** — it's on `/etl` (RunList) — Actividad (`/admin/actividad`) since D-168 — but an owner deciding "should I disable Solvia" is looking at the connectors page, not correlating with a separate run list by name.

**Proposed approach.**
- Add a "days since last successful run" / trip-count-this-week chip to `ConnectorCard`, sourced from `connector_run_results` (no new table — `listConnectors()` in `dashboard/lib/db/connectors.ts` already joins registry+config, extend it with one more aggregate query).
- Add the ad-hoc "Ejecutar ahora" button here (ties to §3).
- Read-only circuit-breaker/rate-limit numbers pulled from `connector_registry` (already has `rate_limit_per_minute`; would need one more column, `circuit_breaker_error_rate_threshold`, synced the same way as the rest of the registry row).

**Phasing.** Small, additive to the existing page — one PR, after §3 lands (the run-now button is the part worth sequencing first).

---

## 2. ETL execution management (scheduled-run visibility & control)

**Problem statement.** The owner wants to see what the hourly sweep did and be confident a quiet run means "nothing to do" not "something broke silently."

**What exists today.**
- `connector_runs` / `connector_run_results` (issue #99/#104) — one row per run, one row per connector per run, `status IN ('ok','failed','circuit_open','skipped')`, discovered/fetched/error counts, `skipped_count` (issue #143 skip-if-seen visibility).
- `dashboard/app/etl/page.tsx` — `RunList` + `EvolutionCharts`, **live-polling** (all three deleted by D-168; the ledger is `/admin/actividad` now, and the charts were retired rather than moved) (not just a static history table), success-rate and fetch-rate KPIs.
- D-030 (issue #217) added `connector_scope_state` and `connector_run_results.skipped_scopes` (JSONB) — the scheduler-level fairness fix, and the `skipped_scopes` structured reason (`budget` / `uncovered` / `unresolvable`) is exactly the kind of queryable-not-prose signal this whole roadmap area wants more of.
- D-009 (issue #172) — a DB-backed restart-burst guard (`should_skip_immediate_sweep`) stops a crash-loop from hammering every connector's site on every restart; explicitly does **not** gate a deliberate single-connector run.

**What's missing (already tracked — do not duplicate, sequence around them).**
- **#109** (open): `connector_run_results` doesn't persist *which scope* a run actually used — only free-text inside `error_msg`. D-030 added `connector_scope_state` (persistent, per-scope "last attempted"), which covers the fairness/coverage question, but #109's specific ask — "what did *this run* actually do" on the run-detail page — is still open. Sequence this before §4's failure-reason column lands on the same table, since both touch `_record_connector_result`.
- **#171** (open, depends on #80 which is also open): no run-level extraction-quality trend — a connector can report `status='ok'` while its parse quality silently degrades (`extraction.py`'s deliberate fallback-chain design means a partial markup break degrades gracefully instead of raising — see `etl/connectors/extraction.py`, issue #77/#78's fallback-chain retrofit). This is real and worth keeping in the roadmap sequence even though it's gated on #80 landing first.

**Proposed approach.** No new proposal beyond flagging sequencing — #109 and #171 already describe the right shape of work. The one thing worth adding here that isn't in either: a **"currently running" indicator distinct from history** — `RunList` already shows a `running` status row, confirm it renders as a highlighted "in progress" state rather than just another table row (quick UX check, not a new mechanism).

**Phasing.** Owner-sequenced (#109 → #171, both pre-existing). No new issue proposed for this section beyond the polish note above.

---

## 3. Ad-hoc execution — trigger a connector/sync on demand

**Problem statement.** The owner wants to click "run this now" — after fixing a connector, after tweaking a filter, or just to check something — without SSH access to the ETL container.

**What exists today, and what's dead.**
- `etl_manual_trigger` (`etl/schema/init.sql` ~L1420, columns `force_full`/`force_tables`/`triggered_by`, a single-pending-row unique index) is a table **inherited from the PowerShop source project** (see the archived `docs/decisions/archive/D-016-etl-manual-trigger-table.md` / `D-020`). It is fully wired on the write side — the dashboard's old "force ETL resync" button used to insert into it — but **nothing in the new connector orchestrator polls it.** `POST /api/etl/run` (`dashboard/app/api/etl/run/route.ts`) now returns **`501`** rather than a false success (documented explicitly in `ARCHITECTURE.md` § Dashboard App). This is a real, currently-broken capability, not a hypothetical gap.
- `ps connector run [name]` (CLI, `cli/commands/connector.sh`) works today and is the only functioning ad-hoc path — but it requires a shell on the machine running the stack, which defeats "the owner clicks a button in the dashboard."
- There is a **working, proven analog to copy**: `extension_capture` (issue #75) is the *same* "signal via a Postgres row, pick it up on a short poll" pattern, alive today. `etl/capture.py`'s `run_capture_poll_loop` runs in its own thread (started alongside the hourly scheduler in `etl/main.py`), polls every ~10s, and processes rows through the exact same `_upsert_canonical_listing()` path a scheduled run uses — no bypass, no second code path. `docs/architecture/connectors.md` (~L296) documents *why* a queue table beats a synchronous HTTP call here: dashboard (Node) and ETL (Python) are separate containers with no shared filesystem or RPC channel.

**Proposed approach — revive `etl_manual_trigger`, don't invent an HTTP path (per the owner's explicit ask).**
1. Add a `connector_name TEXT` column to `etl_manual_trigger` (nullable — NULL means "run every enabled connector," matching `force_tables`' existing "empty = everything" convention) — reusing the table rather than adding a new one for what is structurally the same signal shape.
2. Add `etl/manual_trigger.py` with a `run_manual_trigger_poll_loop`, following `capture.py`'s exact shape: poll every ~10s, `FOR UPDATE SKIP LOCKED` the pending row, call `run_connector`/`run_all_connectors` for the named connector (or all), write status back to the row (`done`/`failed` + timestamps — columns already exist per the archived D-016/D-020 design).
3. Start the new poll loop as a third thread in `etl/main.py`, alongside `run_scheduler_loop` and `run_capture_poll_loop`.
4. Rewrite `POST /api/etl/run` to insert into `etl_manual_trigger` (optionally scoped to one `connector_name`) instead of returning 501; add a small "Ejecutar ahora" control per connector on `dashboard/app/etl/connectors/page.tsx` (§1) and one global "Ejecutar todo ahora" on `/etl`. *(Both shipped: per-source on `/admin/fuentes/<name>`, global on the `/admin/fuentes` list header — D-154/D-168.)*
5. **Guardrail placement, not a new guardrail**: D-009's restart-burst guard explicitly excludes a deliberate single-connector run (`ps connector run <name>`) from its cooldown — a UI-triggered ad-hoc run is the same category of "deliberate operator action," so it should call `run_connector`/`run_all_connectors` directly (which already carries its own circuit breaker + rate limiter), **not** `run_all_connectors_respecting_restart_guard`. No new rate-limiting concept needed; just don't accidentally route ad-hoc runs through the restart guard.

**Phasing.** One PR: schema column + poll loop + `etl/main.py` wiring + CLI/test coverage (mirrors `capture.py`'s existing test pattern). A second, small PR wires the UI button once the backend path is proven — this can land in the same PR as §1's connector-card work if convenient.

---

## 4. Better error tracking, monitoring, and resolution

**Problem statement.** The owner needs to see failures (circuit-breaker opens, soft-blocks, CDN 404s, WAF blocks) as they happen, understand what kind of failure each one is, and know whether it needs action.

**What exists today (more than a first skim suggests).**
- `connector_run_results.status` — `ok`/`failed`/`circuit_open`/`skipped`, `error_msg` free text.
- D-030 (#217): `skipped_scopes` JSONB with a **structured** reason (`budget`/`uncovered`/`unresolvable`) specifically because free-text `error_msg` wasn't queryable — this is the pattern to extend, not invent again.
- `connector_scope_state` + `getAreaCoverage()` (`dashboard/lib/profile-diagnostics.ts`) — per-scope crawl-coverage state (`never_crawled`/`awaiting_turn`/`attempted_never_succeeded`/`crawled`), rendered by `ZeroCandidatesDiagnostic.tsx` when a profile shows 0 candidates. This is a genuinely good pattern — "every uncertainty resolves toward claiming LESS coverage, never more" (D-030) is exactly the trust posture this whole roadmap area wants.
- Dedup-side telemetry: `dedup_runs` (issue #185, mirrors `connector_runs`' shape), `photo_hash_zero_success_sources` (issue #206 — per-source photo-CDN health, **live network attempts only, never store hits**, D-025 rule 4 — a subtle but load-bearing distinction: counting cache hits as health would have hidden the exact Milanuncios CDN outage #206 was filed to catch), `same_source_skipped`/`same_source_cadastral_collisions` (#197).
- `MilanunciosSoftBlockError` (`etl/connectors/milanuncios.py`) — issue #179/#66 work: a **confirmed, literal-string-matched** bot-mitigation signature (`_SOFT_BLOCK_MARKERS`) is distinguished from a generic parse failure in the exception hierarchy.

**What's missing / broken.**
1. **The soft-block/removed-listing distinction from #66 is half-built and not surfaced.** `MilanunciosSoftBlockError` exists in code (Milanuncios only — Fotocasa, Solvia, Servihabitat, BuildingCenter, Vivantial have no equivalent), but it still subclasses `ConnectorError` and is counted identically in `connector_run_results` — there's no column or status value that tells an operator "this failure was a confirmed soft-block" vs. "this failure was a genuine parse/structure break, go look at it." #66's own acceptance criteria explicitly left "genuinely removed/expired ad" **unresolved** ("this does NOT resolve #66 itself... without its own real captured sample" — `milanuncios.py` ~L162) — that half of the original ask was never finished, for any connector.
2. **The global freshness indicator is silently broken — flag this as a live bug, not a gap.** `dashboard/components/FreshnessContext.tsx` is mounted in `app/layout.tsx` (renders on every page, feeds `TopBar.tsx`'s "hace Xh" indicator) and calls `GET /api/data-health`, which queries `etl_watermarks` for **PowerShop-era table names** (`ventas`, `stock`, `articulos`, `tiendas`, `catalogos` — see `dashboard/app/api/data-health/route.ts` ~L45). `etl_watermarks` is inherited schema (`etl/schema/init.sql` ~L1360) that the **new connector orchestrator never writes to** — only `etl/db/postgres.py`'s legacy DML helpers touch it, and those are exactly the functions issue #64 already flagged as "mostly dead code, not called by `etl/orchestrator.py`." Net effect: **the freshness indicator shown on every single page of the running dashboard cannot ever reflect real connector activity** — it's structurally disconnected from `connector_runs`/`connector_config`, the tables that actually represent this project's ETL. It degrades gracefully (200 + empty result, per its own docstring) rather than erroring, which is exactly what makes it dangerous — it never *looks* broken, it just quietly tells the owner nothing true. See §Findings below.
3. **No aggregated "what needs my attention" view.** Everything above is queryable but scattered across `/etl` (runs), `/etl/connectors` (config), `/admin/dedup` (suggestions), and per-source photo-health counters buried in `dedup_runs`. There's no single place answering "what, across the whole pipeline, is degraded right now" — an owner has to know to check three surfaces. *(Answered since: the Estado board at `/admin`, #638/#640/D-168.)*

**Proposed approach.**
1. **Extend `MilanunciosSoftBlockError`'s pattern to a shared, connector-agnostic `SoftBlockError(ConnectorError)` in `etl/connectors/base.py`**, and give `connector_run_results` a real column for it (`failure_class TEXT` — `'soft_block' | 'structure_change' | 'network' | 'other'`, alongside #109's proposed scope column, same `_record_connector_result` call site) so it's queryable instead of string-matched out of `error_msg`. Land Fotocasa's own soft-block signature detection alongside (Fotocasa's `_extract_initial_props` — `etl/connectors/fotocasa.py` — currently raises a generic `ConnectorError` on a missing marker, same shape Milanuncios had before #179).
2. **Revisit #66's unresolved half** (removed/expired-ad page vs. everything-else) now that live samples exist from real production traffic — not a blind spike this time, a targeted look at accumulated `error_msg` history for pages that *aren't* soft-block-flagged.
3. **Fix `/api/data-health` to point at the real pipeline**: replace the `etl_watermarks` query with one over `connector_runs`/`connector_config` (last successful run per enabled connector; "stale" = no successful run for an enabled connector within, say, 2x its scheduled interval). This closes out issue #64's dead-code question for the watermark helpers at the same time — once nothing needs `etl_watermarks` for freshness, the table and its helpers in `etl/db/postgres.py` are unambiguously dead, not "kept for near-term future use."
4. **A small "pipeline health" summary strip** (not a new page — a component on `/etl` or the connectors page; landed as the Estado board's bands instead, #638/#640/D-168) surfacing: connectors below their success-rate target this week, sources with a live-attempted photo-hash failure this run (#206's existing signal, just not rendered anywhere today), and any `pending` `search_profile` in #113's malformed state. This is aggregation of existing signals, not new telemetry — the point is one glance instead of three pages.

**Phasing.** (1) and (3) are independent, both small, both worth doing before or alongside §109/#171 land (same table, same call site — coordinate to avoid two migrations touching `connector_run_results` in the same window). (2) is a research spike, not guaranteed to ship code (per #66's own precedent — it might conclude "still not distinguishable" for a given connector). (4) is a follow-on once (1)/(3) give it real data to summarize.

---

## 5. Quick refresh on profile change

**Problem statement.** When the owner creates or edits a search profile with a new geography, they want fresh data for that scope now — not whenever the fairness rotation gets to it.

**What exists today.**
- `POST /api/profiles` (`dashboard/app/api/profiles/route.ts`) does exactly one thing: validate and insert the `search_profile` row. Nothing downstream reacts to it.
- D-030 (#217) already fixed the *fairness* half of this problem — a brand-new profile's scope is now guaranteed a first `discover()` attempt within a **bounded** number of runs (`U + 1`, where `U` = other never-attempted scopes already queued for that connector) instead of being starved indefinitely by whichever scope happened to sort first. That's a real fix, but the bound is still expressed in *runs* (hourly), not "now" — the owner's ask here is explicitly to do better than that bound, not just guarantee it terminates.
- `search_profile.last_materialized_at` / `last_viewed_at` (issue #191, schema groundwork already landed for the Perfiles redesign, #191–196) exist as columns but aren't wired to anything ETL-side yet.

**Proposed approach — compose §3's ad-hoc mechanism with profile create/edit, don't build a second trigger path.**
1. On `POST /api/profiles` (create) and the profile-edit route (`PATCH /api/profiles/[id]`) when `scope.geography` changes, enqueue an `etl_manual_trigger` row scoped to *only the connectors whose registry marks `supports_discovery=true` and whose current config/derived-scope would actually cover this profile's geography* — not a full sweep. This reuses §3's revived poll loop and column, so this is a caller of that mechanism, not new ETL machinery.
2. This is explicitly a **fetch acceleration**, not a fairness bypass: it should still go through the connector's normal rate limiter/circuit breaker (same as any ad-hoc run per §3) — a burst of profile edits shouldn't be able to hammer a site any harder than a manual `ps connector run` already can.
3. "Prompt refresh" (the owner's own wording) suggests this should also invalidate/refresh whatever cached LLM context depends on profile scope (`dashboard/lib/llm-context/` — see `docs/skills/llm-context.md`) — flagged here for cross-reference, but the LLM-context side of this is Phase 4/5 territory (occupancy/scoring flows), not this roadmap's connector/ETL scope. Worth a follow-up issue once this lands, not bundled into it.

**Phasing.** Depends on §3 shipping first (it's the mechanism this calls). Small once §3 exists — the interesting design decision is step 1's "which connectors actually cover this scope" filter, which can reuse the same scope-resolution logic `ConnectorCard`'s `ScopeSummary` already computes server-side (`dashboard/lib/db/connectors.ts`).

---

## 6. Aging data + disappearance (withdrawal, staleness, sold-vs-not-covered)

**Problem statement.** The owner wants to know when a property is genuinely sold/withdrawn vs. simply not reached by a connector this run — and wants stale data to be visible as stale, not silently presented as current.

**What exists today.**
- `listing.status` — declared as `'active' | 'reserved' | 'sold' | 'withdrawn' | 'expired'` in both the `CanonicalListingVersion` dataclass comment (`etl/connectors/base.py` L168) and the DB `CHECK` constraint (`etl/schema/init.sql` L119/L260) — **but only two of these five values are ever actually written**: `'active'` (the default) and `'withdrawn'` (only by `_reconcile_missed_discoveries`). `'reserved'`, `'sold'`, and `'expired'` are declared and never set by any code path. Confirmed by grep across `etl/`.
- `_reconcile_missed_discoveries` (`etl/orchestrator.py` L363) — the actual withdrawal mechanism: a listing missing from `_WITHDRAWAL_THRESHOLD` (3) consecutive discover() sweeps for its source flips to `'withdrawn'` + a `listing_status_event` row. Gated hard on `Connector.discovers_full_inventory = True` — **only 2 of 9 registered connectors claim this today** (`BuildingCenter`, `Vivantial`; Fotocasa, both Milanuncios variants, Solvia, Servihabitat all explicitly `False`, each with a documented reason — Fotocasa's coverage is partial-page, Solvia only claims municipality-level sitemap coverage, etc.).
- D-030 (#217) added the scope-level version of "did we actually look here" (`connector_scope_state`, `AreaCoverage` — `never_crawled`/`awaiting_turn`/`attempted_never_succeeded`/`crawled`), explicitly engineered so **withdrawal reconciliation is forced off** (`reconcilable_union = False`) the instant any scope in a run is skipped for budget — "the safe direction... but a real consequence worth stating rather than discovering later" (D-030's own words). Since scope-rotation makes budget-skipping the *normal* outcome of most runs now, this means: **withdrawal detection is effectively dormant for almost the whole connector fleet, almost all the time**, by design, silently.
- `listing.last_seen_at` — updated every time `discover()` re-confirms a listing exists (`etl/orchestrator.py` ~L810). This is real, per-listing staleness data that nothing in the dashboard currently surfaces.
- #66 (closed) built `MilanunciosSoftBlockError` (soft-block detection, Milanuncios only) but explicitly left "genuinely removed ad" unresolved (see §4).

**Why this is the sharpest finding in the whole roadmap.** Put together: for 7 of 9 connectors, a listing that's actually sold or taken down **never transitions out of `'active'`** — there's no per-listing reconciliation happening at all for them, only the property-value candidate the owner sees, indefinitely, as if it were still live. The `last_seen_at` timestamp exists to detect this but nothing reads it. This isn't a missing nice-to-have; it's the single highest-risk gap for an investor tool whose whole purpose is "don't waste my time on stock that's gone."

**Proposed approach.**
1. **Surface `last_seen_at` staleness in the UI immediately — this is cheap and doesn't require new ETL logic.** On the candidate list and property detail page, render "visto por última vez hace N días" whenever `last_seen_at` is more than, say, 2x the connector's scheduled interval ago, and visually distinguish it from a `discovers_full_inventory=True` connector's `'withdrawn'` status (which is a *confirmed* absence, not just "we haven't looked recently"). This mirrors D-030's own per-scope `AreaCoverage` distinction (`crawled` vs. `attempted_never_succeeded` vs. `never_crawled`) applied at the listing grain instead of the scope grain — same underlying philosophy ("every uncertainty resolves toward claiming less confidence, never more"), reused rather than reinvented.
2. **Give partial-inventory connectors a bounded, honest staleness signal even without full reconciliation.** They can't safely auto-withdraw (D-030's own reasoning: a partial union withdrawing live inventory is the failure mode being protected against), but they *can* write a `last_seen_at`-derived `listing_status_event` observation of kind `'not_reconfirmed'` (new, non-authoritative — distinct from `'withdrawn'`) once a listing crosses a staleness threshold, purely for the UI signal in (1) and for a future digest ("these N candidates haven't been reconfirmed in 30+ days, check manually"). This does **not** touch `listing.status` — it's additive observability, not a new withdrawal path, so it can't repeat D-030's "partial union withdraws live inventory" incident.
3. **Extend #66's unresolved half** per §4's proposal — a positively-identified "ad no longer exists" page (distinct from a soft-block) is real, product-relevant signal (issue #1 §10 already calls this out) that today gets thrown away as generic error noise for every connector except the soft-block-only carve-out Milanuncios has.
4. **Do not force `discovers_full_inventory = True` on more connectors just to get reconciliation running.** That flag is a deliberate, evidence-gated claim (BuildingCenter/Vivantial earned it; `docs/architecture/connectors.md` and each connector's own decision file document why the others can't claim it honestly). Widening it dishonestly to "unlock" withdrawal detection would reproduce exactly the kind of over-claiming D-030 spent its whole design fighting. Staleness surfacing (1)/(2) is the honest path for the connectors that can't claim full coverage.

**Phasing.**
- (1) first — pure UI, existing column, no schema change, immediately useful.
- (2) next — one new `listing_status_event` kind, additive.
- (3) as a spike per §4.
- (4) is a standing constraint on all of the above, not a task.

---

## 7. Better duplicate evaluation

**Problem statement.** The owner wants more confidence in the dedup engine's calls — fewer false merges, fewer missed merges, and a review queue that's efficient to work through.

**What exists today (mature — this is the most-iterated subsystem in the codebase, by commit count).**
- Signal priority order (`etl/dedup/engine.py evaluate_pair`): cadastral → address+coords → phone → reference_code → photo_hash → fuzzy fallback, cheapest/highest-confidence first, network-cost signal (photo hash) deliberately last.
- **Cross-source-only pairing** (#197): same-source pairs are never compared at all — was 78% of review-queue noise before the fix; visibility counters (`same_source_skipped`, `same_source_cadastral_collisions`) instead of silent dropping.
- **Floor-conflict veto** (#186, `floors_conflict()`): a disagreeing floor on both sides vetoes photo_hash auto-merge outright and is surfaced in `detail` even when it doesn't veto — caught a real false-merge (10º vs. "a partir de la 15ª", same photos/price, 6m² apart).
- **Auto-merge is narrow and evidence-gated** (#188): only a *perfect* (`ratio == 1.000`) photo-hash match, corroborated by size AND price proximity, not vetoed by a floor conflict. Everything weaker files as a `pending` suggestion for human review.
- **Pending suggestions are re-evaluated every run**, not frozen (D-024/#214) — the day-one bug this fixed (193 of 196 suggestions stuck `pending`, some scored while Milanuncios photos were entirely unhashable) is exactly the "stale evaluation" failure mode the owner's "better evaluation" ask is pointed at.
- **Photo hashes persist per-URL** (D-025/#221) — 46 min → 0.5s on the live corpus, with a from-incident set of rules (own connection, 7-day failure retry, never counted as health when served from cache) that specifically avoid reintroducing the invisibility problem the optimization itself could have caused.
- Review queue: `suggested_merge` (status `pending`/`confirmed`/`rejected`/`conflict`, `match_basis`, `confidence`, `detail`, `resolved_at`), `dashboard/app/admin/dedup/page.tsx` + `PropertyPairQueue.tsx`, confirm/reject/resolve-conflict API routes and CLI equivalents (`ps dedup confirm|reject|resolve-conflict`).

**What's still weak.**
1. **No per-signal precision tracking.** `suggested_merge` already carries everything needed (`match_basis`, `status`, `resolved_at`) to compute "of the suggestions filed on `photo_hash` evidence, what fraction did the owner confirm vs. reject, over time" — but nothing aggregates it. This is exactly the kind of signal that would tell the owner (and future engine tuning) which of the six signals is actually noisy in practice vs. which is over-trusted — precisely the "better evaluation" ask, and the data already exists; it just needs a query and a small view.
2. **O(n²) pairwise scan has a known, documented cliff, not yet hit.** `evaluate_pair`'s own module docstring measures ~13.3µs/pair, extrapolating to ~11 minutes of pure CPU at n=10,000 (~50M pairs), and explicitly names blocking/bucketing by geography+price as the fix, deliberately not built yet ("not worth building against a database with a few dozen listings"). Given the connector-batch issues in flight (#132 tracking ~15 more REO-portal connectors), this cliff is closer than it was when the docstring was written. Not urgent today; worth a watch-line in this roadmap so it isn't rediscovered as an incident.
3. **The review queue has no priority ordering or batching aid.** `PropertyPairQueue.tsx` (21-line page, thin wrapper) presumably lists pending suggestions in a fixed order — worth confirming whether high-confidence-but-not-quite-auto-merge suggestions (e.g. `photo_hash` ratio 0.95–0.999) are surfaced ahead of low-confidence `fuzzy` suggestions, since the owner's review time is the scarce resource, not engine compute.
4. **Orphaned `property` rows are documented but not addressed** (D-024 already flagged this explicitly as "no code change... nothing in the issue asked to remove" — not a gap in this roadmap's scope, just noting it's a known, accepted, and already-documented one so nobody re-discovers it as new).

**Proposed approach.**
1. **A per-signal confirm/reject-rate view** — one query over `suggested_merge GROUP BY match_basis, status`, trended if `resolved_at` history is long enough to bucket by week/month. Surface it on `/admin/dedup` alongside the queue, not a new page. This is the single highest-value/lowest-cost proposal in this whole document — no schema change, existing data, direct answer to "which signals do I actually trust."
2. **Sort/prioritize the review queue by confidence** (or at minimum group by `match_basis`) so the owner works through the highest-value suggestions first — a UI-only change to `PropertyPairQueue.tsx`'s query, contingent on confirming today's order is in fact unordered/creation-order.
3. **Flag the O(n²) cliff as a phase trigger, not a task**: revisit blocking/bucketing once total listing count approaches the ~15-20k range the docstring already names (worth checking current count against this threshold periodically — e.g. surfaced by the "pipeline health" strip in §4.4 as a simple total-listings gauge, so it's visible without anyone having to remember to check).

**Phasing.** (1) is a strong, cheap first item — independent of everything else in this document. (2) follows once (1)'s data suggests it's worth prioritizing by. (3) is not a task to schedule now, just a documented trigger condition.

---

## Cross-cutting findings (genuinely broken or risky, not just missing)

1. **`/api/data-health` → `FreshnessContext` → `TopBar`'s freshness indicator is dead on every page load.** It queries `etl_watermarks` for PowerShop-era table names that the connector pipeline never writes. It degrades to a silent empty/false-negative result rather than erroring, so it never *looks* broken — it just never tells the owner anything true about connector health. See §4, finding 2. **This is the most actionable, lowest-effort fix in this whole document** and should probably be pulled forward independent of the rest of the roadmap's sequencing.
2. **Withdrawal detection is dormant for 7 of 9 connectors, and — per D-030 — is now *forced off* for full-inventory connectors on most runs too**, since scope-rotation makes "some scope skipped for budget this run" the normal outcome rather than the exception. The result: almost nothing in this system currently ever marks a listing `sold`/`withdrawn`/`expired` through automated means. See §6. Not a bug in any single commit — each individual decision (D-030's caution, `discovers_full_inventory`'s evidence gate) was the right call in isolation — but the emergent state across all of them is close to "staleness detection barely exists," which the owner should know explicitly rather than discover from a stale candidate.
3. **`etl_manual_trigger` / `POST /api/etl/run` looks wired but is dead** (`501`, documented in `ARCHITECTURE.md`, but easy to miss unless you go looking). Anyone reading only the schema or only the dashboard route in isolation would reasonably assume ad-hoc triggering already works.
4. **#66's soft-block-vs-removed distinction was only ever built for one connector (Milanuncios) and only for the "confirmed soft-block" half** — its own code comment is explicit that the "genuinely removed" half remains unresolved. Anyone reading `MilanunciosSoftBlockError`'s existence in isolation could reasonably assume issue #66 is fully closed out; it's closed as an issue, but its second acceptance criterion was never met.

---

## Suggested phasing summary

Not a commitment — see the proposed issue list delivered alongside this document for the concrete, owner-approvable sequence. Rough shape:

1. Fix the dead freshness indicator (cross-cutting finding 1) — independent, immediate.
2. Revive `etl_manual_trigger` (§3) — unblocks §1's run-now button and §5's quick-refresh.
3. `connector_run_results` failure-classification column, landed together with #109's scope column (§4) — same table, same call site, do them in one migration window.
4. Listing-level staleness surfacing (§6.1) — cheap, high-value, existing column.
5. Per-signal dedup precision view (§7.1) — cheap, high-value, existing data.
6. Quick-refresh-on-profile-change (§5) — depends on (2).
7. Everything else in this document, roughly in the order each section lists it.
