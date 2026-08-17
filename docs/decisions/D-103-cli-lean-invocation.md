---
id: D-103
title: CLI calls run with the Claude Code harness stripped, and Haiku is the default model
date: 2026-08-17
group: AI layer
rule: Every dashboard `claude -p` call runs lean — `--tools "" --disable-slash-commands --strict-mcp-config --setting-sources ""` plus `--system-prompt <ours>` (gated by `dashboard.llm_cli_lean_mode`, default true) — because the default harness context costs ~25k input tokens per call (measured 17.4x). Default model on both backends is Haiku 4.5.
---

# D-103: CLI calls run with the Claude Code harness stripped, and Haiku is the default model

*Decided: 2026-08-17*

**Context**: `claude -p` is an agent harness, not a bare completion endpoint. Invoked with defaults it prepends its own Claude Code system prompt, the full built-in tool catalog, discovered CLAUDE.md files, MCP server definitions and user/project settings files to **every** call, before a single character of our prompt.

Measured on the owner's machine, identical trivial task (`reply with exactly: OK`, `claude-haiku-4-5`), same binary, back to back:

| invocation | input-side tokens | `total_cost_usd` |
|---|---:|---:|
| default flags (what the dashboard did) | 25,664 (9 input + 7,521 cache-write + 18,134 cache-read) | **$0.017628** |
| `--tools "" --disable-slash-commands --strict-mcp-config --setting-sources "" --system-prompt …` | 167 | **$0.001011** |

**17.4x on a task whose actual content is a dozen tokens.** Our real assessment prompts are ~2–4k tokens, so under the previous behaviour roughly 85% of every assessment call's input was harness overhead — paid on every one of up to 30 scheduler calls per 15-minute tick.

Confirmed end-to-end on a real condition-assessment prompt, run through `claudeCliSingleShot` itself rather than a hand-built command line — old config vs new:

| config | tokens | cost | verdict |
|---|---:|---:|---|
| `claude-sonnet-4-6`, full harness (before) | 25,173 | **$0.05343** | `a_reformar` (0.97) |
| `claude-haiku-4-5`, lean (after) | 759 | **$0.00319** | `a_reformar` (0.95) |

Same verdict, 16.7x cheaper; ~$0.32 → ~$0.019 per fully-assessed property across the six flows.

None of that context is useful to us. The dashboard supplies its own system prompt, and the CLI agentic protocol has the **server** execute our tools — the model only emits a JSON envelope naming them (`cli/claude-code.ts`), so Claude's built-in tools are never called.

Separately, the default model on both backends was Sonnet-tier (`claude-sonnet-4-6` for CLI, `anthropic/claude-sonnet-4` for OpenRouter) for a workload that is entirely short structured extraction and classification over one property's listing text.

**Decision**:

- Every dashboard CLI invocation (single-shot and agentic) prepends `CLI_LEAN_ARGS` — `--tools ""`, `--disable-slash-commands`, `--strict-mcp-config`, `--setting-sources ""` — and passes the caller's own instruction via `--system-prompt`, replacing the harness prompt rather than adding to it.
- Gated by `dashboard.llm_cli_lean_mode` (default **true**) so a flow that turns out to depend on the harness can be unblocked from config without a redeploy.
- Default model is Haiku 4.5 on both backends: `dashboard.llm_model_cli = claude-haiku-4-5`, `DEFAULT_MODEL = anthropic/claude-haiku-4.5`. Per-flow OpenRouter overrides (`dashboard.llm_model_openrouter_<flow>`) remain the way to buy more capability where a flow needs it.

**Alternatives rejected**:

- **`--bare`**, the CLI's own minimal mode, which strips more. It forces `ANTHROPIC_API_KEY` auth and never reads the OAuth credentials file the launchd sync maintains ([D-025](archive/D-025-oauth-single-refresher.md)) — it would break authentication outright. Explicitly asserted against in `llm-provider-cli-usage.test.ts` so nobody "improves" it in later.
- *Set the flags via `dashboard.llm_cli_extra_args`.* That key is an operator escape hatch; making correct-by-default behaviour depend on an operator having typed the right string is how it stays broken.
- *Only trim assessment calls, leave chat on the full harness.* Chat's tools are ours too — the harness is dead weight on both paths.

**Rationale**: This is the single largest per-call reduction available, it required no change to any prompt, and it is measurable per call now that [D-102](D-102-llm-usage-metered-and-capped.md) records what each one costs. Note the default-model change only affects installs that have not pinned a model: an existing `~/.config/inmo-tool/config.yaml` with `dashboard.llm_model_cli` set overrides the schema default and must be edited (or cleared) for the change to take effect.

**See**: `dashboard/lib/llm-provider/cli/usage.ts` (`CLI_LEAN_ARGS`, with the measurement), `dashboard/lib/llm-provider/cli/claude-code.ts` (`leanArgs`), `config/schema.yaml` (`dashboard.llm_cli_lean_mode`, `dashboard.llm_model_cli`), [docs/roadmap/llm-cost-optimization.md](../roadmap/llm-cost-optimization.md).
