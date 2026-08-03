---
id: D-010
title: Rent estimate ships as an explicit per-profile assumption until #31 lands
date: 2026-08-03
---

# D-010: Rent estimate ships as an explicit per-profile assumption until #31 lands

*Decided: 2026-08-03*

**Context**: Issue #151 (yield including acquisition costs) ties together #31
(comparable-rental ingestion + rent estimation), #32 (area price-per-m²), and
#33 (yield/cash-on-cash). #31 is a full new connector (a `rental_listing`
table + a per-site rental crawler) and was explicitly out of scope for the
PR implementing #151/#32/#33 — it requires work under `etl/connectors/`,
which other in-flight work on this repo owns. Without #31, there is no
comparable rental signal anywhere in the database.

Issue #151 named three explicit options: (1) build a minimal rent input now
(a per-profile/per-zone €/m²/month assumption), (2) estimate from whatever
comparable signal exists, or (3) ship the cost side only and gate yield
behind #31.

**Decision**: Option (2) is not available — there is no comparable rental
signal in the schema today, so "estimate from what exists" is
indistinguishable from inventing a number, which issue #151 explicitly
bans. Implemented a hybrid of (1) and (3):
`search_profile.thesis_params.rent_assumption.eur_per_m2_month` is a new,
optional, per-profile field the user sets explicitly. `rent-estimate.ts`
multiplies it by the property's `m2_built` when set, and returns an
explicit `method: "no_rent_assumption"` / `estimated_monthly_rent: null`
result when it isn't — never a fabricated figure. `yield.ts` gates its
entire output on this: no rent assumption means no yield, cash-on-cash, or
acquisition-cost breakdown rendered, not a zero or a system-invented
default.

**Addendum (2026-08, Opus review on PR #181)**: `method` gained a third
value, `"no_property_size"`, distinct from `"no_rent_assumption"` — a
profile that HAS set `rent_assumption` but whose property lacks `m2_built`
was previously indistinguishable from a profile that never set one, and the
UI told the user to add an assumption they'd already added. The two gates
(assumption unset vs. property size unknown) are now reported separately so
the empty-state copy can name the actual missing input.

`RentConfidence` (`"high" | "low" | "assumption" | null`) is typed as a
superset of #31's planned confidence tiers (`"high"`/`"low"`, tiered by
comparable count) even though this module only ever produces `"assumption"`
or `null` today. This is deliberate: `yield.ts`'s confidence-propagation
contract (issue #33 EC-4) is written once against the full tiering issue
#31 specifies, so #31 can later replace `rent-estimate.ts`'s
*implementation* without a signature change to anything downstream.

**Alternatives rejected**:
- A system-wide default €/m²/month (e.g. a national or per-property-type
  average) — rejected outright: this is exactly "inventing a rent figure
  and presenting it as derived," which issue #151 explicitly prohibits.
- Deferring #32/#33's yield entirely until #31 ships (pure option 3) —
  rejected because it would leave the owner's core request (issue #151 is
  owner-filed) with zero working output for an indefinite time, and a
  profile-level assumption is honestly labelled, not fabricated, so long as
  the UI never lets it read as a measurement.

**Rationale**: An explicit, user-owned assumption is the only rent figure
this codebase can produce today without misrepresenting its provenance. The
confidence-tier type superset means #31's eventual landing is a pure
data-source swap, not a refactor of every consumer.

**See**: docs/decisions/D-011-acquisition-cost-model.md,
`dashboard/lib/analytics/rent-estimate.ts`,
`dashboard/lib/analytics/yield.ts`, issues #151, #31, #33.
