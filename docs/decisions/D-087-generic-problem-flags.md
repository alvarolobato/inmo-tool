---
id: D-087
title: Redflags is the generic property-problem axis (legal + physical), not a fifth axis
date: 2026-08-06
group: AI layer
rule: 'The `redflags` assessment is the generic property-problem axis: legal/financial AND physical problems (`unfinished_construction`, `structural_damage`), not a new fifth axis. Each flag keeps a required literal `evidence` + human-readable `description`; unevidenced flags are dropped in `parseRedFlagsResult`. `other` stays the long-tail catch-all. Bump `REDFLAGS_PROMPT_VERSION` when the vocabulary/prompt changes so #308 re-assesses. Distress ranking counts "any red flag" once regardless of type/count — a physical problem counts, no double-count.'
order: 68
---

# D-087: Redflags is the generic property-problem axis (legal + physical)

*Decided: 2026-08-06*

**Context**: The AI layer had four axes: occupancy (ocupado/okupa), condition
(`a_reformar`/`reformado`/`obra_nueva`), the `extract` field-filler, and
`redflags` (originally legal/financial only — embargo, herencia yacente, deuda
de comunidad, construcción ilegal, litigio). Property 796 ("inmueble en
construcción… parcialmente ejecutada, con algunos tabiques ya levantados")
fell through *every* axis: a half-built shell is not occupied, not
`a_reformar` (that is a *finished* flat needing a refurb), not `obra_nueva` (a
*completed* new build), and not a legal risk. The owner asked for a generic
"problems" flag with a human-readable description covering physical problems
beyond occupancy — first and foremost unfinished/halted construction, but
extensible (issue #361).

**Decision**: Broaden the existing `redflags` axis into the generic
property-problem axis rather than adding a fifth axis. Its `RedFlag { type,
description, evidence, evidence_source }` shape already *is* "a generic flag
with a description", so:

- `REDFLAG_TYPES` gains physical-problem types — `unfinished_construction`
  (obra inacabada / parcialmente ejecutada / obra parada) and
  `structural_damage` — alongside the legal/financial ones; `other` remains
  the catch-all for the long tail.
- The prompt reads the advert description for physical problems too, with a
  clear definition of `unfinished_construction` that distinguishes it from
  `a_reformar` and `obra_nueva`. The evidence-required, no-manufactured-flags
  discipline is unchanged and still enforced in code
  (`parseRedFlagsResult` drops any flag with no literal `evidence`).
- `REDFLAGS_PROMPT_VERSION` is bumped (`v2` → `v3`) so #308's batch
  re-assesses existing properties against the broadened prompt.
- Flags render as warn-tone badges (label + the model's `description` as
  tooltip) on the candidate card (`flagsFromAssessments` in
  `lib/candidates.ts`) and as a dedicated `PropertyProblemFlags` section on
  the property detail page (label + description + literal evidence quote).
  `other` and any unmapped type are dropped, never shown as raw text.

**Alternatives rejected**: A separate fifth "problems" axis — rejected because
it would duplicate `redflags`' entire property-level plumbing (cache key,
merge-across-listings evidence union, area-price signal, the evidence guard)
for a shape that is byte-identical to `RedFlag`. One axis, two families of
problem (legal/financial and physical), is simpler and keeps the
anti-manufactured-flag guard in one place.

**Rationale**: The distress ranking already counts "any red flag" as a single
`+1` distress unit regardless of how many flags or of their type (the
`LEFT JOIN LATERAL` in `listCandidates` tests `jsonb_array_length(...) > 0`),
so a physical problem now contributing to distress is intended and cannot
double-count. The false-positive cost that made `redflags` lean hardest on
"only what's actually stated" applies equally to physical flags, so the
same code-side evidence backstop carries over unchanged.

**See**: `dashboard/lib/ai-assessment/redflags.ts` (`REDFLAG_TYPES`,
`REDFLAG_LABELS`, `REDFLAGS_PROMPT_VERSION`, `parseRedFlagsResult`),
`dashboard/lib/llm-context/system-prompt.ts` (`buildRedflagsPrompt`),
`dashboard/lib/candidates.ts` (`flagsFromAssessments`, `loadFlags`),
`dashboard/lib/property-detail.ts` (`ProblemFlag`, `getPropertyDetail`),
`dashboard/components/property/PropertyProblemFlags.tsx`,
`dashboard/e2e/problem-flags.spec.ts`. Related: D-012 (derived price signal),
D-052 (assessment auto-trigger / #308), D-056 (condition sub-axis version
bump precedent). Issue #361; property 796.
