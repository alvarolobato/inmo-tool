---
id: D-019
title: Pluggable Dashboard LLM providers (OpenRouter API vs CLI)
date: 2026-04-23
---

# D-019: Pluggable Dashboard LLM providers (OpenRouter API vs CLI)

*Decided: 2026-04-23*

**Context**: Issue #394 — the Dashboard App hard-coded OpenRouter; teams with a flat-rate Claude Code subscription wanted the same flows without forcing per-token API spend.
**Decision**:
- Introduce `DASHBOARD_LLM_PROVIDER=openrouter|cli` with **per-backend model** envs (`DASHBOARD_LLM_MODEL_OPENROUTER`, `DASHBOARD_LLM_MODEL_CLI`; legacy `DASHBOARD_LLM_MODEL` still applies as fallback for both).
- **OpenRouter path**: unchanged semantics — OpenAI SDK + `OPENROUTER_API_KEY`, native `chat.completions` function calling for agentic flows.
- **CLI path**: generic `spawn` runner (`dashboard/lib/llm-provider/cli/process.ts`) + **driver** `DASHBOARD_LLM_CLI_DRIVER=claude_code` using `claude -p` / `--model`. Agentic rounds use a **JSON-only step protocol** (`kind: final|tools`) so the same `llm-tools/runner.ts` loop drives tools; handlers stay unchanged.
- **Telemetry**: `llm_usage` and `llm_tool_calls` gain `llm_provider` + `llm_driver`; CLI rows log **zero** `estimated_cost_usd`. Daily budget (`LLM_DAILY_BUDGET_USD`) sums **OpenRouter-estimated** spend only (`llm_provider = 'openrouter'`).
- **Extensibility**: new CLI drivers implement the same `AgenticModelAdapter` + single-shot helpers without touching API route business logic.
**Alternatives rejected**: Shell-string CLI invocation (injection risk); dropping agentic support on CLI (would regress generate/modify/analyze).
**Rationale**: Read-only SQL policy remains in tool handlers; argv-array spawning + timeouts + stdout caps bound operational risk.
**See**: `dashboard/lib/llm-provider/*`, `dashboard/lib/llm.ts`, `dashboard/lib/llm-tools/runner.ts`, `.env.example`, [dashboard-agentic-tools.md](../dashboard-agentic-tools.md).
