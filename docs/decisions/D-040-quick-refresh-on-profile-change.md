---
id: D-040
title: Profile create/scope-edit triggers a quick refresh (server-side materialize + ad-hoc sweep), gated on scope change
date: 2026-08-05
---

# D-040: Quick refresh on profile create / scope-change

*Decided: 2026-08-05*

**Context**: When the owner creates a search profile or changes its geography/filters, they want data for that zone *now*, not whenever the hourly fairness rotation (D-030) reaches it. Two mechanisms already existed but weren't composed: (a) `materializeProfile` (re-runs the hard-filter engine against data already in the mirror) was triggered **client-side** from `app/profiles/page.tsx` after a save — a deliberate task-2.4 choice to avoid coupling profile CRUD to the mock route tests' call-counts, but fragile (if the browser navigates away, materialize never runs); (b) the D-038 `etl_manual_trigger` queue could enqueue an ad-hoc connector sweep, but nothing wired a profile edit to it. Issue #245.

**Decision**:
1. **Compose the two existing mechanisms server-side, in the profile CRUD routes — never a new trigger path or run loop.** A new helper `dashboard/lib/filtering/profile-refresh.ts` (`refreshProfileForScope`) (a) calls `materializeProfile` and (b) enqueues a **full** ad-hoc sweep via `createManualTrigger(null, "profile-refresh")` — the exact D-038 insert `POST /api/etl/run` uses. `POST /api/profiles` calls it unconditionally (a new profile always has a new scope); a scope-changing `PATCH /api/profiles/[id]` calls it too.
2. **Gate strictly on a real scope change.** `updateProfile` now returns `{ profile, scopeChanged }`; `scopeChanged` is computed with `scopesEqual` (client-safe, in `profiles-schema.ts`) — a *semantic*, order-insensitive comparison: `property_types` is a set, an absent numeric bound equals `undefined`, and an absent hard-exclusion equals an explicit `false`. A rename, a `thesis_params`-only edit, or an idempotent re-save of the same scope enqueues **nothing** and re-materializes nothing (`refresh: null`). Only geography/filters changing crosses the gate.
3. **Full sweep, not per-connector scoping.** Connectors derive their crawl scopes from *all* active `search_profile` rows, so a full sweep (`connector_name = NULL`) already covers the new geography. Roadmap §5 floated per-connector scoping; rejected here as over-engineering for issue #245's "S" size — the sweep still respects each connector's rate limiter / circuit breaker (D-038), so it can't hammer a site harder than a manual `ps connector run`.
4. **Debounce is inherited, not built.** The `etl_manual_trigger` single-pending partial unique index collapses a burst of edits onto one pending sweep; the unique-violation is reported as `already_pending` (with the existing pending id for the UI to poll), never an error.
5. **Best-effort, never fails the save.** A materialize or enqueue failure is logged and swallowed inside the helper. The routes attach a `refresh` field to their response; the client (`RefreshIndicator`) polls `GET /api/etl/run?id=` and shows a subtle "buscando datos nuevos para esta zona…" signal.

This **reverses**, for create/scope-edit, the client-side-materialize choice documented in `lib/filtering/materialize.ts` — materialization for those two paths is now server-side (robust against navigation). Clone still materializes client-side (it isn't a scope change, so not a quick-refresh caller).

**Alternatives rejected**:
- *Keep materialize client-side and only add the crawl enqueue* — leaves materialization fragile (lost on navigation) and can't be asserted at the route level against real Postgres, which is exactly the coverage #245 asks for.
- *Per-connector scope filtering of the sweep* — real value is marginal (a full sweep already covers the scope) and it duplicates scope-resolution logic; deferred, not built.
- *A generic deep-equal / JSON.stringify scope comparison* — over-reports: reordering the property-type checkboxes, or toggling a filter on then off, would enqueue a redundant crawl. `scopesEqual` encodes the intent precisely.

**Rationale**: One trigger path (D-038), one run lock, one materialize function — an ad-hoc sweep from a profile edit is observably identical to any other ad-hoc run, and the candidate list is fresh the instant the save returns. The strict scope-change gate keeps a rename from crawling every site.

**See**: `dashboard/lib/filtering/profile-refresh.ts`, `dashboard/lib/profiles-schema.ts` (`scopesEqual`), `dashboard/lib/db/profiles.ts` (`updateProfile`), `dashboard/app/api/profiles/route.ts`, `dashboard/app/api/profiles/[id]/route.ts`, `dashboard/components/profiles/RefreshIndicator.tsx`, `dashboard/app/api/profiles/__tests__/quick-refresh.integration.test.ts`, `docs/roadmap/connector-etl-ops.md` §5. Related: [D-038](D-038-adhoc-etl-run-lock.md) (the mechanism this calls), [D-030](D-030-scope-fairness-rotation.md) (the fairness bound this accelerates past), [D-013](D-013-search-profile-scope-no-default.md) (scope shape). Issue #245.
