---
id: D-144
title: Estado board derives per-source health from the listing table, worst-of status, capture sources never red from time alone
date: 2026-08-21
group: Data / connectors
rule: "Per-source health (`/admin` Estado board, TopBar dot) is derived from `listing` activity (Frescura/Volumen), not run/capture outcomes; status = worst-of `fresco/pendiente/atascado/fallando` in one pure module (`lib/source-health.ts`). A capture source reaches `atascado`/`fallando` ONLY via an error signal (failed captures, stale heartbeat) — NEVER from elapsed time alone (issue #638, see D-125 for the freshness-cycle model this does NOT replace)."
---

# D-144: Estado board derives per-source health from the listing table, worst-of status, capture sources never red from time alone

*Decided: 2026-08-21*

**Context**: Issue #638 (part of #636) — every inherited monitoring surface
equated "healthy" with "the last run returned `status='ok'`", and that lies.
Verified in production (2026-08-20): fotocasa's last 4 runs all reported `ok`
(a soft-block notice, D-047 — correctly, as run semantics go) while the
source ingested zero listings for ~40 hours; every existing surface showed it
green. Browser-captured portals (idealista, aliseda, altamira, hipoges) never
produce a `connector_run` at all, so a run-centric view is structurally blind
to roughly half the ingest. The #636 addendum sharpened a second, related
risk: capture is owner-paced and bursty (measured: 2,175 captures on one day,
zero on several others, nothing at all for a 9-day stretch) — a naive
"due past N hours ⇒ red" rule on that shape reports the owner's calendar as
portal failure, not a real problem.

**Decision**:
1. **Ground truth is the `listing` table**, not run/capture outcomes.
   Frescura is `MAX(GREATEST(last_seen_at, last_fetched_at, first_seen_at))`
   per `listing.source` (the same triple `lib/db/data-health.ts`'s
   stale-profile check already uses) vs. the source's due window
   (`connector_config.freshness_interval_hours`, else the crawl or capture
   default). `connector_run_results` (D-079 `failure_classification`) and
   `extension_capture`/`extension_heartbeat` feed the Errores signal ONLY —
   they explain a problem, they never define "healthy" by themselves.
2. **One status enum, one pure module.** `fresco / pendiente / atascado /
   fallando`, worst-of, implemented once in `lib/source-health.ts`
   (`deriveSourceStatus`) and consumed by both the aggregation
   (`lib/db/source-health.ts`, `GET /api/etl/source-health`) and the
   `/admin` Estado board. Crawl thresholds: `fallando` = a classified fatal
   run (`status IN ('failed','circuit_open')`); `atascado` = past 2x the due
   window, OR soft-blocked (D-047) with no new data past 1x the window (the
   fotocasa case); `pendiente` = due, no error signal; else `fresco`.
