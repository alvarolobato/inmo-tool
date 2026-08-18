---
id: D-105
title: One master kill switch turns off all LLM use
date: 2026-08-18
group: AI layer
rule: `dashboard.llm_enabled` (default true) is the ONE switch that stops every model call — enforced at both seams (`llmComplete` and `assembleRequest`'s agentic branch, the only two paths per D-006), schedulers refuse to start, and API routes answer 503 `LLM_DISABLED`. Per-subsystem switches stop only their own scheduled pass.
---

# D-105: One master kill switch turns off all LLM use

*Decided: 2026-08-18*

**Context**: Asked to "disable the AI part for now", the honest answer was that no such control existed. Three switches looked like they might be it, and none was:

- `dashboard.assessment_auto_enabled` — stops the assessment scheduler only.
- `notifications.digest_auto_enabled` / `notifications.seguimiento_auto_enabled` — stop their own passes, and neither calls the LLM at all.

Every one of them leaves the interactive paths spending: the chat/agentic flows, a hand-clicked `POST /api/properties/[id]/assessments/*`, the compare flow, and conversation-history summarisation (which fires on any long chat). "Turn the AI off" therefore meant flipping three keys, reading the code to confirm what they actually covered, and still being wrong.

That is a poor answer generally, and a bad one for an owner who has just been told their LLM layer was burning money invisibly ([D-102](D-102-llm-usage-metered-and-capped.md)).

**Decision**: `dashboard.llm_enabled` (bool, default **true**) is the master switch. With it false the process makes **zero** model calls:

- **Enforced at both seams**, in `lib/llm-enabled.ts`: `assertLlmEnabled()` is called at the top of `llmComplete` and at the top of `assembleRequest`'s agentic branch. D-006 already forbids importing `llmComplete`/`runAgenticChat` anywhere else and CI enforces it, so guarding those two covers the entire surface *by construction* — there is no third path to forget, and a new flow cannot bypass the switch without first breaking a CI gate.
- **Schedulers refuse to start**, logging one line at boot rather than waking every 15 minutes to discover they may not work.
- **API routes answer `503 LLM_DISABLED`** with a message naming the key, so "the AI stopped working" is self-diagnosing rather than a support ticket.
- **Fails open**: if the config loader is unavailable (build context, missing schema file) the switch reads as enabled. It exists for deliberate operator intent, not to disable the product on a degraded environment.
- Read fresh per call, so flipping it in `/admin/config` takes effect immediately for interactive paths; the schedulers still need the restart the schema advertises.

**Alternatives rejected**:

- *Set `dashboard.llm_provider` to a stub/mock.* Would silence spend, but by making every flow return fabricated content — the UI would show invented verdicts indistinguishable from real ones. A kill switch must fail loudly, not quietly lie.
- *Flip the three existing switches.* Doesn't cover the interactive paths, which is most of the ways a human actually triggers a call.
- *Enforce inside each provider adapter.* More places to add it, and every new provider would have to remember. The two seams are already the enforced choke point.
- *Set the daily budget to a token amount.* Indirect, provider-dependent, and under OAuth the cost figure is notional (see D-102) — a switch should be a switch.

**Rationale**: The cheapest possible answer to "stop spending right now", with the guarantee coming from an existing architectural invariant rather than from diligence.

**See**: `dashboard/lib/llm-enabled.ts`, `dashboard/lib/llm-client.ts`, `dashboard/lib/llm-context/assemble.ts`, `dashboard/lib/ai-assessment/scheduler.ts`, `dashboard/lib/ai-assessment/route-errors.ts`, `config/schema.yaml` (`dashboard.llm_enabled`), [D-006](D-006-llm-context-centralization.md).
