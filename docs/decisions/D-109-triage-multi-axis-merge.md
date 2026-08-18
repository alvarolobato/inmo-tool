---
id: D-109
title: condition + location + opportunity merged into one "triage" LLM call
date: 2026-08-18
group: AI layer
rule: '`condition`+`location`+`opportunity` are assessed in ONE LLM call ("triage") that writes three per-axis `ai_assessment` rows via the unchanged per-axis parsers/savers; occupancy, redflags and extract stay separate. Every reader keys on `assessment_type` and is unchanged. The triage prompt/response is N-property-capable (array in, id-echoing array out) from day one; `getOrComputeMulti` takes every axis lock on ONE client, sorted, never nested per-axis locks.'
---

# D-109: condition + location + opportunity merged into one "triage" LLM call

*Decided: 2026-08-18*

**Context**: `docs/roadmap/llm-batching-plan.md` (Phase 2, PR 2a) found that
`condition` (#26), `location` (#388) and `opportunity` (#398) were three
independent property-level LLM flows — three prompts, three
`assessProperty*` entry points, three `getOrCompute` cache checks — asking
three cheap, closed-vocabulary questions over the IDENTICAL payload (every
live listing of one deduplicated property). Merging them replaces 3 calls
with 1, saving ~2,500 input tokens/property (~23% of the six-flow total) and
removes a pre-existing orphaning risk: `batch.ts`'s flow-major loop ran
`condition` before `location`/`opportunity`, so a mid-pass budget/circuit/quota
stop could leave those two permanently unwritten for every property already
selected that tick — merging them into the SAME call as `condition` (a
selection flow) closes that gap by construction.

**Decision**:

- One new flow, `triage`, whose prompt (`buildTriagePrompt`,
  `dashboard/lib/llm-context/system-prompt.ts`) merges ONE `DOMAIN_PREAMBLE`,
  ONE `ASSESSMENT_RULES`, and each axis's OWN vocabulary/evidence rules
  (deduplicating only the shared "varios anuncios" instruction) and returns a
  JSON ARRAY keyed by an ECHOED `property_id` — N-property-capable from day
  one (Phase 3 of the batching plan is what actually calls it with N>1; this
  PR always calls it with N=1).
- The three existing per-axis parsers (`parseConditionResult`/
  `parseLocationResult`/`parseOpportunityResult`) are UNCHANGED — hoisted
  into an object-taking core (`parseConditionObject`/`parseLocationObject`/
  `parseOpportunityObject`) that `triage.ts` calls directly on each axis's
  already-parsed sub-object, so the JSON.parse/fence-strip step moves up to
  the whole array response instead of being repeated three times. Three
  `ai_assessment` rows are still written — same `assessment_type` values,
  same result shapes, same `save*Assessment` functions — so `loadFlags`,
  `candidates.ts`'s badges, D-059's hard filters, and D-067's
  `extractFallbackExpr` all keep working with ZERO changes; a triage-written
  row is indistinguishable from a pre-merge row (pinned by a DB-backed test,
  `triage.integration.test.ts`).
- `dashboard/lib/ai-assessment/triage.ts`'s `assessPropertyTriage` is the new
  core; `assessPropertyCondition`/`Location`/`Opportunity` (unchanged public
  signatures) become thin wrappers extracting their own axis's slice. Every
  entry point — including the three per-axis POST routes, unmodified — always
  requests every APPLICABLE axis (all three, or just `condition` for a
  `terreno` per D-095/#398), never a caller-specific subset: a POST to
  `/assessments/condition` also refreshes `location`/`opportunity` when they
  are stale, "strictly better for the operator" and the reason there is
  exactly one axis-selection policy, not one per caller.
- `getOrComputeMulti` (`dashboard/lib/ai-assessment/cache.ts`) is the
  multi-axis counterpart of the existing `getOrCompute`: ONE content hash for
  the whole property (every axis reads the identical payload), a per-axis
  cache-hit/park check, and — the load-bearing constraint — every axis's
  advisory lock taken on ONE dedicated client, in SORTED key order
  (`withAdvisoryLockMulti`), never nested per-axis `withAdvisoryLock` calls on
  separate clients. The write pool is capped at `max: 5`
  (`dashboard/lib/db-write.ts`); three nested per-axis clients per triage call
  would race the app's own queries for that pool and could deadlock two
  concurrent multi-key callers taking their locks in different orders. A
  fixed (sorted) acquisition order makes that deadlock impossible.
- A NEW code-side guard specific to the merge: the evidence-substring check
  (`triage.ts`'s `sanitizeEvidenceFields`). Merging three axes into one
  completion introduces a failure mode a single-axis call never had —
  cross-axis evidence bleed, where the model cites a plausible quote for one
  axis that was actually said about (or invented for) another. Before each
  axis's own parser runs, any evidence field whose value is NOT a literal
  substring of that property's own listing text is blanked, so it degrades
  through the SAME evidence-or-fallback backstop D-056/D-095 already specify
  (`unclear`/confidence 0 for condition; `none`/`false` per signal for
  location/opportunity) — never a new failure mode, just a stricter check
  feeding the existing one. A malformed or missing axis slice is isolated to
  that axis alone (`getOrComputeMulti`'s per-axis `"error"` outcome) — a bad
  `location` slice never poisons a good `condition` verdict from the same
  response.
- Version bumps: `condition/v2` → `condition/v3`, `location/v1` → `v2`,
  `opportunity/v1` → `v2` — each documents "now answered by the merged
  `triage` prompt" and reopens that axis's backlog exactly once (the bump IS
  the re-assessment trigger, same convention as every prior bump).
- **F-9** rides here: `location`/`opportunity` join
  `ASSESSMENT_SELECTION_FLOWS` (`eligibility.ts`), closing the orphaning gap
  above. This required a companion fix: a `terreno` NEVER gets a
  `location`/`opportunity` row (D-095/#398, unchanged), so
  `missingCurrentVerdictClause` gained a guard (`f.atype NOT IN
  ('location','opportunity') OR property_type IS DISTINCT FROM 'terreno'`) —
  without it every terreno would count as permanently "pending" for those two
  flows and, since selection orders `created_at ASC`, the oldest ones would
  starve the rest of the backlog forever.
- `DEFAULT_BATCH_FLOWS` becomes `occupancy` / `triage` / `redflags` /
  `extract` (4 entries, was 6). `BatchFlow.type`/`promptVersion` (singular)
  became `types: {type, promptVersion}[]` — `isFlowCurrent` skips a flow's
  `assess` call only when EVERY listed pair is current; the batch loop's
  summary counters (`assessed`/`parked`/`errors`) still key on whether
  `flow.assess` throws, so `assessPropertyTriageForBatch` re-derives one
  exception from triage's per-axis outcomes (an `"error"` on any axis wins
  over a `"parked"` one, which wins over a clean return) — a deliberate,
  coarse-grained trade-off: a tick where `condition` succeeded while
  `location` is parked is counted as `parked`, not `assessed`, so a real park
  or error is never silently hidden behind one axis's success.

**Alternatives rejected**:
- *One combined `ai_assessment` row of type `triage`* — would break every
  keyed reader (`loadFlags`, D-059's per-axis filter columns, the coverage
  panel) and the whole point of "every existing reader is unaffected".
- *Merge all five judgment axes (incl. occupancy/redflags) into one call* —
  occupancy carries the subtlest verdict discipline (silence-default,
  confidence caps) and the D-012 hashed price signal; redflags carries the
  open-vocabulary trending/dismissed mechanics and the same price signal.
  Both are the highest quality risk for the smallest marginal saving — see
  the batching plan's D-A table. Left for a later, separate decision if ever.
- *A single shared `TRIAGE_PROMPT_VERSION` replacing the three per-axis
  versions* — would break `missingCurrentVerdictClause`'s per-axis accounting
  and each axis's stale-badge semantics; per-axis versions bumped in lockstep
  give the identical re-assessment trigger without touching any reader.
- *Per-caller axis subsets* (e.g. `POST /condition` requesting only
  `condition`) — rejected: it would mean three different "which axes to ask
  about" policies instead of one, and forgo the free location/opportunity
  refresh the merge otherwise gives an operator hitting any one of the three
  routes.

**Rationale**: The merge is a pure call-shape change with no change to what
counts as a citable finding on any axis — the compatibility guarantee (every
existing reader unaffected) is what makes it safe to ship without touching
the dashboard UI, the candidate feed, or any filter. The lock-ordering and
evidence-substring additions are the two genuinely NEW pieces of machinery
the merge requires, and both generalize cleanly to Phase 3's real
multi-property batching without a second design pass.

**See**: `docs/roadmap/llm-batching-plan.md` §2 D-A, §1.3 "Advisory-lock
mechanics"; `dashboard/lib/ai-assessment/triage.ts`;
`dashboard/lib/ai-assessment/cache.ts` (`getOrComputeMulti`,
`withAdvisoryLockMulti`); `dashboard/lib/ai-assessment/eligibility.ts`
(`ASSESSMENT_SELECTION_FLOWS`, `missingCurrentVerdictClause`);
`dashboard/lib/ai-assessment/batch.ts` (`BatchFlow.types`,
`assessPropertyTriageForBatch`); `dashboard/lib/llm-context/system-prompt.ts`
(`buildTriagePrompt`, `triageVolatile`); D-056 (renovation severity), D-095
(location axis, LLM-not-regex), D-104 (failure ledger), D-105 (kill switch).
Issue #542.
