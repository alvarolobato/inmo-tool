---
id: D-011
title: Acquisition-cost model — ITP by CCAA (general rate only), flat notary/registry/gestoría defaults, actual carrying costs ADD to (not replace) the assumed maintenance/vacancy line
date: 2026-08-03
---

# D-011: Acquisition-cost model — ITP by CCAA, flat notary/registry/gestoría, actual carrying costs are additive to a separate maintenance/vacancy assumption

*Decided: 2026-08-03, revised 2026-08 (Opus review on PR #181)*

> **Revision (2026-08, Opus review)**: point 4 below ("carrying costs
> REPLACE the assumed percentage") was the original decision and is now
> superseded by the additive model described in the revised point 4 and
> the new "Alternatives rejected" entry below. The review found that full
> replacement flips the sign of cash-on-cash on real numbers (a Málaga
> worked example: -0.84% cash-on-cash under the fully-assumed 25% model
> vs. +3.17% once a listing published only a 55 EUR/month community fee,
> dropping IBI/maintenance/vacancy entirely) — a systematic bias that
> always favours whichever portal happens to publish partial cost data.
> See `dashboard/lib/analytics/yield.ts`'s module docstring for the full
> analysis and `yield.test.ts`'s Málaga-worked-example test.

**Context**: Issue #151 requires acquisition costs (ITP, notary, registry,
fees) to be modelled, not left out of the yield calculation — "a yield
computed without them overstates returns by a wide margin." ITP is
region-specific (Spain's 17 comunidades autónomas + Ceuta/Melilla each set
their own rate) and further varies by price bracket and buyer circumstance
within most regions; new-build purchases use IVA+AJD instead of ITP
entirely.

**Decision**:
1. `dashboard/lib/analytics/acquisition-costs.ts` ships a **general/base ITP
   rate per comunidad autónoma** (`ITP_RATE_BY_CCAA`), resolved from
   `property.province` via a `PROVINCE_TO_CCAA` lookup (case/accent
   normalized). Rates cross-checked against two independent sources,
   verification date stamped in the module (`RATES_LAST_VERIFIED`).
   Progressive price brackets and buyer-profile reductions (age, large
   family, disability, VPO) are explicitly NOT modelled — this is a
   decision-support estimate, not a tax filing. An unrecognized/missing
   province falls back to a documented national rate
   (`NATIONAL_FALLBACK_ITP_PCT = 8`) and is flagged
   (`province_recognized: false`) so the UI can visibly distinguish "used
   your actual region's rate" from "guessed a national default."
2. **New-build (obra nueva) is out of scope entirely** — this schema has no
   reliable "is this a new build" signal, so the module always applies the
   resale/ITP path. A future connector-level new-build flag should route
   through a separate IVA+AJD calculation, not extend this table.
3. Notary/registry/gestoría default to a documented rule-of-thumb
   (`DEFAULT_NOTARY_PCT = 0.3`, `DEFAULT_REGISTRY_PCT = 0.2`,
   `DEFAULT_GESTORIA_EUR = 300` flat), all overridable per profile via
   `thesis_params.acquisition_costs`.
4. **REVISED (2026-08, Opus review): carrying costs (IBI, community fees)
   replace ONLY their own specific cost category, and a SEPARATE
   `DEFAULT_MAINTENANCE_VACANCY_PCT` (8%, of gross rent) is always added on
   top** — whether or not any actual data is known — because no source in
   this schema publishes maintenance/vacancy figures at all. Only when
   NEITHER IBI nor community fee is known does the module fall back to the
   single bundled `operating_cost_pct` (25% default, covering IBI +
   community + maintenance + vacancy together), to avoid stacking three
   independent assumptions where one bundled one already existed. Results
   report `ibi_known`/`community_fee_known` individually (not just a coarse
   `carrying_costs_source: "actual"|"assumed"`), since "only the community
   fee is real" and "both are real" are different facts a user should be
   able to tell apart.
   The **original decision** (full replacement of the entire assumed
   percentage the instant ANY actual figure was known) is superseded — see
   the revision note at the top of this file for why: it created a
   systematic, directional bias (a Solvia listing publishing only a partial
   carrying-cost figure always looked better than an otherwise-identical
   listing with no data at all), which is worse than the "invented
   sub-split" concern the original decision was trying to avoid, because a
   directional bias is exploitable in a way undirected estimation noise is
   not.

**Alternatives rejected**:
- Modelling full progressive ITP brackets + every buyer-profile reduction —
  rejected as real tax-software scope, explicitly out of bounds for a
  decision-support tool (issue #1 §11/§16).
- Blending actual carrying costs with a prorated share of the assumed
  percentage (e.g. "subtract IBI's typical share of the 25% bundle, keep
  the rest for maintenance/vacancy") — still rejected under the revised
  model: inventing what fraction of `operating_cost_pct` is "the
  maintenance/vacancy part" would be the same fabricated-precision problem
  issue #1 §11 warns against. `DEFAULT_MAINTENANCE_VACANCY_PCT` avoids this
  by being its OWN independently-sourced figure (a property-management
  rule of thumb for maintenance+vacancy alone), not a derived share of the
  25% bundle.
- **(Original decision, now rejected) Full replacement** — actual carrying
  costs zeroing out the ENTIRE assumed operating-cost line the instant any
  one figure was known. Rejected after an Opus review demonstrated this
  flips cash-on-cash's sign on real numbers (Málaga worked example:
  -0.84% fully-assumed vs. +3.17% once only a community fee was known) —
  a bias that always favours whichever portal publishes partial data,
  which is a worse fabrication than the sub-split idea above because it
  has a known, exploitable direction rather than being undirected noise.

**Rationale**: A reviewable, cited table beats inline literals — the owner's
own framing ("a wrong ITP rate silently skews every yield in a region")
demands the rate table be auditable at a glance, with its scope
limitations stated where a reviewer will actually read them. The revised
carrying-cost model applies the same standard to itself: additive,
individually-labelled real data beats a full-replacement shortcut that
happens to be directionally biased.

**See**: docs/decisions/D-010-rent-assumption-until-comparables.md,
`dashboard/lib/analytics/acquisition-costs.ts`,
`dashboard/lib/analytics/yield.ts` (module docstring has the full Málaga
worked-example trace), `dashboard/lib/analytics/__tests__/yield.test.ts`,
issues #151, #33.
