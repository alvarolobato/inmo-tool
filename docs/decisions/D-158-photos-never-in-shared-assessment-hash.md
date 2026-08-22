---
id: D-158
title: Photos never enter the shared assessment content hash; a photo-reading flow gets its own extraHashInput
date: 2026-08-22
group: AI layer
rule: 'Never add `photo_urls`/photo count to `computeAssessmentContentHash`''s shared material — it re-bills all six flows. A flow that starts reading photos gets its own `extraHashInput`.'
---

# D-158: Photos never enter the shared assessment content hash; a photo-reading flow gets its own extraHashInput

*Decided: 2026-08-22*

**Context**: #677/#683 built the mechanism to requeue ~2,800 Idealista
listings for browser re-capture, so #654/#678's parser fix can replace the 3
photos Idealista's truncated gallery preview stored with the full 18. A
re-capture re-upserts the listing row in place
(`etl/orchestrator.py:292-306`): `photo_urls` is overwritten unconditionally,
`last_seen_at`/`last_fetched_at` move to `now()`, `raw_extra` is rewritten,
and — for the overwhelming majority — `description` is byte-identical
(`description = COALESCE(%s, description)`, so even a parse that returns
nothing leaves the old text).

Before pulling that trigger the owner asked for a verified answer to: does
re-capturing a listing whose text has not changed re-run any LLM flow? The
audit found **no**, on three independent layers — `loadPropertyListings`
(`dashboard/lib/ai-assessment/shared.ts:109-116`) does not even SELECT
`photo_urls`; `computeAssessmentContentHash`
(`dashboard/lib/ai-assessment/cache.ts:176-185`) covers listing id + trimmed
description only; and `pendingClause`
(`dashboard/lib/ai-assessment/eligibility.ts`) selects on "no `ai_assessment`
row at the current prompt version", never on a timestamp. Nothing in
`etl/capture.py`, `etl/orchestrator.py`, the extension ingest route, or any
`init.sql` trigger writes to `ai_assessment`.

The audit's counter-question is what this decision records. Photos are
deliberately excluded from the hash, and going from 3 to 18 photos IS
genuinely new evidence — so the natural next thought is "add photos to the
hash". Today that would be pointless as well as expensive: **no assessment
flow reads photos at all.** `formatListing(..., { hashCoveredOnly: true })`
(`dashboard/lib/llm-context/system-prompt.ts:195`) suppresses even the
`num_fotos` count for every cached property-level flow, `ListingSnapshot`'s
`photoUrls` field is never populated on an LLM path, and
`lib/llm-context/assemble.ts` has no multimodal transport — message content is
string-only.

**Decision**: `computeAssessmentContentHash`'s shared `material` array stays
`(listing_id, trimmed description)`. Never add `photo_urls`, a photo count, or
a perceptual photo hash to it.

If a flow is ever given photos as real input (a vision-capable `condition`, a
photo-corroborated `redflags`), the invalidation signal for that evidence goes
into **that flow's own `extraHashInput`** — the same per-flow seam #184/D-012
already uses for the bucketed zone-median price signal — with the same binding
constraint D-012 imposes: the exact string rendered into the prompt must be the
exact string passed to `getOrCompute`. It must not go into the shared material.

**Alternatives rejected**:

- *Add photos to the shared hash.* One flow's new evidence would invalidate
  all six. Measured against production at the time of writing, the Idealista
  re-capture cohort is 2,675 distinct properties holding 2,470 occupancy,
  2,465 condition, 2,464 redflags, 2,444 location, 2,443 opportunity and 2,303
  extract verdicts at the current prompt versions — ~14,600 cached verdicts,
  every one of which a photo-sensitive shared hash would invalidate in a
  single overnight pass, for evidence five of the six flows cannot read.
- *Leave it undocumented because "no flow reads photos today".* That is
  precisely the state in which the cheap-looking wrong fix gets made. The rule
  exists for the moment a flow does start reading them.

**Rationale**: the hash is shared across six flows; the evidence is not. A
per-flow `extraHashInput` scopes an invalidation to the flow whose input
actually changed, which is the whole reason that parameter exists. The shared
material must stay the intersection of what every flow reads.

**See**: `dashboard/lib/ai-assessment/cache.ts` (module doc, and
`computeAssessmentContentHash`'s `extra` parameter),
`dashboard/lib/ai-assessment/__tests__/recapture-no-reassess.integration.test.ts`
(the regression test: a re-capture that changes `photo_urls` and every
timestamp but not the description costs zero model invocations, asserted at
the `llmComplete`/`runAgenticChat` seam), [D-012](D-012-derived-price-signal-in-cache.md),
issues #677/#683 (the requeue mechanism), #654/#678 (the parser fix), #30 (the
cache), #184 (`extraHashInput`).
