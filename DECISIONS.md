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

## AI layer

| ID | Binding rule |
|----|--------------|
| [D-006](docs/decisions/D-006-llm-context-centralization.md) | All LLM calls go through `assembleRequest()` in `dashboard/lib/llm-context/`. No file outside that directory may import `llmComplete` or `runAgenticChat`; CI enforces it via `check-llm-context.sh`. |
| [D-007](docs/decisions/D-007-empty-knowledge-corpus-kept.md) | Keep `lib/knowledge.ts`/`scripts/build-knowledge.ts` (real call sites, intentionally empty pending Phase 4/#5). Test the empty-corpus shape contract, don't delete the machinery or invent placeholder content. |

## Product

| ID | Binding rule |
|----|--------------|
| [D-008](docs/decisions/D-008-rent-assumption-until-comparables.md) | Rent estimate is an explicit per-profile `€/m²/month` assumption (`thesis_params.rent_assumption`) until #31 ships real comparables. Never fabricate a rent figure; gate yield on the assumption being set. |
| [D-009](docs/decisions/D-009-acquisition-cost-model.md) | ITP by CCAA is general/base rate only (no brackets/reductions, no new-build path). Actual IBI/community fee from `raw_extra` ADDS to a separate assumed maintenance/vacancy %, never fully replaces it. |
