# LLM cost — forensic findings and optimization plan

Written 2026-08-17, after the owner reported the LLM layer "burning my account
really fast" and that token statistics were unusable under the Claude CLI
provider. Two independent reviews (a fresh-context Fable assessment of the
whole LLM layer, plus live probing of the installed `claude` binary) converged
on the same root cause, and it is not what anyone expected.

**The owner's own hypothesis — that unchanged listings were being re-processed
because nothing hashed the input — is wrong, and the code is already right.**
See "Confirmed NOT broken" below. The burn came from four other things, three
of which are now fixed.

---

## Summary

| # | Finding | Status |
|---|---|---|
| B1 | Under the CLI provider (the default), **every call was logged as zero tokens and zero cost** | **fixed** — D-102 |
| B2 | The daily budget kill-switch was **inert** under the CLI provider | **fixed** — D-102 |
| B3 | Every CLI call paid **~25k tokens of Claude Code harness overhead** (17.4× measured) | **fixed** — D-103 |
| B4 | A persistently-failing property was **retried every 15 minutes, forever, at full price** | **fixed** — D-104 |
| B5 | Agentic (chat) usage was **never logged at all**, on any provider | **fixed** — D-102 |
| F1–F8 | Structural inefficiencies (6 calls/property, cache erosion, two rate tables, …) | **follow-up issues** |

---

## Confirmed bugs

### B1 — Under the CLI provider, every call was logged as ZERO tokens and ZERO cost

`llm-client.ts` logged `EMPTY_USAGE` on the CLI branch, and `llm-usage.ts`
computed a cost only for `provider === "openrouter"`, so every `cli` row stored
`$0`. The single-shot invocation used `--output-format text`, which carries no
usage envelope at all.

The data was there the whole time. Live, against the installed binary:

```json
{"result":"OK","total_cost_usd":0.0176284,
 "usage":{"input_tokens":9,"output_tokens":36,
          "cache_creation_input_tokens":7521,"cache_read_input_tokens":18134}}
```

`--output-format stream-json`'s terminal `{"type":"result"}` line carries the
same fields per round; `parseStreamJsonLine` lifted only `result`/`is_error`
and dropped the rest, and the CLI agentic adapter hard-coded
`usage: {prompt_tokens: 0, …}`.

**This is the direct answer to "the stats aren't great for claude cli": they
were not poor, they were absent.**

### B2 — The daily budget kill-switch was inert under the CLI provider

`checkDailyBudget()` returned early when the provider was `cli`, and its query
filtered `llm_provider = 'openrouter'` anyway. The assessment batch's only hard
stop (`BudgetExceededError`) could therefore never fire in the owner's setup.
The scheduler defaults to 5 properties × 6 flows every 900 s — up to **2,880
LLM calls/day**, uncapped, unmetered, invisible.

### B3 — Every CLI call paid ~25k tokens of Claude Code harness overhead

`claude -p` is an agent harness, not a completion endpoint. With default flags
it prepends its own system prompt, the full built-in tool catalog, discovered
CLAUDE.md files, MCP definitions and settings files to every call. Measured on
the owner's machine, identical trivial task, same binary, back to back:

| invocation | input-side tokens | `total_cost_usd` |
|---|---:|---:|
| default flags (what the dashboard did) | 25,664 | **$0.017628** |
| lean flags (`CLI_LEAN_ARGS` + `--system-prompt`) | 167 | **$0.001011** |

**17.4×.** Our assessment prompts are ~2–4k tokens, so ~85% of every
assessment call's input was harness overhead. At the scheduler's default rate
that is on the order of tens of millions of wasted input tokens per day while a
backlog drains. None of it is useful to us: the dashboard supplies its own
system prompt, and the CLI agentic protocol has the *server* execute our tools,
so Claude's built-in tools are never called.

**End-to-end check on a real condition-assessment prompt**, run through
`claudeCliSingleShot` itself (not a hand-built command line), old config vs new:

| config | tokens | cost | verdict |
|---|---:|---:|---|
| `claude-sonnet-4-6`, full harness (**before**) | 25,173 | **$0.05343** | `a_reformar` (0.97) |
| `claude-haiku-4-5`, lean (**after**) | 759 | **$0.00319** | `a_reformar` (0.95) |

**16.7× cheaper for the same verdict** — and per fully-assessed property (six
flows) that is roughly **$0.32 → $0.019**.

### B4 — A failing flow was retried every 15 minutes, forever, at full price

On any non-budget failure (unparseable model output, empty completion, a
`LLM_CLI_*` error) the batch counted `errors += 1` and moved on, writing
**nothing**. The property therefore still matched the selection predicate
("no row for this flow at the current prompt version") and returned on the next
tick — and, since selection is `created_at ASC`, it returned *first*. Up to 96
paid retries per day per flow per poisoned property. The circuit breaker does
not help: parse errors are deliberately classified as application errors that
never trip it.

