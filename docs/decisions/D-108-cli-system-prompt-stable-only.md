---
id: D-108
title: CLI single-shot path carries only `stable` on the system-prompt channel, and `stable` must never interpolate per-call vars
date: 2026-08-18
group: AI layer
rule: A flow's `buildSystemPrompt().stable` must never interpolate per-call `vars` (only batch-scoped data, e.g. redflags' trending/dismissed, is allowed) — `claudeCliSingleShot` MUST receive only `req.systemPrompt.stable`, never `volatile`, as its domain system-prompt content, appended with the protocol shim as a SUFFIX.
---

# D-108: CLI single-shot path carries only `stable` on the system-prompt channel, and `stable` must never interpolate per-call vars

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
`claudeCliSingleShotOnce` prefixes onto the system-prompt channel (protocol
shim suffixed after it, so the channel's value keeps the meaningful,
cacheable block as its literal byte-stable prefix).

The #544 review of the first version of this change found that the two
mechanisms this decision now binds were BOTH violated, in ways a passing test
suite did not catch:

1. **The byte-stability tests didn't test byte-stability.** The original
   tests built one `stable` literal and asserted it equalled itself across
   two `llmComplete` calls — trivially true regardless of whether the real
   PRODUCER (`buildSystemPrompt`) ever varies `stable` per call. It does, for
   one flow: `buildChatPrompt` interpolated `vars.profileName`/`profileId`
   directly into `stable` (a per-conversation value), first byte diff at
   position 586. Fixed by moving that sentence into `volatile`
   (`system-prompt.ts`'s `buildChatPrompt`) and adding a real producer-level
   test, `lib/llm-context/__tests__/system-prompt-stability.test.ts`, which
   calls `buildSystemPrompt(flow, varsA)` / `buildSystemPrompt(flow, varsB)`
   with genuinely different payloads for every one of the eight flows and
   asserts `stable` is identical and marker-free. `redflags` is the one flow
   with a narrower, explicitly-tested exemption (see Decision below); chat is
   NOT exempted — it was fixed instead, because the field that broke it
   (`profileName`) is not populated by any production caller today (both
   `runFreeChatTurn`/`runGenericTurn` in `turn-background.ts` call
   `assembleRequest("chat", {}, ...)`) but the type contract (`FlowVars`)
   allows it, so a future caller wiring it up would silently re-break the
   invariant if it were merely documented rather than fixed.
2. **The escape-hatch fallback (`dashboard.llm_cli_lean_mode = false`)
   produced a wrong, self-contradicting result**, not just a missing
   optimisation: it string-concatenated `stable` into stdin under a SECOND
   `## system` header (stdin's `volatile` half already carries one), and the
   protocol shim's own text ("your system prompt, above this instruction,
   carries...") became false in that mode, since `--system-prompt` isn't
   sent at all when lean mode is off. Fixed using `--append-system-prompt`
   (confirmed present on the installed CLI via `claude --help`: "Append a
   system prompt to the default system prompt") instead of folding into
   stdin — this layers the domain block ON TOP of the harness's own default
   system prompt (which is the whole point of the escape hatch: get the full
   harness context back) rather than replacing it, so stdin is now IDENTICAL
   in shape regardless of `cliLeanMode`, and the shim's text is true in both
   modes. See `claudeCliSingleShotOnce`'s `appendSystemPromptArgs`.

**Decision**:

- **The producer invariant** (this is the constraint most likely to be broken
  by accident, so it is the one stated first): a flow's
  `buildSystemPrompt(flow, vars).stable` must be a function of `flow` alone,
  never of any PER-CALL field of `vars` (a property id, a description, a
  price, a profile name, today's date, a request id). The one narrow,
  explicitly-tested exception is `redflags`, whose `stable` legitimately
  embeds `vars.trendingCandidates`/`vars.dismissedCandidates` — but those are
  computed ONCE per assessment batch tick (`lib/ai-assessment/batch.ts`) and
  held constant across every property scored in that run, so `stable` is
  BATCH-constant, not call-constant, and callers must never pass a
  per-property value through those two fields. Every other flow's `stable`
  must have zero `vars` interpolation, full stop — `buildChatPrompt`'s
  now-fixed `profileName` bug is the shape of mistake this rule exists to
  catch, and `lib/llm-context/__tests__/system-prompt-stability.test.ts`
  enforces it across all eight flows (plus a companion test proving the
  redflags exemption is real and bounded — batch-to-batch, `stable` DOES
  change).
- **The routing mechanism**: the domain content handed to
  `claudeCliSingleShot`'s `systemPrompt` param (and from there to the CLI's
  system-prompt channel) must be exactly `req.systemPrompt.stable` — never
  `volatile`, never a re-merge of the two. `volatile` (the per-property
  payload) stays in stdin, where a differing value across calls is expected
  and harmless. `lib/__tests__/llm-client.test.ts`'s "CLI system-prompt split
  (F-13)" tests cover this routing layer specifically (not producer
  byte-stability — see that file's block comment for the distinction, added
  in the same #544 review round).
- **The lean-mode-off fallback** must use `--append-system-prompt`, not
  string concatenation into stdin. `dashboard.llm_cli_lean_mode = false`
  must keep stdin's shape IDENTICAL to lean-mode-on (task body + optional
  `volatile` `## system` section, never a second one) in every case — the
  escape hatch changes which CLI flag carries the domain block (and whether
  the harness default system prompt is replaced or kept), never stdin's
  shape.

**Alternatives rejected**:
- *Concatenate stable+volatile and let the CLI's cache do its best.*
  Rejected — this is exactly the shape Phase 0c measured as getting zero
  reuse; keeping it would make F-13 a no-op.
- *A config toggle to choose which shape to use.* Rejected per AGENTS.md's
  "backwards compatibility — default is to break it": there is no reason to
  keep the old, strictly-worse shape reachable, and a toggle here is exactly
  the kind of thing a future agent could flip "to debug" and silently
  re-degrade every flow's cache eligibility with no test failure.
- *Exempt `chat` instead of fixing it.* Rejected — `profileName` is currently
  dead in production, so exempting chat would have cost nothing today but
  would silently reopen the bug the moment a future feature (a
  profile-scoped chat conversation) populates that field, exactly the kind
  of drift this decision exists to prevent. Fixing it was no harder than
  exempting it.

**Rationale**: The whole value of F-13 depends on the value handed to the CLI's
system-prompt channel being byte-identical across calls for a given flow. A
single per-call string leaking into it — a new flow building `stable` from
`vars` by mistake, or a future refactor re-merging `stable`/`volatile` before
the CLI call — silently reverts to the pre-F-13 zero-reuse result, and does so
UNMEASURED: nothing else about the code's behaviour changes (same output
text, same JSON envelope shape, just a worse, invisible cache line). A test
that merely re-asserts a literal equals itself does not catch this, as #544's
review demonstrated in practice — hence binding the producer-level invariant
here, not just the router-level one, and pointing at the test that actually
exercises the producer.

Whether F-13 currently changes measured cost is corpus- and flow-dependent,
NOT something this decision claims either way — see
`docs/roadmap/llm-batching-plan.md`'s "F-13 landed" subsection for the
current per-flow numbers (six of eight flows are below Haiku 4.5's
4,096-token cache floor today; `redflags` already crosses it at a plausible
dismissed-candidate corpus size and is confirmed reusing ~70% off in that
regime). That is an operational fact that will keep changing as prompts grow
(batching, the triage merge, corpus growth); this decision's rule does not.

**See**: `dashboard/lib/llm-client.ts` (`buildCliMessages`),
`dashboard/lib/llm-provider/cli/claude-code.ts`
(`claudeCliSingleShotOnce`, `SINGLE_SHOT_PRINT_ARG`, `leanArgs`),
`dashboard/lib/llm-context/system-prompt.ts` (`buildChatPrompt`,
`buildRedflagsPrompt`),
`dashboard/lib/llm-context/__tests__/system-prompt-stability.test.ts`,
`dashboard/lib/__tests__/llm-client.test.ts`,
`dashboard/lib/__tests__/llm-provider-claude-code-cli.test.ts`,
`docs/roadmap/llm-batching-plan.md` Phase 0c ("F-13 landed" subsection, with
the full per-flow re-measurement), issue #543, PR #544 (including its review
round that produced this decision's producer-invariant and
`--append-system-prompt` fixes). Related: D-102 (real usage metering), D-103
(lean CLI invocation), D-106 (unconditional safety args) — same area of the
CLI provider.
