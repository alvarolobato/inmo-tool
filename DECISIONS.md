# DECISIONS.md — Decision index

> **Purpose.** One-line binding rules so agents don't re-evaluate settled decisions. Full rationale, alternatives, and incident context live in `docs/decisions/D-NN-<slug>.md` — read those when you need the *why*.
>
> **Adding a new decision.** Write a one-liner here (binding rule, ≤180 chars) + a full file in `docs/decisions/`. See [AGENTS.md § Recording decisions](AGENTS.md#recording-decisions).
>
> Files in this index are kept terse on purpose. Don't expand entries — expand the per-decision file instead.
>
> **On the `archive/` directory**: this repo was bootstrapped from powershop-analytics, a 4D/PowerShop retail-analytics project with no relevance to inmo-tool's actual domain (real-estate investment sourcing). Its decision history (`docs/decisions/archive/D-0XX-*.md`) is kept for git archaeology — some of those decisions' *reasoning* still applies here and has been re-recorded fresh below (at new IDs, re-read rather than copied verbatim) — but none of the archived files themselves are active for this project.

## Plumbing / process

| ID | Binding rule |
|----|--------------|
| [D-001](docs/decisions/D-001-bind-mounts.md) | All container data lives in `./data/<service>/` bind mounts. Never named volumes. |
| [D-029](docs/decisions/D-029-agent-merges-after-review.md) | The coordinating agent merges once a fresh-context Opus review passes; Fable reviews phase boundaries. Escalate on CHANGES REQUIRED you disagree with, irreversible/outward-facing changes, or owner-reserved calls. Supersedes D-002. |
| [D-003](docs/decisions/D-003-review-policy.md) | Each task PR gets one fresh review pass; each phase gets one fresh cross-task review pass. Once per checkpoint — no iterating a round until "no more feedback." |
| [D-004](docs/decisions/D-004-no-worker-workflows.md) | Don't push to `.github/workflows/` without a credential that has `workflow` OAuth scope. Never bypass via the GitHub API — leave YAML staged for a human to commit. |
| [D-009](docs/decisions/D-009-restart-burst-guard.md) | A full sweep skips if a completed run finished within `etl.min_restart_sweep_interval_seconds` ago (crash-loop guard). |
| [D-032](docs/decisions/D-032-decision-id-collision-ci-check.md) | `scripts/tests/test_decision_ids.py` enforces unique decision IDs, matching frontmatter, resolvable `DECISIONS.md` links, and no stale cross-references. Sequential IDs stay — no scheme change. |

## Data / connectors

| ID | Binding rule |
|----|--------------|
| [D-005](docs/decisions/D-005-numeric-vs-uuid-keys.md) | Real-estate schema tables use `BIGSERIAL` integer PKs, not `NUMERIC` (no source-system precision constraint like the archived project had) or UUIDs (no distributed-write requirement). |
| [D-008](docs/decisions/D-008-skip-if-seen-opt-in.md) | Skip-if-seen defaults to 0 (always fetch); opt in per connector. Never skip missing/changed discovery price. |
| [D-013](docs/decisions/D-013-search-profile-scope-no-default.md) | `search_profile.scope` has no DB-level default — an INSERT must supply an explicit, validated scope; a missing one fails loudly, not silently. |
| [D-015](docs/decisions/D-015-rental-connector-site-choice.md) | Rental connector targets Milanuncios `alquiler-de-pisos`, as a `MilanunciosConnector` subclass (own file, own rate limit) — never an edit to the sale connector. |
| [D-016](docs/decisions/D-016-rental-data-reuses-listing-table.md) | Rentals are `listing` rows with `operation='rent'` — no `rental_listing` table. Every sale-candidate query (materialize, dedup) must filter `operation='sale'` explicitly. |
| [D-017](docs/decisions/D-017-milanuncios-rate-measurement.md) | Milanuncios `rate_limit_per_minute = 2` — measured (20 and 6/min both fail identically), kept below Fotocasa's 3, not proven sufficient for a full run. |
| [D-018](docs/decisions/D-018-solvia-sitemap-partitioning.md) | Solvia `discover()` resolves a scope to a provincia only, then sweeps every municipality page the site's own sitemap lists for it (cached 24h). `discovers_full_inventory` stays `False`. |
| [D-019](docs/decisions/D-019-aliseda-not-viable-disallowed-api.md) | Aliseda (`alisedainmobiliaria.com`) not buildable: every page is a contentless JS shell; the real data API (`laravel.alisedainmobiliaria.com`) declares `Disallow: /` for all crawlers. No connector written. |
| [D-020](docs/decisions/D-020-milanuncios-photo-cdn-rule-parameter.md) | Milanuncios `normalize()` appends `?rule=detail_640x480` to any photo URL missing a query string — the CDN 404s "Rule parameter not Found" without it; headers don't help. |
| [D-021](docs/decisions/D-021-haya-merged-into-solvia.md) | Haya (`haya.es`) not buildable: the whole domain 301-redirects to `solvia.es` (already ingested, D-018) — Intrum merged Haya into the Solvia servicer brand. No connector written. |
| [D-022](docs/decisions/D-022-milanuncios-photo-backfill-migration.md) | `init.sql`'s Milanuncios photo-URL backfill mirrors `add_photo_rule_if_missing` exactly, pinned by a DB-backed equivalence test — never hand-reimplement the rule in SQL. |
| [D-023](docs/decisions/D-023-buildingcenter-national-sweep-connector.md) | BuildingCenter talks to `apifrontend.buildingcenter.es` directly; `discover()` sweeps the whole catalogue and filters in-memory — no server-side filter param works. |
| [D-024](docs/decisions/D-024-dedup-pending-reevaluation.md) | `engine.run()` re-evaluates every `pending` `suggested_merge` row every run (only `rejected`/`conflict` stay frozen); an in-flight `suggested_merge_action` defers reevaluation one run. |
| [D-025](docs/decisions/D-025-photo-hash-store.md) | Photo hashes persist keyed on URL alone, failures retried after 7 days, on the store's OWN autocommit connection. The #206 health rollup counts live fetches only — never store hits. |
| [D-026](docs/decisions/D-026-sareb-not-viable-incapsula-block.md) | Sareb (`sareb.es`) not buildable: Incapsula WAF returns 403 on every path including `robots.txt`. No connector written; routes to browser-extension capture (#75) per the batch's standing WAF rule. |
| [D-027](docs/decisions/D-027-altamira-not-viable-akamai-block.md) | Altamira (`altamirainmuebles.com`) not buildable: Akamai WAF returns 403 on every path including `robots.txt`. No connector written; routes to browser-extension capture (#75) per the batch's standing WAF rule. |
| [D-028](docs/decisions/D-028-milanuncios-skip-if-seen.md) | Milanuncios (sale) keeps detail-fetching at rate 2; skip-if-seen ON at 24h despite no `discovered_prices()` net; rental subclass explicitly 0. Don't drop, don't go discovery-only. |
| [D-030](docs/decisions/D-030-scope-fairness-rotation.md) | Scope order is reordered every run by `connector_scope_state.last_attempted_at` (never-attempted first, then oldest-attempted-first) — never a fixed list order, which let one scope starve every other one forever. |
| [D-033](docs/decisions/D-033-cimenta2-not-viable-guest-api-overexposure.md) | Cimenta2 not buildable: no server-rendered content, and its only data path is a guest API leaking confidential/PII fields. Don't build on it, even scoped. Routes to #75. |
| [D-034](docs/decisions/D-034-cimenta2-sitemap-index-only.md) | Cimenta2 discovery reads the public `ga-activo` sitemap; expediente/agrupacion sitemaps aren't ingested; `national` scope_key; `discovers_full_inventory=True`. Detail-fetch now per D-035. |
| [D-035](docs/decisions/D-035-cimenta2-detail-endpoint-injected.md) | Cimenta2 detail-fetch endpoint is injected via `CIMENTA2_DETAIL_ENDPOINT` (never committed); connector is discovery-only without it. Owner-contact fields are never stored. |

## AI layer

| ID | Binding rule |
|----|--------------|
| [D-006](docs/decisions/D-006-llm-context-centralization.md) | All LLM calls go through `assembleRequest()` in `dashboard/lib/llm-context/`. No file outside that directory may import `llmComplete` or `runAgenticChat`; CI enforces it via `check-llm-context.sh`. |
| [D-007](docs/decisions/D-007-empty-knowledge-corpus-kept.md) | Keep `lib/knowledge.ts`/`scripts/build-knowledge.ts` (real call sites, intentionally empty pending Phase 4/#5). Test the empty-corpus shape contract, don't delete the machinery or invent placeholder content. |
| [D-012](docs/decisions/D-012-derived-price-signal-in-cache.md) | occupancy/redflags see a bucketed zone-median price comparison (never raw price); the exact string rendered must also be the exact `extraHashInput` passed to `getOrCompute`. |

## Product

| ID | Binding rule |
|----|--------------|
| [D-011](docs/decisions/D-011-acquisition-cost-model.md) | ITP by CCAA is general/base rate only (no brackets/reductions, no new-build path). Actual IBI/community fee from `raw_extra` ADDS to a separate assumed maintenance/vacancy %, never fully replaces it. |
| [D-014](docs/decisions/D-014-comparable-rent-estimator.md) | Rent estimate: profile's own assumption (if set) is always PRIMARY, never silently replaced; measured comparable is always attached + disagreement surfaced. No assumption → comparable is primary, tiered `high`/`low` by count+dispersion. |
