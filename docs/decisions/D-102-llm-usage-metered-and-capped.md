---
id: D-102
title: Every LLM path records real usage, and the daily budget gates every provider
date: 2026-08-17
group: AI layer
rule: Every LLM execution path (single-shot AND agentic, all providers) writes an `llm_usage` row with REAL tokens; CLI usage/cost comes from the `claude -p` JSON envelope (`usage` + `total_cost_usd`), never a hard-coded zero. `checkDailyBudget` sums every provider — the `cli` exemption is retired.
---

# D-102: Every LLM path records real usage, and the daily budget gates every provider

*Decided: 2026-08-17*

**Context**: The owner reported the LLM layer "burning my account really fast" and, separately, that "the stats aren't great for claude cli". The two turned out to be the same problem: under the DEFAULT provider (`cli`, D-025) the dashboard recorded no spend at all, so nothing could be diagnosed, surfaced, or capped.

Three independent holes, all confirmed in the code:

1. **`llm-client.ts` logged `EMPTY_USAGE` for every CLI call.** The single-shot path ran `claude -p --output-format text`, a format that carries no usage envelope, then wrote a row of zeros. `llm-usage.ts` reinforced it: `estimatedCost` was computed only for `provider === "openrouter"`, so every `cli` row stored `$0`.
2. **The agentic path never called `logUsage` at all — on any provider.** `assemble.ts` computed `AgenticUsageTotals`, returned them to its caller, and no caller persisted them. Every chat turn (up to 8 tool rounds, each a full model call) was invisible to `llm_usage`, to the `/etl/salud` cost panel, and to the budget. The CLI agentic adapter additionally hard-coded `usage: {prompt_tokens: 0, ...}` per round.
3. **`checkDailyBudget` returned early when the provider was `cli`**, and its query filtered `llm_provider = 'openrouter'` anyway. The only hard stop the assessment scheduler has (`BudgetExceededError`) could therefore never fire in the owner's setup — the scheduler could run 5 properties × 6 flows every 15 minutes, indefinitely, uncapped and unmetered.

The data was there the whole time. Verified live against the installed binary:

```json
{"result":"OK","total_cost_usd":0.0176284,
 "usage":{"input_tokens":9,"output_tokens":36,
          "cache_creation_input_tokens":7521,"cache_read_input_tokens":18134}}
```

`--output-format stream-json`'s terminal `{"type":"result"}` line carries the same fields per round.

**Decision**:

- Every LLM execution path writes an `llm_usage` row: single-shot (`llm-client.ts`), agentic (`llm-context/assemble.ts`, at the one seam every agentic run passes through), and history summarisation (`llm-context/history.ts`, whose CLI branch also logged nothing).
- CLI usage is parsed from the CLI's own envelope by `llm-provider/cli/usage.ts` and threaded through unchanged. `input_tokens` maps to `prompt_tokens` and cache counters stay separate — Anthropic reports them exclusively, the same normalisation `logUsage` already documents for OpenRouter.
- `total_cost_usd` is stored via `LogUsageOptions.reportedCostUsd` and wins over the rate table: it is the provider's own list-price figure for that call, not an estimate we have to keep in sync.
- **Unreported is not zero — as a code convention, not a storage guarantee.** The parser returns `null` rather than inventing zeros from a present-but-unparsed envelope, and every consumer inside the process can tell the difference. At the DB layer `null` still coalesces to `0`, so a stored zero remains ambiguous; distinguishing them there needs a `cost_source` column, filed as a follow-up. Until then a `cli` row with `total_tokens = 0` is a *suspicion* that something drifted, worth surfacing as a canary on `/etl/salud`.
- `total_tokens` on a `cli` row is `prompt + completion`, **excluding** the cache counters — the same column semantics as the OpenRouter path, because `/admin/usage` sums that column across providers and a mixed sum has to mean one thing. Cache volume has its own two columns.
- `checkDailyBudget` sums `estimated_cost_usd` across **all** providers. Rows written before this change store 0 and contribute nothing.

**Two honest caveats about the CLI cost figure**, both properties of the CLI rather than of this plumbing:

1. **Under OAuth (`CLAUDE_CODE_OAUTH_TOKEN`, which is how this project authenticates — D-025) `total_cost_usd` is a notional list price, not money billed.** It is the right number for *comparing* calls and for spotting a burn, and the wrong number to treat as an invoice. A dollar cap on subscription usage therefore halts work on imaginary spend — which is why the daily budget's schema default stays unset, and why a token-denominated cap may fit this deployment better (filed as a follow-up).
2. **The cost covers slightly more than the tokens.** `total_cost_usd` prices everything the CLI did for the invocation, while the `usage` block describes the main turn only — a probe showed a small un-attributed auxiliary call included in the cost but not the counters. So the cost figure is the more complete of the two, and €/token derived from a single `cli` row will not reconcile.

**Alternatives rejected**:

- *Keep the CLI exempt from the budget because a Claude subscription is flat-rate.* The owner's complaint is precisely that it is not experienced as flat-rate. A cap that exempts the default provider is not a cap.
- *Estimate CLI cost from a local rate table.* We would be re-deriving a number the CLI already computes exactly, and would have to track model-price changes by hand. The rate table stays only for OpenRouter, where no per-call cost is returned.
- *Log usage inside the runner.* The runner is provider-agnostic and is also used in tests; `assemble.ts` is the single seam with the endpoint/requestId context the row needs.

**Rationale**: You cannot optimise what you cannot see, and you cannot bound what you do not count. This decision is deliberately about measurement and enforcement only — the reductions live in [D-103](D-103-cli-lean-invocation.md) and [D-104](D-104-assessment-failure-ledger.md), both of which are only verifiable because of this one.

**Also fixed here** (review of the first cut): `/etl/salud`'s roll-up hard-coded CLI buckets to €0 with a "subscription" comment, so the panel this decision exists to un-blank would have kept showing zero even with the rows populated. `rollUpCosts` now uses the provider-reported cost for CLI buckets, and `DEFAULT_LLM_RATES` gained the OpenRouter spelling of the new default model (`anthropic/claude-haiku-4.5`, with a dot), which would otherwise have landed in `unpriced_models` at €0.

**See**: `dashboard/lib/llm-provider/cli/usage.ts`, `dashboard/lib/llm-client.ts`, `dashboard/lib/llm-context/assemble.ts`, `dashboard/lib/llm-usage.ts`, `dashboard/lib/llm-provider/cli/agent-adapter.ts`, [docs/roadmap/llm-cost-optimization.md](../roadmap/llm-cost-optimization.md), [D-025 (archive)](archive/D-025-oauth-single-refresher.md).
