---
id: D-047
title: Soft-block (rate-throttle) stops are a clean run outcome, not an error
date: 2026-08-05
group: Data / connectors
rule: 'Soft-block (site rate-throttle) errors are a `SoftBlockError` and a CLEAN run outcome, never `failed`/`circuit_open`: they trip the breaker only at a separate looser `soft_block_error_rate_threshold` (`tripped_by` reports fatal vs soft), still count in `error_count` (#291), and a soft-block/budget stop records status `ok` + a `nota:` notice. Only fatal-error trips are `circuit_open`. Fotocasa soft threshold 0.75 (transient); Milanuncios default (hard lockout).'
order: 50
---

# D-047: Soft-block (rate-throttle) stops are a clean run outcome, not an error

*Decided: 2026-08-05*

> Numbering note: D-040..D-046 were taken at branch time; D-047 was the next
> free ID. A sibling branch (#271) may also have claimed D-047 — if so, renumber
> the later-merged one.

**Context**: Issue #270. Live `connector_run_results` showed the two biggest
scraping sources looking permanently unhealthy while actually working:
- **fotocasa** — 26 `circuit_open` vs 5 `ok`. Every run it fetched real
  listings (e.g. `sevilla-capital: discovered=1365 fetched=136 errors=7`), then
  a cluster of 7 detail-page fetches came back as Fotocasa's soft-block page
  (HTTP 200 with the `__initial_props__` payload withheld — its documented
  rate-throttling signature). 7 errors in the breaker's rolling window of 20 =
  35% > the 30% threshold, so the shared breaker tripped mid-scope and every
  remaining scope (whole cities: dos-hermanas, estepona) was "skipped for
  budget". Fotocasa is the biggest source, so a breaker trip meant lost
  city-level coverage — and the run was badged `circuit_open`, which reads as
  "broken".
- **milanuncios** — 18 `circuit_open` + 8 `failed`, zero `ok`. The `failed`
  runs were its GeeTest CAPTCHA wall raised from `discover()`
  (`MilanunciosSoftBlockError`); the `circuit_open` runs were the same wall hit
  during detail fetches. Costa del Sol (Estepona) profiles additionally logged
  `resolved but uncovered` — genuine no-coverage, already a clean per-scope
  skip, but it read as error prose.

The owner's principle: **"waiting for budget / skipped for budget is NOT an
error — it's a clean run outcome, just a notice that we couldn't load more this
time."** A connector that ingested fine and then stopped because it hit a
site-side rate cap must show green with an informational notice, not an error
state. Only genuine fetch/parse failures are errors (their root-cause reduction
is tracked separately, #291). Fotocasa zone partitioning for the coverage
half is #65.

**Decision**:
1. **Two error categories.** A new `SoftBlockError(ConnectorError)` marks
   site-side rate-throttling / bot-mitigation (an HTTP 200 with the payload
   withheld, a CAPTCHA interstitial). Everything else stays a fatal
   `ConnectorError`. `MilanunciosSoftBlockError` now subclasses it; Fotocasa's
   missing-`__initial_props__` detail case raises `FotocasaSoftBlockError`
   (its unterminated-tag / invalid-JSON cases stay fatal).
2. **Circuit breaker trips them separately.** `CircuitBreaker` gains a
   `soft_block_error_rate_threshold` (defaults to the fatal
   `error_rate_threshold` — a conservative no-op) and a `tripped_by` reporting
   `'fatal'` / `'soft'` / `None`. Fatal errors trip at the tight threshold;
   soft-blocks only at the looser one. Fotocasa sets
   `circuit_breaker_soft_block_error_rate = 0.75` (its soft-block is a
   *transient* burst, so ride through it and keep coverage); Milanuncios keeps
   the default (its block is a ~60-min hard lockout — trip promptly). A
   soft-block is still counted in `error_count`/`error_rate` — it *was* a failed
   fetch (#291) — it just doesn't trip like a genuine failure.
3. **Status reclassification (`connector_run_results.status`).**
   - `'failed'` — only a GENUINE (non-soft-block) `discover()` failure, or the
     unresolvable-geography-with-no-successful-scope case (unchanged).
   - `'circuit_open'` — only a breaker trip driven by **fatal** errors
     (`tripped_by == 'fatal'`). This is the "something is really wrong" signal.
   - `'ok'` — every BUDGET/SOFT-BLOCK outcome: a soft-block breaker trip, a
     `discover()` soft-block backoff, and scopes skipped-for-budget. An
     informational Spanish notice (prefixed `nota:`) is folded into `error_msg`
     ("no se cargaron más ... por presupuesto"), and soft-blocked scopes are
     recorded in `skipped_scopes` with `reason` `budget` / `soft_block`.
   - "resolved but uncovered" stays a clean per-scope skip (`reason=uncovered`),
     never `failed` (was already true; now explicitly tested).
   `error_count` counts only genuinely-attempted failed fetches (fatal +
   soft-block); scopes never attempted (skipped-for-budget/uncovered) contribute
   0 — so a budget stop never inflates errors or the run-level
   `connectors_failed`.

**Alternatives rejected**:
- *Exclude soft-blocks from `error_count` entirely* — the owner and #291 want
  those genuine failed fetches counted so their root cause can be driven to
  zero; only the run STATUS is clean.
- *A new `'soft_blocked'` status value* — would ripple into the dashboard health
  UI + monitoring for little gain; the 3-value CHECK already has `'ok'`, which
  is what a clean budget stop is. `error_msg`/`skipped_scopes` carry the reason.
- *Never trip the breaker on soft-blocks* — a site fully in block mode would be
  hammered for the rest of the run; the looser threshold stops that while
  tolerating a transient burst.

**Rationale**: A run that ingested real listings and then got rate-limited is a
success with a footnote, not a failure — badging it `circuit_open`/`failed`
trained the operator to ignore the health surface. Separating *why* the run
stopped (genuine failure vs. site throttling) makes the status honest: green for
"we hit our budget, back next run", red only for "the connector is actually
broken".

**See**: issue #270 (this), #291 (drive genuine fetch errors to zero), #65
(fotocasa zone partitioning for coverage), D-030 (scope fairness rotation),
D-017/D-028 (Milanuncios rate). Files: `etl/connectors/circuit_breaker.py`,
`etl/connectors/base.py` (`SoftBlockError`), `etl/connectors/fotocasa.py`,
`etl/connectors/milanuncios.py`, `etl/orchestrator.py` (`run_connector` /
`run_all_connectors` status logic). Tests: `etl/tests/test_circuit_breaker.py`,
`etl/tests/test_orchestrator.py::TestSoftBlockCleanOutcomes`.
