---
id: D-067
title: Wire #28 extracted structured fields into the hard-filter engine as a confidence-gated COALESCE fallback
date: 2026-08-05
group: Product
rule: The hard-filter engine (`scope-query.ts`) reads `ai_assessment` extract rows (#28) as a query-time `COALESCE(property.<col>, <latest extract value>)` fallback via `extractFallbackExpr`, gated at confidence ≥ 0.6 per field (below = UNKNOWN). `property.<col>` ALWAYS wins (COALESCE order). `requires_elevator` becomes `IS NOT FALSE` (keep unknown/below-threshold, exclude only confidently-known-missing). Stays a pure DB-connectionless string builder; `profile-diagnostics.ts` reuses the same helper.
order: 77
---

# D-067: Extract-row fallback in the hard-filter engine

*Decided: 2026-08-05*

**Context**: Task 4.5 (#28) ships `assessment_type='extract'` rows in
`ai_assessment` — per-property `m2_built`/`m2_useful`/`rooms`/`bathrooms`/
`floor`/`has_elevator` recovered by the LLM from free-text descriptions when a
portal never structured them. Task 2.4 (#18)'s hard-filter engine
(`lib/filtering/scope-query.ts`) filtered directly against the structured
`property.<col>` columns with no fallback, so exactly the private-seller
listings #28 exists to rescue were still excluded for lack of a field the
portal didn't publish — and the flow spent LLM budget writing rows nothing
read. Issue #182 (filed per #28's own "Additional Context", since #18 had
already merged) is the fast-follow to consume them.

**Decision**:
- `scope-query.ts` gains `extractFallbackExpr(column)`, returning
  `COALESCE(property.<col>, (SELECT (result->>'<col>')::<cast> FROM
  ai_assessment WHERE property_id = property.id AND assessment_type = 'extract'
  AND (result->'confidence_per_field'->>'<col>')::numeric >= 0.6 ORDER BY
  generated_at DESC NULLS LAST, id DESC LIMIT 1))`. The "latest row per type"
  shape mirrors `getLatestAssessment` (cache.ts) / `loadFlags` (candidates.ts),
  inlined as a correlated scalar subquery so `scope-query.ts` stays a PURE,
  DB-connectionless SQL string builder (its documented contract). The helper
  binds no params (column from a closed union, threshold a literal), so the
  funnel stages' positional-`$n` ordering is untouched.
- The helper is used everywhere `buildScopeWhereClause` previously read a bare
  `property.<col>`: the size band (`m2_built`), `requires_elevator`
  (`has_elevator`), and `excludes_ground_floor` (`floor`). `rooms`/`bathrooms`
  are supported for a future filter; `m2_useful` is filtered by nothing.
  `profile-diagnostics.ts`'s zero-candidate isolation reuses the same helper so
  "which stage zeroed the count" stays faithful to the real filter.
- **Confidence threshold 0.6**: an extracted value is trusted for a HARD filter
  only when that field's `confidence_per_field` entry is ≥ 0.6; below that the
  field is treated as UNKNOWN (subquery returns no row → COALESCE falls through
  to `property.<col>`, i.e. NULL when unstructured).
- **`property.<col>` always wins** (COALESCE order): a later connector sync
  that fills the structured column silently retires the fallback; a stale
  extraction never shadows a real value (#182 EC-3).
- **`requires_elevator` moves from `has_elevator IS TRUE` to `<fallback> IS NOT
  FALSE`**: keep unknown / below-threshold elevators, exclude only a
  confidently-known missing one (`property.has_elevator = false`, or a ≥ 0.6
  extraction of false).

**Alternatives rejected**:
- *Trust any-confidence extractions* (issue's "don't default to any confidence
  counts"): a false negative from a shaky guess quietly excluding a real match
  is a worse failure mode for a hard filter than simply lacking the datum.
- *Merge extracted values into `property`/`listing` columns*: #28 deliberately
  keeps AI-inferred values in `ai_assessment.result`, never in the
  connector-parsed columns, so provenance stays legible if the two disagree.
  Reading at query time as a COALESCE preserves that separation.
- *Keep `requires_elevator` as `IS TRUE`*: post-gate, an unknown elevator and a
  below-threshold `false` both resolve to NULL, indistinguishable from a
  confident "no elevator" under `IS TRUE` — which would reject them, failing
  #182 EC-2. `IS NOT FALSE` is also the "exclude only what's known-bad" rule
  `excludes_ground_floor` already follows, so this aligns the two exclusions.
- *A new index on `ai_assessment(property_id, assessment_type, generated_at)`*:
  the existing `ai_assessment_property_key` UNIQUE `(property_id,
  assessment_type, prompt_version)` index already serves the correlated
  equality lookup on its `(property_id, assessment_type)` prefix, and at most
  one extract row exists per property per prompt version (ON CONFLICT updates
  in place), so the per-row sort is trivial — a dedicated index would be dead
  weight (init.sql explicitly dropped a comparable redundant prefix index).

**Rationale**: Closes the loop so #28's LLM spend reaches the filter it exists
to serve, without touching the extraction flow (#28) or the #30 cache — a
purely consumer-side change — and without breaking `scope-query.ts`'s pure
string-builder contract.

**See**: `dashboard/lib/filtering/scope-query.ts` (`extractFallbackExpr`),
`dashboard/lib/profile-diagnostics.ts`,
`dashboard/lib/filtering/__tests__/extract-fallback.integration.test.ts`,
`docs/architecture/data-model.md` § AI assessments, issue #182, #28, #18, #30.
