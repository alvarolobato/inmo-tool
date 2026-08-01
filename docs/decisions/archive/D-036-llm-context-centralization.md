---
id: D-036
title: Centralize all dashboard LLM calls through llm-context/assembleRequest
date: 2026-05-22
---

# D-036: Centralize all dashboard LLM calls through llm-context/assembleRequest

*Decided: 2026-05-22*

**Context**: Before this decision, every LLM call in the dashboard assembled its own system prompt, loaded its own history, resolved its own provider config, and called `llmComplete` or `runAgenticChat` directly. This led to:
- Prompt building scattered across `llm.ts`, `prompts.ts`, `review-prompts.ts`, `conversation-context.ts`, and individual API routes
- Provider config loaded in multiple places (race for model name, agentic flag, circuit breaker)
- No single place to add cross-cutting concerns (telemetry, circuit breaking, cache headers, daily budget checks, streaming callbacks)
- Tests had to mock deeply-nested provider internals and frequently broke on Vitest alias-path mock resolution

By issue #720 Phase 1 (May 2026) there were 8+ call sites, each with its own inconsistent wiring. The `llm-context/` module was created to consolidate them.

**Decision**: All LLM calls in the dashboard must go through `assembleRequest(flow, vars, conversationId, userMessage, opts)` in `dashboard/lib/llm-context/assemble.ts`. This is the **only** file in the project allowed to import `llmComplete` or `runAgenticChat`. A CI lint script (`dashboard/scripts/check-llm-context.sh`) greps all `.ts` files outside `llm-context/` for direct imports of either function and fails the build if any are found.

The module boundary is:
- **Inside `llm-context/`**: `assemble.ts`, `system-prompt.ts`, `history.ts`, `tools.ts`, `types.ts`, `formatters.ts`
- **Public API**: `assembleRequest`, `FlowVars`, `AssembleResult`, `AssembleExecutionOpts`, plus re-exported prompt builders and history helpers
- **Callers** (`llm.ts`, API routes, `turn-background.ts`): import from `@/lib/llm-context`, never from `@/lib/llm-client` or `@/lib/llm-tools/runner` directly

**Alternatives rejected**:
- *Keep the scattered pattern*: each new flow would require copy-pasting provider config resolution, agentic detection, circuit breaker setup, and cache header handling. Already causing bugs (wrong model used in some flows, missing circuit breaker on some paths).
- *Single `llm.ts` god-file*: `llm.ts` was already 400+ lines and growing. Consolidating into a directory with well-defined sub-files is more maintainable.
- *Enforce by convention only*: Without a CI check, violations accumulate in subsequent PRs. The grep-based `check-llm-context.sh` is trivial to run and adds ~1 second to the test job.

**Rationale**: A single entry point makes it trivial to add cross-cutting behaviour (new telemetry field, streaming hook, token budget enforcement) without touching every call site. It also gives tests a clean mock surface: `vi.mock("@/lib/llm-context", () => ({ assembleRequest: mockFn }))` intercepts all LLM calls regardless of how deep the call stack is.

**See**:
- `dashboard/lib/llm-context/` — the module
- `dashboard/scripts/check-llm-context.sh` — CI enforcement script
- [docs/skills/llm-context.md](../skills/llm-context.md) — full skill reference
- Issue #720 — migration of all call sites to `assembleRequest`
