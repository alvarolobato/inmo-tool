---
id: D-152
title: Per-profile connector selection lives in scope.connectors, enforced in one place
date: 2026-08-21
group: Product / candidate feed
rule: "Per-profile connector selection lives in `scope.connectors` (`\"all\"` default | non-empty registry-validated list), enforced ONLY inside scope-query's active-sale EXISTS so matched/feed/assessment inherit it. Effective sources = selection ∩ globally-active (D-055); a global off always wins and the UI greys it, never hides it."
---

# D-152: Per-profile connector selection lives in `scope.connectors`, enforced in one place

*Decided: 2026-08-21*

**Context**: Issue #660 (part of #658's per-profile connector-selection design, itself gated on #659's unfiltered-scope sentinels). A profile could not say "only these sources" — matching was connector-blind. The owner wants a "novedades" profile that takes small portals wholesale and filters in the list; without connector selection, an unfiltered profile takes the entire pool (11,660 properties at design time — a feed join 60–80× the largest existing profile, and thousands of newly assessment-eligible properties per Fable's #658 judgement comment).

**Decision**:
- State lives in `search_profile.scope.connectors`: `"all" | string[≥1]`.
- The Zod field (`dashboard/lib/profiles-schema.ts`) is `.optional()`, not `.default("all")`. A new helper, `effectiveConnectors(scope)`, normalizes `undefined` to `"all"` for every real consumer (`scope-query.ts`, `scopesEqual`, `ProfileForm`, the captura resolver). This is a deliberate divergence from the design comment's literal `.default("all")` wording — see "Alternatives rejected" below.
- **Single enforcement point**: `buildScopeFunnelStages` (`dashboard/lib/filtering/scope-query.ts`) folds `AND listing.source = ANY($n::text[])` into the SAME unconditional active-sale `EXISTS` that already gates geography/D-016, only when `connectors !== "all"`. Every downstream consumer (feed, counts, scoring, assessment eligibility) keys off `profile_listing_state.matched`, so they inherit the restriction with zero additional code, and it rides `scopesEqual` into D-040's quick-refresh for free.
- **Precedence vs. D-055**: effective sources = profile selection ∩ globally-active connectors. This is composition, not a new implementation — D-055's `disabled_sources`/`activeSourceClause` CTE keeps hiding a globally-off source's listings at every read site regardless of what a profile selected; a profile's "on" can never resurrect a globally-disabled connector. The ProfileForm picker shows a globally-disabled connector greyed with a "desactivado globalmente" badge rather than hiding it.
- Server-side validation: `dashboard/lib/db/connectors.ts`'s `unknownConnectorNames()` checks a profile's selection against `connector_registry` (any row, not just `registered = true` — a deregistered connector's historical `listing.source` data is still a legitimate selection target) at POST `/api/profiles` and PATCH `/api/profiles/[id]`; an unknown name 400s naming the connector.
- ETL crawl-scope narrowing: `etl/orchestrator.py`'s `_active_profile_scopes` is UNCHANGED (its signature/tests are load-bearing elsewhere); a new `_profile_connector_selections` + `_restrict_profile_scopes_to_connector` pair runs per connector inside `run_all_connectors`'s loop, dropping a scope every contributing profile excludes and trimming `profile_ids` (never dropping) when only some profiles exclude it, keeping issue #530 attribution honest. `publish_search_previews` skips excluded (profile × connector) pairs and prunes stale rows after a selection narrows.
- Captura: `dashboard/lib/search-url/resolve.ts`'s `resolveSearchTasks` skips a `CAPTURE_PORTALS` entry the profile's scope excludes (including its D-101 owner-pinned override synthesis) — the one place `/captura` and the `search-urls` API route both flow through, so nothing else needed a filter.

**Alternatives rejected**: the design comment on issue #660 proposed `.default("all")` on the Zod field. Because Zod's inferred output type makes a defaulted field non-optional, that would have required every one of the ~50 pre-existing `Scope` object literals across the test suite (predating this issue) to spell out `connectors: "all"` for zero behavioural gain. `property_types`/`geography` never had this retrofit cost because they were required from the schema's original design, before those fixtures existed. `effectiveConnectors()` gives the same "absent means all" guarantee at every real call site without the blast radius — genuinely different from the property_types/geography sentinels this project's D-013/D-147 pattern targets, because an absent `connectors` degrades to the SAFE "no restriction" behavior by construction (no NULL-bind-to-zero-rows landmine to guard against).

**Rationale**: one SQL clause, one place, keeps the feed/scoring/assessment chain honest without a second WHERE to drift (this repo has been bitten twice by exactly that duplication pattern per the issue's own warning). Composing with D-055 instead of reimplementing it means the "why is X empty" answer (greyed + badged, never silently hidden) stays a single source of truth.

**See**: issue #660, #658 (Fable's judgement comment), D-013, D-147 (unfiltered-scope sentinels), D-040 (quick refresh), D-055 (single connector toggle), D-101 (profile-connector-filter override), D-016 (rentals reuse listing table).
