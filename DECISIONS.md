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
| [D-002](docs/decisions/D-002-humans-approve-merges.md) | Humans approve every merge. No auto-merge, even for low-risk changes, until the owner establishes trust per category. |
| [D-003](docs/decisions/D-003-review-policy.md) | Each task PR gets one fresh review pass; each phase gets one fresh cross-task review pass. Once per checkpoint — no iterating a round until "no more feedback." |
| [D-004](docs/decisions/D-004-no-worker-workflows.md) | Don't push to `.github/workflows/` without a credential that has `workflow` OAuth scope. Never bypass via the GitHub API — leave YAML staged for a human to commit. |
| [D-009](docs/decisions/D-009-restart-burst-guard.md) | A full sweep skips if a completed run finished within `etl.min_restart_sweep_interval_seconds` ago (crash-loop guard). |

## Data / connectors

| ID | Binding rule |
|----|--------------|
| [D-005](docs/decisions/D-005-numeric-vs-uuid-keys.md) | Real-estate schema tables use `BIGSERIAL` integer PKs, not `NUMERIC` (no source-system precision constraint like the archived project had) or UUIDs (no distributed-write requirement). |
| [D-008](docs/decisions/D-008-skip-if-seen-opt-in.md) | Skip-if-seen defaults to 0 (always fetch); opt in per connector. Never skip missing/changed discovery price. |
| [D-013](docs/decisions/D-013-search-profile-scope-no-default.md) | `search_profile.scope` has no DB-level default — an INSERT must supply an explicit, validated scope; a missing one fails loudly, not silently. |
| [D-017](docs/decisions/D-017-milanuncios-rate-measurement.md) | Milanuncios `rate_limit_per_minute = 2` — measured (20 and 6/min both fail identically), kept below Fotocasa's 3, not proven sufficient for a full run. |
| [D-018](docs/decisions/D-018-solvia-sitemap-partitioning.md) | Solvia `discover()` resolves a scope to a provincia only, then sweeps every municipality page the site's own sitemap lists for it (cached 24h). `discovers_full_inventory` stays `False`. |
| [D-019](docs/decisions/D-019-aliseda-not-viable-disallowed-api.md) | Aliseda (`alisedainmobiliaria.com`) not buildable: every page is a contentless JS shell; the real data API (`laravel.alisedainmobiliaria.com`) declares `Disallow: /` for all crawlers. No connector written. |
| [D-020](docs/decisions/D-020-milanuncios-photo-cdn-rule-parameter.md) | Milanuncios `normalize()` appends `?rule=detail_640x480` to any photo URL missing a query string — the CDN 404s "Rule parameter not Found" without it; headers don't help. |

## AI layer

| ID | Binding rule |
|----|--------------|
| [D-006](docs/decisions/D-006-llm-context-centralization.md) | All LLM calls go through `assembleRequest()` in `dashboard/lib/llm-context/`. No file outside that directory may import `llmComplete` or `runAgenticChat`; CI enforces it via `check-llm-context.sh`. |
| [D-007](docs/decisions/D-007-empty-knowledge-corpus-kept.md) | Keep `lib/knowledge.ts`/`scripts/build-knowledge.ts` (real call sites, intentionally empty pending Phase 4/#5). Test the empty-corpus shape contract, don't delete the machinery or invent placeholder content. |
| [D-012](docs/decisions/D-012-derived-price-signal-in-cache.md) | occupancy/redflags see a bucketed zone-median price comparison (never raw price); the exact string rendered must also be the exact `extraHashInput` passed to `getOrCompute`. |

## Product

| ID | Binding rule |
|----|--------------|
| [D-010](docs/decisions/D-010-rent-assumption-until-comparables.md) | Rent estimate is an explicit per-profile `€/m²/month` assumption (`thesis_params.rent_assumption`) until #31 ships real comparables. Never fabricate a rent figure; gate yield on the assumption being set. |
| [D-011](docs/decisions/D-011-acquisition-cost-model.md) | ITP by CCAA is general/base rate only (no brackets/reductions, no new-build path). Actual IBI/community fee from `raw_extra` ADDS to a separate assumed maintenance/vacancy %, never fully replaces it. |
