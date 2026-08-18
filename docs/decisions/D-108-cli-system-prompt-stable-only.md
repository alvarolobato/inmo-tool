---
id: D-108
title: CLI single-shot path carries only `stable` on --system-prompt, never `volatile`
date: 2026-08-18
group: AI layer
rule: The CLI single-shot path (`claudeCliSingleShot`) MUST receive only `req.systemPrompt.stable` as its `systemPrompt` param, appended with the protocol shim as a SUFFIX — never `volatile` or any per-call text, which stays in stdin.
---

# D-108: CLI single-shot path carries only `stable` on --system-prompt, never `volatile`

*Decided: 2026-08-18*

**Context**: Phase 0c of `docs/roadmap/llm-batching-plan.md` measured that the
Anthropic prompt cache the `claude` CLI exposes only reuses a prefix carried
on `--system-prompt` — a prompt concatenated into stdin (the shape
`llm-client.ts`'s CLI branch used before this decision) gets its cache
breakpoint at the END of the whole body, so a per-call tail (the property
being assessed) busts it on every single call: measured $0.0200/call, 0 cache
reads, vs. $0.0058/call with the same block on `--system-prompt` (~71% off).
Issue #543 (F-13) moved the CLI single-shot path to the latter shape:
`llm-client.ts`'s `buildCliMessages` now builds stdin from `volatile` +
conversation turns only, and passes `req.systemPrompt.stable` to
`claudeCliSingleShot`'s new `systemPrompt` param, which
`claudeCliSingleShotOnce` prefixes onto `--system-prompt` (protocol shim
suffixed after it, so the flag's value keeps the meaningful, cacheable block
as its literal byte-stable prefix).

**Decision**: The `systemPrompt` value handed to `claudeCliSingleShot` (and
therefore to `--system-prompt`) must be `req.systemPrompt.stable` — and
*only* that — for every CLI single-shot call. `volatile` (the per-property
payload: listing text, price signal, trending/dismissed candidate lists at
call time) must never be concatenated into it, prefixed, suffixed, or
otherwise merged in. It stays in stdin, where a differing value across calls
is expected and harmless. `lib/__tests__/llm-client.test.ts`'s "CLI
system-prompt split (F-13)" tests pin this: two calls on the same flow with
different `volatile`/property content must produce a byte-identical
`systemPrompt` argument containing no per-property marker.

When `dashboard.llm_cli_lean_mode` is off, `--system-prompt` is omitted
entirely (the escape hatch that restores the full CLI harness prompt) — in
that case `claudeCliSingleShotOnce` folds `stable` back into stdin (the
pre-F-13 shape) rather than silently dropping it. That fallback is the ONE
place `stable` is allowed into stdin, and only because the flag carrying it
isn't being sent at all.

**Alternatives rejected**:
- *Concatenate stable+volatile and let the CLI's cache do its best.*
  Rejected — this is exactly the shape Phase 0c measured as getting zero
  reuse; keeping it would make F-13 a no-op.
- *A config toggle to choose which shape to use.* Rejected per AGENTS.md's
  "backwards compatibility — default is to break it": there is no reason to
  keep the old, strictly-worse shape reachable, and a toggle here is exactly
  the kind of thing a future agent could flip "to debug" and silently
  re-degrade every flow's cache eligibility with no test failure (the
  byte-stability tests only run against whichever branch is exercised).

**Rationale**: The whole value of F-13 depends on the `--system-prompt` value
being byte-identical across calls for a given flow. A single per-call string
leaking into it (a new flow accidentally building `stable` from `vars`
instead of pure flow-constant text, or a future refactor re-merging the two
params before the CLI call) silently reverts to the pre-F-13 zero-reuse
result — and does so unmeasured, since nothing else about the code's
behaviour changes (same output text, same JSON envelope shape, just a worse
cache line). Recording this as a binding rule, rather than leaving it as a
convention visible only in comments, is what future review can check against
without re-deriving the Phase 0c measurement.

**See**: `dashboard/lib/llm-client.ts` (`buildCliMessages`),
`dashboard/lib/llm-provider/cli/claude-code.ts`
(`claudeCliSingleShotOnce`, `SINGLE_SHOT_PRINT_ARG`),
`dashboard/lib/__tests__/llm-client.test.ts`,
`dashboard/lib/__tests__/llm-provider-claude-code-cli.test.ts`,
`docs/roadmap/llm-batching-plan.md` Phase 0c ("F-13 landed" subsection, with
the real-production-prompt re-measurement showing zero saving today because
every flow's stable block is below Haiku 4.5's 4,096-token cache floor),
issue #543. Related: D-102 (real usage metering), D-103 (lean CLI
invocation), D-106 (unconditional safety args) — same area of the CLI
provider.
