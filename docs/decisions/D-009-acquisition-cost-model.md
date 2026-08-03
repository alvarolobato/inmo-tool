---
id: D-009
title: Acquisition-cost model — ITP by CCAA (general rate only), flat notary/registry/gestoría defaults, actual carrying costs replace the assumed percentage when known
date: 2026-08-03
---

# D-009: Acquisition-cost model — ITP by CCAA, flat notary/registry/gestoría, actual carrying costs override the assumed percentage

*Decided: 2026-08-03*

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
4. **Carrying costs (IBI, community fees) replace, not blend with, the
   assumed operating-cost percentage** when a property's active listings
   publish them (Solvia's `raw_extra.ibi_anual_eur` /
   `raw_extra.gastos_comunidad_eur`) — read literally from issue #151's own
   wording ("used... rather than estimated"). This is a deliberate
   divergence from issue #33's original wording, which described ONE
   bundled `operating_cost_pct` covering community fees + IBI + maintenance
   + vacancy together; no second configuration mechanism was added
   (`operating_cost_pct` is unchanged, just only applied when no actual
   data exists) — checked against #33 first, per #151's own instruction.

**Alternatives rejected**:
- Modelling full progressive ITP brackets + every buyer-profile reduction —
  rejected as real tax-software scope, explicitly out of bounds for a
  decision-support tool (issue #1 §11/§16).
- Blending actual carrying costs with a prorated share of the assumed
  percentage (e.g. "subtract IBI's typical share of the 25% bundle, keep
  the rest for maintenance/vacancy") — rejected: inventing that sub-split
  would itself be exactly the fabricated-precision issue #1 §11 warns
  against. The chosen replacement approach trades a small amount of
  precision (actual IBI+community excludes maintenance/vacancy) for
  transparency; `assumptions_used.carrying_costs_source` always states
  which mode was used.

**Rationale**: A reviewable, cited table beats inline literals — the owner's
own framing ("a wrong ITP rate silently skews every yield in a region")
demands the rate table be auditable at a glance, with its scope
limitations stated where a reviewer will actually read them.

**See**: docs/decisions/D-008-rent-assumption-until-comparables.md,
`dashboard/lib/analytics/acquisition-costs.ts`,
`dashboard/lib/analytics/yield.ts`, issues #151, #33.
