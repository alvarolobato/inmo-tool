---
id: D-095
title: Location is an LLM assessment axis (beach proximity + heritage), never runtime regex
date: 2026-08-07
group: AI layer
rule: 'Beach/location detection (`beach_proximity` graded frontline/sea_view/near_beach/none + `heritage_zone` boolean) is the LLM `location` assessment axis, NEVER a runtime regex/keyword classifier — the owner does not trust keyword matching for it. Text-only (no coastline/geo dataset). `property_type=''terreno''` is excluded (the axis does not apply to a plot). Each sub-signal needs a literal `evidence` quote or degrades to `none`/`false` in `parseLocationResult`. Bump `LOCATION_PROMPT_VERSION` when the vocabulary/prompt changes so #308 re-assesses. Mining prevalence with SQL/ILIKE in dev is fine — that is not the product path.'
---

# D-095: Location is an LLM assessment axis, never runtime regex

*Decided: 2026-08-07*

**Context**: The owner's #1 taxonomy request (#385) is a "primera línea de playa
/ vistas al mar" signal — no portal exposes it as a filter, so it can only be
derived from the free-text description. Fable's mining showed it is real and
large ("playa" in 18% of texts with descriptions, "primera línea" 93, "vistas
al mar" 159 — two distinct grades, not one boolean), concentrated in Málaga. A
second location signal — casco/centro histórico — is both a prestige marker and
a reform-licence complication. The owner set a hard constraint on 2026-08-06:
**detection must be LLM-based, NOT regex/keyword** — he explicitly does not
trust keyword matching for this signal. The ILIKE mining was only to size
prevalence.

**Decision**: Add a new `assessment_type='location'` axis
(`dashboard/lib/ai-assessment/location.ts`) mirroring `condition.ts`'s shape,
carrying two sub-signals:

- **`beach_proximity`** — a GRADED enum, not a boolean:
  `frontline` (primera línea / a pie de playa / acceso directo) >
  `sea_view` (vistas al mar sin ser primera línea) >
  `near_beach` (cerca/andando, paseo marítimo) > `none`.
- **`heritage_zone`** — a boolean (casco/centro histórico), + evidence.

Binding rules:

1. **LLM-only, never runtime regex.** The product path that assigns a value is
   the merged `triage` assessment (`buildTriagePrompt`, D-109/#542 — merged
   the standalone `buildLocationPrompt`) — the model reads the text and
   classifies with a literal cited quote at `temperature: 0`. There is no
   ILIKE/regex classifier anywhere in the runtime path. Mining prevalence with
   SQL/ILIKE in dev is fine; it is not how a property gets a verdict.
2. **Text-only.** No coastline/geo dataset exists; a geo-corroboration layer
   (coastal-postal allowlist) is an optional future enhancement, not a blocker.
3. **`terreno` excluded.** A bare plot has no beach-view/heritage reading in the
   same product sense — `assessPropertyLocation` skips it (`locationApplies`)
   before any LLM call.
4. **Evidence-or-fallback.** Each sub-signal requires its own literal `evidence`
   quote or degrades to the safe default (`none`/`false`) in
   `parseLocationResult` — the same code-side backstop `condition`/`redflags`
   enforce, not something trusted to the prompt.
5. **Version bump re-assesses.** `LOCATION_PROMPT_VERSION` (`location/v1`) keys
   the `ai_assessment` unique row; a bump makes #308's batch re-assess.

This phase (#388) ships the axis + a candidate-card badge only ("Primera
línea" / "Vistas al mar" / "Cerca playa" / "Casco histórico"). The hard filter
(`frontline`) and ranking boost (`sea_view`/`near_beach`) are phase 4 (#385).

**Alternatives rejected**: A runtime ILIKE/keyword classifier over the
description — explicitly rejected by the owner; it manufactures false positives
("no es primera línea de playa") and cannot grade frontline vs. view vs. near.
A single `beach: boolean` — rejected because primera línea and vistas al mar are
different facts an investor weighs differently (phase 4 filters vs. boosts them
differently). A fifth "opportunity"-style merge — rejected; location is its own
axis with its own vocabulary (#385 keeps `opportunity` separate, phase 5).

**Rationale**: The whole taxonomy's discipline is a code-side evidence backstop
against false positives (D-087). A regex would break that discipline for the
signal the owner cares most about. The graded enum + per-signal evidence keeps
`location` consistent with `condition`/`redflags` and makes the phase-4 filter
(hard `frontline`, soft `sea_view`/`near_beach`) a pure filter-plumbing change
with no new detection risk.

**See**: `dashboard/lib/ai-assessment/location.ts` (`BEACH_PROXIMITIES`,
`BEACH_PROXIMITY_LABELS`, `HERITAGE_ZONE_LABEL`, `LOCATION_PROMPT_VERSION`,
`parseLocationResult`, `locationApplies`, `assessPropertyLocation`),
`dashboard/lib/llm-context/system-prompt.ts` (`buildTriagePrompt`, D-109/#542
merged the standalone `buildLocationPrompt`),
`dashboard/lib/ai-assessment/triage.ts` (`assessTriage`, D-109),
`dashboard/lib/ai-assessment/batch.ts` (`DEFAULT_BATCH_FLOWS`),
`dashboard/lib/candidates.ts` (`flagsFromAssessments`, `loadFlags`),
`etl/schema/init.sql` (`ai_assessment_assessment_type_check`),
`dashboard/lib/ai-assessment/__tests__/location.test.ts`,
`dashboard/e2e/location-axis.spec.ts`. Related: D-087 (generic problem axis /
evidence backstop), D-056 (prompt-version bump precedent). Issues #385, #388.
