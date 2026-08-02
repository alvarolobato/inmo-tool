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

## Data / connectors

| ID | Binding rule |
|----|--------------|
| [D-005](docs/decisions/D-005-numeric-vs-uuid-keys.md) | Real-estate schema tables use `BIGSERIAL` integer PKs, not `NUMERIC` (no source-system precision constraint like the archived project had) or UUIDs (no distributed-write requirement). |

*(Phase 1 tasks 1.3–1.4 will add connector-framework decisions here as they're made)*

## Product

*(none yet — see issue #1 for the functional spec this project is implementing; decisions get added here as design questions are actually resolved during implementation, not speculatively)*
