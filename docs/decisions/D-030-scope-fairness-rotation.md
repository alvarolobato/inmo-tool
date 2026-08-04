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

**Skipped-for-budget vs. uncovered-geography**: `connector_run_results`
previously couldn't distinguish "this geography isn't covered by this
connector at all" (`scope_key()` returned `None` — issue #177's "resolved
but uncovered" / "no known coverage" messages) from "this geography IS
covered but didn't get a turn this run" — both just meant "no data from
this scope" from outside. Two channels now carry the distinction:

- **Structured** (the load-bearing one): `connector_run_results
  .skipped_scopes` (JSONB), an array of `{"scope": <scope_key or
  repr(scope)>, "reason": "budget" | "uncovered"}`. A consumer must never
  have to string-match prose to answer this, which is why the free-text
  message alone was not enough.
- **Human-readable**: the breaker-already-open branch still appends
  `"skipped for budget (circuit breaker already open before these scopes
  were attempted): <scope1>, <scope2>, ..."` to `error_msg` for an operator
  reading logs.

The classification is per-scope, not per-branch: when the breaker cuts a run
short, each remaining scope is resolved individually, so an *uncovered*
scope sitting behind the cut is still reported as `uncovered` (more budget
would not have helped it) and a scope already crawled this run under an
equivalent `scope_key` is reported as neither.

**The dashboard-visible half (issue #194's zero-candidate diagnostic)**:
`connector_scope_state` rows are written for every scope a connector can
RESOLVE, not only for ones it attempts. `last_attempted_at IS NULL` +
`last_skipped_for_budget_at IS NOT NULL` = "covered, hasn't had its turn";
no row at all = "no connector covers this". Each row also stores the
scope's own `center_lat`/`center_lon`/`radius_km`, so
`dashboard/lib/profile-diagnostics.ts`'s `getAreaCoverage()` can answer
"has anyone crawled here?" from a lat/lon by plain circle containment,
without reimplementing any connector's Python-side geography resolution in
TypeScript. The `geography_empty` diagnosis gained an `areaCoverage` field
(`never_crawled` / `awaiting_turn` / `crawled`) and the UI renders three
different pieces of advice from it — "waiting will never help", "waiting is
exactly right", and the pre-existing "nothing that close" respectively.

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
`_record_scope_attempt`, `_record_scope_covered_but_skipped`,
`_scope_geo_columns`, the `connector_scope_state`-keyed reorder call in
`run_all_connectors`, the breaker-tripped branch's classification /
`error_msgs` / `skipped_scopes` / `reconcilable_union` handling),
`etl/schema/init.sql` (`connector_scope_state`,
`connector_run_results.skipped_scopes`), `etl/tests/test_orchestrator.py`
(`TestScopeFairnessRotation`), `dashboard/lib/profile-diagnostics.ts`
(`getAreaCoverage`), `dashboard/lib/profile-diagnostics-types.ts`
(`AreaCoverage`), `dashboard/components/profiles/ZeroCandidatesDiagnostic.tsx`,
issue #217, issue #71 (shared breaker/limiter across scopes), issue #177
(uncovered-geography visible handling this reuses the pattern of), issue
#194 (the zero-candidate diagnostic this feeds), issue #143/#65
(skip-if-seen + zone partitioning, the two amplifiers named in #217).
