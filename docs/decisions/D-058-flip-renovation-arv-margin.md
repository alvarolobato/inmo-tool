---
id: D-058
title: Buy-to-flip renovation cost / ARV / flip margin
date: 2026-08-05
---

# D-058: Buy-to-flip renovation cost / ARV / flip margin

*Decided: 2026-08-05*

**Context**: Issue #45 (part of the #307 architect-investor strategy). The app's
buy-to-rent half (yield / cash-on-cash, #31/#32/#33/#151) shipped with honest
confidence tiering, but the buy-to-flip half — renovation cost, after-repair
value (ARV), flip margin — had zero code, despite being the more differentiating
capability for an architect whose edge is pricing and executing refurbishment.
#313 (D-056) had just landed the `renovation_severity` sub-axis (`leve` /
`integral` / `unknown` / `null`) on the condition assessment specifically to
unblock cost tiering here.

**Decision**:

- **`thesis_type` marker.** `thesis_params.thesis_type` (`"rent"` | `"flip"`,
  optional; unset = `"rent"`) is the documented convention task 2.3 left open.
  The flip section on the property detail page renders ONLY for
  `thesis_type === "flip"` (issue #45 EC-3) — `getInvestmentMetrics` returns
  `flip: null` for every other profile, so a rental profile never sees it.

- **Refurb cost = `m²_built × band`, keyed off condition + severity.**
  `reformado`/`obra_nueva` → 0; `a_reformar`+`leve` → light band;
  `a_reformar`+`integral` → heavy band; `a_reformar`+`unknown`/`null` →
  conservative MID band flagged provisional; `unclear`/no-assessment →
  `no_estimate` (never guessed). Bands are **configurable** in
  `config/schema.yaml` (`flip.refurb_cost_{leve,integral,unknown}_eur_m2`,
  defaults 400/900/650 €/m²), NOT hardcoded — real costs are regional and the
  owner tunes them without a code change.

- **ARV = zone median €/m² (area-price.ts / #32) × m²_built.** v1 reuses the
  general area median across ALL conditions, not a renovated-only comp set:
  condition assessments are empty until #308/#316 run at scale, so a
  renovated-only query would return near-zero rows. The `basis` says so; mixing
  un-renovated comps biases the ARV DOWN (margin understated, the safe
  direction). Confidence tiers `high`/`low` at a 15-comp threshold.

- **Flip margin = ARV − purchase price − refurb − transaction/holding buffer.**
  The buffer is a single configurable % of the purchase price
  (`flip.sale_holding_cost_pct`, default 10) covering acquisition tax + selling
  + holding — a deliberately coarse v1 rule of thumb, not a line-itemised model.
  Every component is surfaced separately (EC-2); `margin_pct` is margin / total
  cash out. Buy-to-rent yield is shown side by side so the persona picks the
  play (they are not summed — one-off gain vs. recurring yield).

- **Graceful degradation, never a garbage number.** Any missing input (no
  condition assessment, too few comps, no price/m²) yields a clean "sin
  estimación" with a `basis` naming what's missing — never NaN, a fabricated
  zero, or a partial margin. Pure calc functions
  (`renovation-estimate.ts` / `arv.ts` / `flip-margin.ts`) are DB/IO-free and
  unit-tested; config resolution lives in `flip-config.ts`, DB reads in
  `investment-metrics.ts`.

- **Framing.** UI copy labels every figure a rough, directional
  decision-support estimate — explicitly "NO es una tasación ni un presupuesto
  de obra" (EC-4, issue #1 §11).

**Alternatives rejected**:
- *Renovated-only comps for ARV in v1* — would return ~0 rows until condition
  assessments exist at scale; deferred to a later revision that swaps the input
  without changing the function shape.
- *Line-itemised transaction/holding costs* — over-engineered for v1; issue #45
  asks for "a configurable %". Reusing the province-aware `acquisition-costs.ts`
  buy-side model was considered but kept out to keep the pure function simple;
  the single buffer is the documented, tunable v1.
- *Splitting the `condition` enum instead of the additive `renovation_severity`*
  — already rejected by D-056.

**Rationale**: Ships the entire flip half of the persona's thesis with the same
honesty discipline as the rental half — configurable, tunable, and degrading
rather than fabricating when the evidence is thin.

**See**: issue #45, #307; `dashboard/lib/analytics/{renovation-estimate,arv,flip-margin,flip-config}.ts`,
`dashboard/lib/investment-metrics.ts`, `dashboard/components/property/sections/FlipSection.tsx`,
`config/schema.yaml` (`flip.*`); D-056 (renovation severity), D-011 (acquisition costs),
D-014 (comparable rent).
