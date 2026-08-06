---
id: D-069
title: ETL run hygiene — disabled connectors and captured listing pages are neutral, not errors
date: 2026-08-06
group: Data / connectors
rule: 'Run hygiene: a disabled connector emits NO `connector_run_results` row (only the per-run `connectors_skipped` count); a captured SEARCH/listing page is `extension_capture.status=''listing''` (clean — detail links harvested to `capture_worklist` `added_via=''derived''`), never `failed`. Listing-vs-detail detection mirrored server-side in `etl/listing_detect.py` (in lockstep with `detect.js`). Health surface is green unless genuinely broken.'
order: 60
---

# D-069: ETL run hygiene — disabled connectors and captured listing pages are neutral, not errors

*Decided: 2026-08-06*

**Context**: The owner wants "clean runs" — the ETL/capture health surface should be green unless something is *genuinely* broken (issue #292, companion to #270's budget/uncovered reclassification). Two sources of false noise had accumulated:

1. **Disabled connectors read as events.** Under issue #99 a connector disabled via `connector_config.enabled = false` wrote a `status='skipped'` row to `connector_run_results` on *every* sweep. Once several connectors were born disabled (Diglo #117, Unicaja #119, Fotocasa rental #211 / D-066), that was ~63 rows across 8 connectors cluttering the health/run-history surface — a standing operator choice masquerading as a per-sweep event.
2. **Captured search/listing pages read as failures.** When the owner captured a *search/results* page (e.g. an altamira `/venta-viviendas/…`, or an idealista/aliseda results URL) the poller marked the `extension_capture` row `failed` with "No capture-capable connector recognizes this URL". That is not a failure — it is a listing page whose detail links belong on the batch-capture / mine-results path (#262/#290).

**Decision**:

1. A **deliberately-disabled connector no longer emits a `connector_run_results` row**. `run_all_connectors` skips it with no result row and only increments the per-run `connector_runs.connectors_skipped` summary (so a fully-disabled run is still distinguishable from a mystery empty one, without per-connector row noise). Which connectors are off remains visible on the connectors config page (reads `connector_config` directly). The per-sweep log drops from WARNING to INFO. The health helper `connectorHealthLevel` already treats `skipped` as neutral, so any legacy/pre-#292 `skipped` row still renders as a neutral "Omitido" badge — never amber/red, never in any attention count. A one-time idempotent migration in `init.sql` deletes the historical `status='skipped' AND error_msg='disabled via connector_config'` rows.

2. A **captured search/listing page is recorded as a clean `status='listing'` outcome**, not `failed`. `etl/capture.py` detects a listing-page URL server-side, harvests its detail links from the captured HTML, seeds them into `capture_worklist` as `added_via='derived'` (the #262/#290 batch path), and marks the row `listing` with the summary "Página de resultados — N enlaces de detalle". `failed` is reserved for genuinely broken **detail** captures. `extension_capture.status` gains `'listing'` (CHECK widened + idempotent migration). The data-health portal view surfaces a neutral `listing_7d` count and never folds it into `failed_7d`; the extension popup renders it in the neutral 📋 panel, not the ⚠️ error state.

**Listing-vs-detail detection is mirrored, not re-invented**: the extension's `browser-extension/detect.js` (`isListingPath`/`isDetailPath`, `listingPortalForUrl`/`detailPortalForUrl`, `extractDetailUrls`) is the source. There was no server-side copy, so `etl/listing_detect.py` is the *one* server mirror — its per-portal regexes and case table are kept byte-for-byte in step with detect.js (asserted by the same case tables in `etl/tests/test_listing_detect.py` and `dashboard/__tests__/extension-detect.test.ts`). The HTML harvest (`_extract_detail_urls_from_html`) reuses the canonical `worklist_match_key` for de-duplication.

**Alternatives rejected**:
- *Keep the disabled `skipped` row but only reclassify it neutral in the UI.* The UI already treated it neutral; the residual complaint was the row volume itself, so the cleanest fix is not to emit it. The lightweight `connectors_skipped` per-run counter preserves the "why was this run empty" signal without the rows.
- *Duplicate detect.js's regexes inline in capture.py* — would create a third copy that drifts. A dedicated `listing_detect.py` module with a shared case table keeps the mirror honest.

**Rationale**: A health surface only earns attention if amber/red means "act". Disabled connectors and captured listing pages are the operator's own doing, not breakage; making them neutral/informational keeps the surface trustworthy. Routing captured listing pages into the existing batch worklist turns a dead-end "failure" into useful queued work.

**See**: issue #292; `etl/orchestrator.py` (`run_all_connectors`, `_scopes_for_connector`), `etl/capture.py`, `etl/listing_detect.py`, `etl/schema/init.sql` (extension_capture CHECK + two migrations), `dashboard/lib/db/data-health.ts`, `dashboard/lib/data-health.ts`, `dashboard/app/etl/salud/page.tsx`, `dashboard/app/api/extension/capture/[id]/route.ts`, `browser-extension/popup.js`, `dashboard/e2e/data-health.spec.ts`. Related: D-041 (e2e required), D-049 (listing-gone clean skip), D-053 (batch-capture discoverability), D-066 (born-disabled Fotocasa rental).
