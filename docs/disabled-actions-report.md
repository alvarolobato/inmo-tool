# AI workflow cost tiers — and the 2 workflows still disabled

> Análisis de coste y tiers para los workflows AI. Fecha original: 2026-05-07. Los 19 de 21 workflows desactivados han sido reactivados; quedan 2.
>
> Asume Claude vía `anthropics/claude-code-action@v1` con OpenRouter (Sonnet 4 ≈ $3/M input + $15/M output; Opus ≈ $15/M + $75/M; Haiku ≈ $0.80/M + $4/M).

## Tier framework

When evaluating whether to add or enable a periodic LLM workflow, classify it by this cost model:

| Tier | Profile | Monthly cost estimate |
|------|---------|----------------------|
| **0 — No LLM** | Bash + `gh` CLI only | $0 |
| **1 — Cron, Haiku/Sonnet, low cost** | Scheduled, single comment/issue per run | ~$1–8/workflow |
| **2 — Cron, Opus/Sonnet, medium cost** | Scheduled, longer context or expensive model | ~$30–60/workflow |
| **3 — Event-driven with multiplier** | Fires on user events; ráfagas can multiply x5–x10 | $300–800+/month if busy |

For Tier 3 workflows, require `concurrency:` per-PR/per-issue, capped `max_turns`, and explicit retry limits before enabling.

## Workflows still disabled (2)

### `ai-docs-patrol.yml.disabled`

- **What it does**: Detects drift between docs and code (Haiku, 20 turns, ~10 min/run).
- **Schedule**: Tuesday 14:00 UTC (4×/month).
- **Estimated cost**: ~$1–2/month.
- **Why still disabled**: Low priority relative to active factory load. Enable when doc drift becomes a recurring pain point.

### `ai-security-audit.yml.disabled`

- **What it does**: Runs `npm audit` + `pip-audit` + Claude review for security issues (Haiku, 20 turns, ~12 min/run).
- **Schedule**: Friday 10:00 UTC (4×/month).
- **Estimated cost**: ~$1–2/month.
- **Why still disabled**: Low priority. Enable when security scanning becomes part of the regular release gate.

## To enable a disabled workflow

Rename from `.yml.disabled` to `.yml` — no other changes needed. Per [D-029](decisions/D-029-no-worker-workflows.md), only humans commit workflow file changes.