### B5 — Agentic (chat) usage was never logged at all, on ANY provider

`logUsage` had exactly three call sites, all single-shot. `assemble.ts`'s
agentic branch computed `AgenticUsageTotals`, returned them, and no caller
persisted them — so every chat turn, tool rounds included, was invisible to
`llm_usage`, the cost panel, and the budget, even on OpenRouter.

---

## Confirmed NOT broken — the owner's top suspicion

The content-hash guard the owner suspected was missing **already exists and
works correctly**:

- `computeAssessmentContentHash` (`ai-assessment/cache.ts`) hashes the sorted
  `(listing_id, description)` set, plus the bucketed price signal for
  occupancy/redflags (D-012).
- `getOrCompute` skips the LLM on a hash + prompt-version match, under a
  per-`(property, flow)` advisory lock that also prevents stampedes.
- Price churn **cannot** cascade into re-assessment: price/m²/rooms/photos are
  excluded from both the hash and the rendered prompt *by construction*
  (`formatListing(..., {hashCoveredOnly: true})`), so D-098/D-099 re-observation
  costs zero LLM calls.

No change was needed to the hit path. The one real gap — that *failed*
attempts left no trace and so were retried forever — is B4, now closed by
D-104, which reuses the same content hash as its key.

---

## What shipped in this PR

| id | change | decision |
|---|---|---|
| P1 | Parse the CLI's real `usage` + `total_cost_usd` (single-shot JSON envelope and stream-json `result` line) and thread it into `logUsage` | [D-102](../decisions/D-102-llm-usage-metered-and-capped.md) |
| P2 | Log usage on the agentic path (both providers) and on the CLI history-summariser branch | D-102 |
| P3 | Daily budget counts every provider; the `cli` exemption is retired | D-102 |
| P4 | `CLI_LEAN_ARGS` + `--system-prompt` on every CLI call, gated by `dashboard.llm_cli_lean_mode` | [D-103](../decisions/D-103-cli-lean-invocation.md) |
| P5 | Default model → Haiku 4.5 on both backends | D-103 |
| P6 | `ai_assessment_failure` ledger; park after `dashboard.assessment_max_failures` strikes on an unchanged input (409 + `?force=1` on the POST routes; infra failures exempt; 14-day decay) | [D-104](../decisions/D-104-assessment-failure-ledger.md) |
| P7 | `/etl/salud` prices CLI buckets from the reported cost instead of hard-coding €0, and knows the OpenRouter spelling of the new default model | D-102 |

---

## Follow-up round (PR #2 — spawn hardening + the quota cap)

| id | change | decision |
|---|---|---|
| H1 | `--tools ""` is unconditional — a debug toggle must not re-arm Claude's Bash/Edit tools against untrusted scraped listing text | [D-106](../decisions/D-106-cli-spawn-hardening.md) |
| H2 | EPIPE-guarded stdin — an unhandled stream error was **killing the Node process** when the CLI exited before draining a large prompt (reproduced) | D-106 |
| H3 | Neutral spawn `cwd` — the server's cwd leaked `CLAUDE.md` into prompts (measured 22,490 extra cached tokens from the repo root) | D-106 |
| H4 | Result envelope located line-by-line, so a notice printed before the JSON can't break parsing | D-106 |
| H5 | `vitest.setup.ts` isolates every test from the operator's real `config.yaml` | D-106 |
| Q1 | **Subscription-quota cap**: stop at N% of the session/weekly limit, read for free from `claude -p "/usage"` via a host-side poller | [D-107](../decisions/D-107-subscription-quota-cap.md) |

H1–H4 came from reading the sibling `obsidian-meeting-copilot` project, which
drives the same binary; each practice was verified against our own code before
adoption, and one of them (`--no-session-persistence`) measured as a no-op here
and is documented as insurance rather than a fix.

Q1 supersedes the token-allowance proxy this document previously proposed
(F-12): the real percentages turned out to be readable at zero cost, so a
hand-calibrated proxy is no longer the best available answer.

## Follow-up issues (not in this PR)

Ordered by expected saving per unit of effort.