3. **A capture source is NEVER `atascado`/`fallando` from elapsed time
   alone.** Past its window with zero error signal, it is `pendiente`
   ("tu acción: capturar" — amber, owner-actionable), full stop, no matter
   how many days have elapsed. Reaching `atascado` requires a captured
   partial-failure rate > 0 in the trailing 7 days (`extension_capture`
   `failed`/`(failed+done)`) or a long-stale `extension_heartbeat`
   (`CAPTURE_HEARTBEAT_STALE_DAYS = 30` — deliberately far longer than the
   measured burst gaps, so it means "the tooling looks abandoned", not "the
   owner hasn't opened the browser today"); `fallando` requires that failure
   rate to reach 50%+ (majority of recent attempts failing).
4. **Disabled sources (D-055) are excluded from the worst-of rollup and
   rendered in their own collapsed section** — never mixed into the ranked
   problem list, regardless of how stale their (ignored) data is.
5. **This does NOT replace `getConnectorFreshness()`/`connector_freshness_state`
   (D-050, D-125)** — that machinery answers a different question ("has this
   connector's discovery CYCLE completed"), still backs `/api/data-health`,
   `/api/ready`, `/etl/salud`, and `/etl/connectors`' own per-connector pill,
   none of which are in #638's scope. The TopBar dot (`FreshnessContext`) is
   the one thing repointed: it now polls `/api/etl/source-health` and derives
   its pill copy from the worst-of `SourceStatus` rollup instead of the old
   cycle-based `DataHealthResponse`. **This is now a deliberate divergence**:
   the dot and `/etl/connectors`' own pill can legitimately disagree on the
   same connector (e.g. a cycle-incomplete-but-actually-fresh crawl source) —
   see `connectors-freshness-agreement.integration.test.ts`'s amendment note.
6. **Volumen's "nuevos 24h" is `first_seen_at`-only, never a re-sighting
   count.** An earlier cut of the aggregation counted
   `GREATEST(last_seen_at, last_fetched_at, first_seen_at) > NOW() - 24h` —
   which, on a full-catalogue-resweep connector like cimenta2, read
   "+3886 en 24h" on a day it ingested ZERO new listings, because a resweep
   touches `last_seen_at`/`last_fetched_at` on its whole existing catalogue.
   `new24h` counts `first_seen_at` only; the 7-day sparkline stays the looser
   GREATEST-based "tocados" signal, per #636's own metric table (which
   reserves nuevos/tocados specifically for the sparkline) — never rendered
   with a "nuevos" caption.
7. **The capture Errores signal requires `extension_capture.connector_name`
   to actually be set on failed rows.** It wasn't: `etl/capture.py`'s success
   paths set it, `_mark_failed` never did — every historical failure
   (including the exact hipoges pair the owner cited in #636's addendum) was
   unattributed, making `captureFailed7d`/`captureFailureRate7d`
   permanently 0 in production. `_mark_failed` now takes an optional
   `connector_name`, passed at every call site that already knows it
   (`normalize()` raising `ConnectorError`; the outer per-iteration
   catch-all in `process_pending_captures`, reset per-loop-iteration so it
   can never leak a prior URL's connector onto this one's failure record).
   The aggregation query ALSO falls back to a URL-hostname match
   (`dashboard/lib/db/source-health.ts`, kept in lockstep with
   `dashboard/lib/worklist.ts`'s `CAPTURE_PORTALS`) for any row that still
   ends up NULL, so historical rows aren't permanently invisible either.

**Known forward risk (flagged, not yet mitigated)**: issue #639 (in flight)
makes a captured RESULTS PAGE bump `last_seen_at` for every already-known
listing it lists — correctly fixing #639's own, narrower problem (staleness
badges reading pessimistic for captured portals). But Frescura here (point 1
above) folds `last_seen_at` into its "last data activity" signal. Once #639
lands, ONE idealista results-page capture will make Frescura read `fresco`
for the WHOLE source (e.g. "idealista · fresco · +0 en 24h", since `new24h`
is `first_seen_at`-only per point 6 and a sighting never touches it) even
though nothing NEW was actually captured that day — a milder, narrower
version of the exact "green but nothing happened" lie this design exists to
kill, just scoped to Frescura instead of Volumen. Point 6's fix already
prevents the sighting from inflating the headline NEW count; it does not
prevent it from prematurely clearing Frescura's `pendiente` state. Whether
that's acceptable (a sighting IS *some* real signal the portal was checked,
even if nothing new arrived) or needs its own guard (e.g. requiring an
actual `first_seen_at` OR a captured/fetched detail page, not a bare
sighting, to count toward Frescura for capture sources) is an open question
for whoever picks this up once #639 ships — not decided here.

**Alternatives rejected**:
- *A single composite health score.* Rejected by the #636 design judgement
  itself — it hides which source is broken, and the owner asked "which".
- *Success-rate-of-runs as the headline metric.* Rejected — it is the exact
  signal that lied (fotocasa's 4/4 `ok` runs while starving).
- *Reading `capture_task_run` for capture coverage/activity.* Rejected per
  the #636 addendum's own measured evidence: a single "Capturar todo" click
  (D-113) stamps ten distinct tasks with the identical `last_run_at` to the
  second — that ledger records a button press, not a capture. Only real
  `extension_capture` activity counts (D-048 already said this; #638 is the
  enforcement site).
- *A fixed "N days unseen ⇒ red" rule for capture sources.* Rejected outright
  by the #636 addendum's own math: applying that today would flag ~1,100 of
  idealista's 3,274 active listings as stale purely because the owner hadn't
  captured, not because anything is wrong.

**Rationale**: the fix is a change of ground truth, not a reskin — deriving
health from the one ledger both ingest paths (crawl + capture) actually write
makes crawl and capture commensurable in one vocabulary, so the owner never
has to know which path a portal uses to read its status honestly. Keeping the
derivation in one small, pure, unit-tested module (rather than duplicating
threshold logic in the aggregation query or the UI) is what makes both the
"starving-but-green" and "bursty-capture-must-not-page" cases independently
testable and hard to silently regress.

**See**: issue #638, issue #636 (parent judgement + owner addendum), D-047
(soft-block clean outcome), D-048 (task-driven captura — coverage-from-real-
activity precedent), D-050/D-125 (the freshness-cycle model this does not
replace), D-055 (disabled-source semantics), D-079 (failure_classification),
D-092 (zero-result regression — a sibling "surface what's already computed"
precedent), `dashboard/lib/source-health.ts`, `dashboard/lib/db/source-health.ts`,
`dashboard/app/api/etl/source-health/route.ts`, `dashboard/app/admin/page.tsx`,
`dashboard/components/FreshnessContext.tsx`.
