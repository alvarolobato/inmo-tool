---
id: D-056
title: Renovation severity is an additive sub-axis on the condition verdict, not a wider condition enum
date: 2026-08-05
group: AI layer
rule: 'Renovation depth is an ADDITIVE `renovation_severity` field (`leve`/`integral`/`unknown`/`null`) on the condition result, meaningful only for `a_reformar` (else `null`) — never a wider `condition` enum. `unknown` degrades, never guesses. Bump `CONDITION_PROMPT_VERSION` (v1→v2) to re-trigger #308''s scheduler. Badge refines only leve/integral; pre-severity rows unchanged.'
order: 67
---

# D-056: Renovation severity is an additive sub-axis on the condition verdict, not a wider condition enum

*Decided: 2026-08-05*

**Context**: The condition-assessment flow (`dashboard/lib/ai-assessment/condition.ts`,
#26, D-052-triggered) emits a deliberately flat 4-value verdict —
`reformado | a_reformar | obra_nueva | unclear`. Issue #45 (renovation cost & ARV
tiering for the flip half of the investor-architect thesis) needs to map condition
to graduated refurb cost bands, but "repintar y cambiar la cocina" and "reforma
estructural completa" both collapse into `a_reformar` today — so #45 could only
produce a binary "near-zero vs. one flat higher rate," not the graduated model its
own issue text describes. #313 was opened (from the #307 review) to add the missing
light-vs-heavy signal.

**Decision**: Add a **separate, additive** `renovation_severity` field to
`ConditionResult` — `"leve" | "integral" | "unknown" | null` — rather than splitting
or widening the `condition` enum:
- The field is meaningful **only** when `condition === "a_reformar"`; the parser
  (`parseRenovationSeverity`) forces it to `null` for every other verdict, bound to
  the **final** verdict (after the uncited-`a_reformar`→`unclear` backstop), never to
  the raw model output.
- `unknown` is a first-class value: an `a_reformar` whose text doesn't grade the
  depth degrades to `unknown`, it is never guessed. Same evidence discipline as the
  base verdict — the severity is read off the same cited cues, not a second pass.
- `condition` keeps its exact 4-value closed set, so every existing consumer
  (`lib/candidates.ts`'s badge vocabulary, #310's hard filters, mock fixtures, the
  `assessment_type='condition'` CHECK constraint) is unchanged.
- Badge surfacing: `flagsFromAssessments` refines only `leve`/`integral` into
  `A reformar (leve)` / `A reformar (integral)` (kind `condition:a_reformar:<sev>`);
  `unknown`/`null`/absent keeps the pre-#313 `A reformar` badge and its stable kind,
  so pre-severity rows render identically.
- `CONDITION_PROMPT_VERSION` bumped `condition/v1` → `condition/v2`. The bump **is**
  the re-assessment trigger: #308's batch scheduler selects properties lacking a row
  at the current prompt_version, so every pre-severity `a_reformar` verdict is
  recomputed rather than read back stale (D-052, `ai_assessment` UNIQUE key includes
  `prompt_version`).

**Alternatives rejected**:
- *Split the enum into `a_reformar_leve` / `a_reformar_integral`*: would break the
  closed 4-value `condition` set every downstream consumer reads, forcing changes to
  badge maps, hard filters, mock fixtures and the CHECK constraint for a distinction
  only #45 cares about. An additive field is the clean extension #313 asked for.
- *A second LLM pass to grade severity*: #313 explicitly scopes this as a
  prompt/parsing change over the same evidence, not a new call — a speculative second
  pass would violate the assessment layer's cite-or-don't-assert discipline.

**Rationale**: `reformado`/`obra_nueva` are already unambiguous cost endpoints and
`unclear` is the no-signal case; the only place a cost-band split adds information is
*within* `a_reformar`. Modelling it as an orthogonal field keeps the base taxonomy
stable, gives #45 a direct `leve`/`integral` handle for cost bands (treating
`unknown`/`null` as "no graded estimate"), and preserves full backward compatibility.

**See**: `dashboard/lib/ai-assessment/condition.ts` (`RENOVATION_SEVERITIES`,
`parseRenovationSeverity`, `CONDITION_PROMPT_VERSION`),
`dashboard/lib/llm-context/system-prompt.ts` (`buildConditionPrompt`),
`dashboard/lib/candidates.ts` (`flagsFromAssessments`), issues #313 / #45 / #307,
D-052, D-006.
