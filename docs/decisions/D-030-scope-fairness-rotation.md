---
id: D-030
title: Scope order rotates + prioritises never-crawled scopes (fixes permanent starvation)
date: 2026-08-04
---

# D-030: Scope order rotates + prioritises never-crawled scopes (fixes permanent starvation)

*Decided: 2026-08-04*

**Context**: Issue #217. The owner created a "Pisos en Estepona" profile; it
showed 0 candidates, nearest property 112.5 km away. The profile was live
for the next connector sweep and Fotocasa's `_CITY_SLUGS` covers Estepona,
but the run only shows `scopes ok: dos-hermanas`. Root cause: `run_connector`
shares one circuit breaker across every scope a connector processes in a
run (issue #71, deliberate), and Fotocasa's soft-block is volume-cumulative
— it reliably trips during the very *first* scope in `scopes`' fixed list
order. Every later scope is skipped outright, every run. Whichever
geography happens to sort first (or wherever skip-if-seen, #143, and zone
partitioning, #65, keep it productive) permanently consumes the whole
budget; every other profile's area stays empty indefinitely, with no
error — the run reports `circuit_open`, which reads as a connector problem,
not "your new profile was never looked at".

**Decision**: Reorder `scopes` before the per-scope loop each run
(`etl.orchestrator._order_scopes_by_fairness`), instead of leaving it in
whatever order `_active_profile_scopes`/`_scopes_for_connector` produced.
Sort ascending by a new `connector_scope_state(connector_name, scope_key,
last_attempted_at)` table's `last_attempted_at` — absent (never attempted)
sorts first, via a `_NEVER_ATTEMPTED` sentinel below any real timestamp.
`_record_scope_attempt` bumps a scope's row the moment `run_connector` is
about to be called for it (before the call, so a crash mid-scope still
counts it as "looked at"; unconditionally, not only on success, so a
scope whose `discover()` keeps failing doesn't also keep winning the front
of the queue forever).

One persisted field gives both halves of the issue's chosen fix direction:
- **Prioritise never-crawled scopes**: no row (or oldest row) sorts first,
  every run, until it finally gets a turn.
- **Rotate the already-crawled scopes**: whichever scope was reached this
  run gets bumped to "now", pushing it to the back of next run's order.

No separate cursor/index concept was needed — a per-scope "last attempted"
timestamp already encodes both properties, and ties among "never attempted"
scopes break by `_active_profile_scopes`' `ORDER BY id` (profile creation
order), which is what makes the bound below concrete rather than
"eventually, probably".

**Bound**: the shared breaker starts untripped every run, so the run's
first-in-order scope always reaches a real `discover()` call regardless of
whether it survives long enough to finish (that's exactly the pathological
case Fotocasa exhibits — the breaker trips during that first scope, and
every scope after it gets skipped for budget without `discover()` ever
being called). So at least one new-to-the-front scope makes real progress
per run in the worst case. A newly-created profile's scope therefore
reaches its first attempt within **U + 1 runs**, where U is the number of
*other* scopes for that connector already sitting at "never attempted" the
moment the profile is created. For the reported incident (Estepona created
against a connector whose only other scope, Dos Hermanas, had already run)
U = 0, so the bound is exactly 1 run — matching the acceptance criterion
("scope 2 is attempted on the following run") literally.

One caveat on U (PR #228 review): **editing** an existing older profile's
geography mints a new never-attempted `scope_key` carrying that profile's
low `id`, which ties-break ahead of an already-waiting newer profile. Each
such edit costs the waiting profile one extra run. Bounded unless someone
edits a profile's geography every single run.

**Skipped-for-budget vs. uncovered-geography**: `connector_run_results`
previously couldn't distinguish "this geography isn't covered by this
connector at all" (`scope_key()` returned `None` — issue #177's "resolved
but uncovered" / "no known coverage" messages) from "this geography IS
covered but didn't get a turn this run" — both just meant "no data from
this scope" from outside. Two channels now carry the distinction:

- **Structured** (the load-bearing one): `connector_run_results
  .skipped_scopes` (JSONB), an array of `{"scope": <scope_key or
  repr(scope)>, "reason": "budget" | "uncovered" | "unresolvable"}`. A
  consumer must never have to string-match prose to answer this, which is
  why the free-text message alone was not enough.
- **Human-readable**: the breaker-already-open branch still appends
  `"skipped for budget (circuit breaker already open before these scopes
  were attempted): <scope1>, <scope2>, ..."` to `error_msg` for an operator
  reading logs.

The classification is per-scope, not per-branch: when the breaker cuts a run
short, each remaining scope is resolved individually, so an *uncovered*
scope sitting behind the cut is still reported as `uncovered` (more budget
would not have helped it), a scope whose `scope_key()` returned issue
#177's `unresolvable-geography:` sentinel is reported as `unresolvable`
(`discover()` raises for it on every run by construction — see
`geography.is_unresolvable_scope_key`, and note it gets **no**
`connector_scope_state` row, because a row would make the dashboard promise
"covered, awaiting its turn" for a profile centre matching no place in the
gazetteer at all), and a scope already crawled this run under an equivalent
`scope_key` is reported as neither. Two un-reached scopes resolving to one
key are one starved target and are reported once.

**The dashboard-visible half (issue #194's zero-candidate diagnostic)**:
`connector_scope_state` rows are written for every scope a connector can
RESOLVE, not only for ones it attempts. `last_attempted_at IS NULL` +
`last_skipped_for_budget_at IS NOT NULL` = "covered, hasn't had its turn";
no row at all = "we have no record of a crawl here".

Two rules govern what may be shown to a user, both added by PR #228's
review and both pointing the same way — **every uncertainty resolves toward
claiming LESS coverage, never more**. Over-claiming reproduces exactly the
misdiagnosis #217 was filed about ("your area was crawled and is genuinely
empty" about an area nothing ever looked at); under-claiming produces "we
have no record of a crawl here yet", which is honest and self-correcting.

1. **"Attempted" is not "crawled".** `last_attempted_at` is written before
   `run_connector` and unconditionally *because* fairness requires failures
   to count as turns taken — so a scope whose `discover()` raises on every
   run carries a real timestamp forever. A separate `last_discovered_at`,
   written only after `run_connector` returns successfully, is the only
   column that may be rendered as "this area was crawled". `AreaCoverage`
   gained a fourth case, `attempted_never_succeeded`, for the difference.
2. **The stored circle is what was CRAWLED, not the profile's search
   radius.** The columns are `coverage_center_lat` / `coverage_center_lon`
   / `coverage_radius_km` and hold the **resolved municipality's own
   centroid** plus `_MUNICIPAL_COVERAGE_RADIUS_KM` (5 km, a deliberate
   under-estimate). They previously held the scope's own centre and
   `radius_km` — but `radius_km` only *tightens* which listings match
   (`resolve_place` → `nearest_place` uses it as `min(_MAX_MATCH_DISTANCE_KM,
   radius_km)`), never widens what is crawled, and it is allowed up to 200
   km. A Dos Hermanas profile at `radius_km=120` therefore claimed a 120 km
   disc for a one-municipality crawl, and `getAreaCoverage(Estepona)` — 117.8
   km away, never crawled by anyone, the very profile this issue exists for
   — returned `crawled`. Connectors that crawl *wider* than a municipality
   (Solvia's provincia sweep, D-018; BuildingCenter's national catalogue,
   D-023) are consequently under-reported, which is the acceptable
   direction. A scope with no centre, or whose centre resolves to no place,
   gets no circle and contributes no coverage claim at all.

`getAreaCoverage()` answers "has anyone crawled here?" from a lat/lon by
plain circle containment against those columns, without reimplementing any
connector's Python-side geography resolution in TypeScript. The
`geography_empty` diagnosis carries an `areaCoverage` field
(`never_crawled` / `awaiting_turn` / `attempted_never_succeeded` /
`crawled`) and the UI renders different advice from each.

**Blast radius of the scope-state writes**: `_record_scope_attempt` is
called INSIDE the per-scope `try`. Outside it, a failure there — e.g. the
connection left in a failed-transaction state by an earlier scope's DB
error — propagated out of the per-connector loop and killed the sweep for
every connector, strictly wider than the containment that existed before
this call was introduced (when the first DB touch after that handler was
inside `run_connector`). The generic per-scope handler also rolls the
connection back for the same reason.

**Withdrawal detection is effectively disabled for a connector in the
Fotocasa regime.** Because `reconcilable_union` is forced `False` whenever
any scope is skipped for budget (below), and rotation makes budget-skipping
the normal outcome of every run, a connector that trips its breaker every
run will essentially never reconcile withdrawals. That is the safe
direction — reconciling against a partial union withdraws live inventory —
but it is a real consequence worth stating rather than discovering later.

Consequence for `_order_scopes_by_fairness`: its query MUST filter
`last_attempted_at IS NOT NULL`. A NULL reaching the sort dict makes
`sorted()` raise `TypeError` comparing `None` to a `datetime`, taking down
the sweep for every connector — and semantically a NULL is "never
attempted", so it must fall through to the `_NEVER_ATTEMPTED` default and
keep its front-of-queue priority. Pinned by
`test_a_null_last_attempted_at_row_does_not_break_scope_ordering`, which
deliberately uses TWO scopes: `sorted()` on a single-element list never
compares anything, so a one-scope version of that test passes even with the
guard removed.

**Withdrawal reconciliation stays safe**: a skipped-for-budget scope was
never attempted at all — not even a failed `discover()` call, which at
least tries. `reconcilable_union` is now forced `False` the instant any
scope is skipped this way (it previously was NOT — a latent gap: the
breaker-tripped branch set `any_circuit_open = True` but never touched
`reconcilable_union`, so a `discovers_full_inventory=True` connector that
someday exhibits Fotocasa's multi-scope-starvation pattern could have had
`_reconcile_missed_discoveries` run against an incomplete union and
withdrawn live listings from the un-attempted scopes' geography — masked
today only because Fotocasa itself sets `discovers_full_inventory=False`).
Fixed as part of this change since rotation makes "some scope gets skipped
for budget" the normal, expected outcome of every run from now on, not a
rare edge case.

**Alternatives rejected**:
1. **Budget per scope, not per connector** (the issue's direction 2) —
   caps fetches per scope so no single geography can consume the whole
   run. Composes fine with this fix but doesn't by itself guarantee a
   *new* scope ever gets picked, only that an *old* one can't hog
   everything — still needed rotation/prioritisation on top to actually
   bound a new profile's wait. Left for a future PR if per-scope budgets
   turn out to matter independently (e.g. once a connector's coverage
   grows large enough that "one full scope per run" stops being an
   acceptable unit of progress).
2. **A separate integer cursor column** (rotate by index, not by
   timestamp) — rejected: doesn't fall out of "prioritise never-crawled"
   for free the way a shared `last_attempted_at` does; would need two
   persisted concepts (a boolean/nullable "ever crawled" flag, plus an
   index) doing what one timestamp already does via sort order.

**Rationale**: One persisted signal (`last_attempted_at`), one sort, no new
concept. Deterministic, stateable bound rather than "eventually, probably"
— directly answers the issue's "state the bound" requirement. Composes
cleanly with a future per-scope budget (direction 2) without either
mechanism needing to know about the other.

**See**: `etl/orchestrator.py` (`_order_scopes_by_fairness`,
`_record_scope_attempt`, `_record_scope_discovered`,
`_record_scope_covered_but_skipped`, `_scope_coverage_columns`,
`_MUNICIPAL_COVERAGE_RADIUS_KM`, the `connector_scope_state`-keyed reorder
call in `run_all_connectors`, the breaker-tripped branch's classification /
`error_msgs` / `skipped_scopes` / `reconcilable_union` handling),
`etl/connectors/geography.py` (`is_unresolvable_scope_key`),
`etl/schema/init.sql` (`connector_scope_state`,
`connector_run_results.skipped_scopes`), `etl/tests/test_orchestrator.py`
(`TestScopeFairnessRotation`, `TestScopeCoverageClaims`),
`dashboard/lib/profile-diagnostics.ts`
(`getAreaCoverage`), `dashboard/lib/profile-diagnostics-types.ts`
(`AreaCoverage`), `dashboard/components/profiles/ZeroCandidatesDiagnostic.tsx`,
issue #217, issue #71 (shared breaker/limiter across scopes), issue #177
(uncovered-geography visible handling this reuses the pattern of), issue
#194 (the zero-candidate diagnostic this feeds), issue #143/#65
(skip-if-seen + zone partitioning, the two amplifiers named in #217).