| id | change | est. saving | effort | risk |
|---|---|---|---|---|
| F-1 | **Flow-major batch ordering** — run all `occupancy` for the tick, then all `condition`, … so each flow's stable prefix gets consecutive prompt-cache hits instead of being cycled through six different prefixes per property | 20–40% of OpenRouter input cost | S | low |
| F-2 | **Move the redflags trending/dismissed candidate blocks out of the STABLE prompt** — their counts change as rows land, so an 11k-char cacheable prefix re-caches from scratch. Needs a `REDFLAGS_PROMPT_VERSION` bump, so schedule with F-4 | 5–10% | S | low |
| F-3 | **Merge the cheap axes into one call** — `condition` + `location` + `opportunity` are three small classifications over the *identical* payload, currently billed three times. One multi-axis flow, one prompt version | ~30% of per-property calls | M–L | medium — verdict quality must be spot-checked; interacts with D-056/D-095 |
| F-4 | **Per-flow model tiers** — keep the cheapest model on `extract`/`location`/`opportunity`, buy capability only where a flow needs it (`dashboard.llm_model_openrouter_<flow>` already exists; the CLI has no per-flow equivalent yet) | 40–60% of those flows | S | low |
| F-5 | **One rate table** — `llm-usage.ts` and `lib/llm-health.ts` keep two disagreeing hard-coded price tables, so configuring a cheap per-flow model silently prices it as Sonnet in the budget math | correctness | S | low |
| F-6 | **1h cache TTL** on the stable block (`cache_control: {type:"ephemeral", ttl:"1h"}`) — the 900 s tick guarantees a cold cache every tick against the 5-minute default | 10–20% of OpenRouter input | S | low; verify OpenRouter passthrough |
| F-7 | **Pre-bump cost preview** — a `*_PROMPT_VERSION` bump instantly reopens the entire matched pool as backlog. `/etl/salud` should show "this reopens N properties ≈ €X" *before* the merge (reuse `projectBacklogCostEur`) | avoids surprise step-functions | S | low |
| F-8 | **Zero-usage canary on `/etl/salud`** — count `cli` rows with `total_tokens = 0`. After D-102 this must be 0; a nonzero count means the CLI envelope shape drifted and we are flying blind again. Render it red | regression alarm | S | low |
| F-9 | **Add `location`/`opportunity` to `ASSESSMENT_SELECTION_FLOWS`** — they are absent, so any property assessed before #388/#398 landed will never receive them. Safe to do now that D-104 bounds the retry loop | coverage (small cost increase) | S | low |
| F-10 | **Park visibility** — surface `ai_assessment_failure` (count, `last_error`, per-flow) on `/etl/salud`. The unpark path exists (`POST …?force=1`), but nothing tells the operator a property has been given up on except the scheduler's `parked=N` log line. The ledger's `last_failed_at DESC` index exists for this query | operability | S | low |
| F-11 | **`cost_source` column** on `llm_usage` (`provider_reported` vs `estimated`) — today a real CLI cost and an estimated OpenRouter cost land in the same column indistinguishably, and a stored `0` cannot be told from "nothing reported" | correctness of the canary | S | low |
| ~~F-12~~ | ~~Token-denominated daily cap~~ — **superseded by D-107**, which caps on the real subscription percentage instead of a hand-calibrated token proxy | — | — | — |
| F-15 | **Surface the quota on `/etl/salud`** — the reading, the threshold, and whether the cap is actually being enforced (a stale reading means it is not). Today only `GET /api/etl/llm-quota` exposes it | operability | S | low |
| F-16 | **Let the container read the quota directly** — mounting `~/.claude/.credentials.json` in would remove the host-side poller, but it touches D-025's single-refresher rule, so it needs care rather than a quick change | removes a moving part | M | medium |
| F-13 | **Pass the real system prompt via `--system-prompt`** — today it carries the small protocol shim (enough to displace the harness prompt) while the domain prompt still travels in stdin. Cleaner shape, but it means splitting stdin into system/task at every CLI call site | small token saving, better shape | M | low |
| F-14 | **Ledger retention** — `clearAssessmentFailures` only fires on success, so a property that fails twice and is then edited leaves one orphan row per content hash forever. Slow, unbounded growth | housekeeping | S | low |

---

## Measurement design (the target state)

**Persist** — `llm_usage` today carries `endpoint, model, prompt_tokens,
completion_tokens, total_tokens, cache_creation_input_tokens,
cache_read_input_tokens, estimated_cost_usd, llm_provider, llm_driver,
request_id`. D-102 fills these honestly for every path. Worth adding later:

- `cost_source TEXT CHECK (IN ('provider_reported','estimated'))` — today a
  reported CLI cost and an estimated OpenRouter cost land in the same column
  and are indistinguishable downstream.
- `property_id` / `assessment_type` — so assessment spend joins to
  `ai_assessment` and "€ per fully-assessed property" becomes a real query
  rather than an estimate.

**Surface** (`/etl/salud`, existing `db/llm-health.ts`): per-day series split
by provider × flow; cache-hit rate; average cost per fully-assessed property;
backlog burn-down projection (already exists); the F-8 zero-usage canary; the
F-10 parked-flow count.

**Enforce**: `checkDailyBudget` now sums every provider. For a
subscription-billed CLI user a second token-denominated cap
(`dashboard.llm_daily_token_budget`) may be more intuitive than a dollar one —
worth asking the owner before building.
