---
id: D-006
title: All LLM calls go through `assembleRequest()`
date: 2026-08-02
group: AI layer
rule: All LLM calls go through `assembleRequest()` in `dashboard/lib/llm-context/`. No file outside that directory may import `llmComplete` or `runAgenticChat`; CI enforces it via `check-llm-context.sh`.
order: 63
---

# D-006 — All LLM calls go through `assembleRequest()`

**Status:** accepted
**Date:** 2026-08-02
**Task:** #24 (Phase 4.1), part of #5

## Decision

Every LLM call in the dashboard is assembled and executed by a single function,
`assembleRequest(flow, vars, conversationId, userMessage, opts)`, in
`dashboard/lib/llm-context/`. No file outside that directory may import
`llmComplete` (from `lib/llm-client`) or `runAgenticChat` (from
`lib/llm-tools/runner`) directly.

`dashboard/scripts/check-llm-context.sh` enforces this in CI. It fails the build
on any such import, naming the offending file and line.

Callers state *what* they want (`assessOccupancy(listing)`); the module decides
*how* it happens — which prompt, which history, which tools, which execution
path, which model.

## Why

The alternative is what the archived source project started with: each route
calling `llmComplete` itself with its own inlined prompt. That produced, in one
codebase:

- Prompt drift, and worse, a prompt shown in the UI as "Contexto original" that
  no longer matched what was actually sent — the UI lying about the request.
- Per-call divergence in history capping, so some flows silently sent unbounded
  context and others sent none.
- Telemetry (`llmProvider`, `llmDriver`, usage logging, circuit breaker) applied
  inconsistently, because each call site had to remember to wire it.
- No single place to add prompt caching, so it was added to some paths only.

Centralising also makes the single-shot/agentic split a property of the flow
rather than a decision each caller re-makes: `toolsForFlow(flow)` returning `[]`
is what routes a flow down the cheap `llmComplete` path. Adding a flow is one
switch case in `buildSystemPrompt` plus one entry in `LLM_FLOWS` — it cannot
accidentally acquire a tool loop, unbounded history, or missing telemetry.

The rule is cheap to keep from day one of the AI layer and expensive to retrofit
once several flows already violate it, which is why it lands with the module
itself (#24) rather than after the flows are written (#25–#30).

## Scope

The guard covers the two symbols that actually execute a model call. It does not
forbid importing types, prompt builders, or `toolsForFlow` from `llm-context` —
those are the module's public API (see `llm-context/index.ts`).

One deliberate exception exists inside the boundary: `lib/llm-client.ts` imports
`isLlmFlow` from `./llm-context/types` (not the barrel) to narrow a flow string.
`types.ts` imports nothing, so this creates no cycle, and the check is unaffected
— it looks for importers *of* `llm-client`, not imports *by* it.

## Consequences

- A new flow that needs a genuinely different execution shape (streaming to a
  different sink, a non-chat completion API) has to extend `assembleRequest`
  rather than bypass it. That is the intended cost: it forces the new shape to
  be a reviewed, named thing rather than a quiet second path.
- Tests that want to stub the LLM mock `@/lib/llm-context`, one seam, instead of
  each call site.

## History

This re-records, for this repository, a constraint the archived source project
adopted after hitting the failure modes above. It is restated here rather than
inherited by reference because the flow catalog it governs is entirely different
(real-estate assessments, not BI dashboard generation) and because a decision
nobody can find in their own `docs/decisions/` is a decision that gets violated.
