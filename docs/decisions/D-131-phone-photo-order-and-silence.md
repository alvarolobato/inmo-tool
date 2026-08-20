---
id: D-131
title: photo_hash before phone; uncorroborated/agency phone silenced
date: 2026-08-20
group: Data / connectors
rule: "`evaluate_pair` evaluates `photo_hash` before `phone` (was the reverse). `phone_extract.evaluate` returns `None` (files no suggestion) for the uncorroborated tier and the corroborated-but-either-side-agency tier — both previously a 0.500 suggestion. The corroborated `particular`/`particular` merge (0.900) and corroborated-unconfirmed-kind suggestion (0.750) tiers are unchanged."
---

# D-131: photo_hash evaluated before phone; uncorroborated/agency phone tiers silenced

*Decided: 2026-08-20*

**Context**: Issue #603, evidence gathered in the #600 spike (aggressive
data review of the 25,850-row dedup backlog, prompted by the owner not
believing the queue's size). All 320 pending `phone` suggestions on the
live corpus trace back to only **19 distinct phone numbers** — 9 of them
alone appear in 6–50 listings each — and **100%** of the 320 pairs have at
least one confirmed-agency (`listing_kind='agency'`) side. 280 of the 320
additionally share zero photos. This matches the owner's own diagnosis
("las inmobiliarias ponen siempre el mismo teléfono") exactly: an agency's
front-desk line reused across unrelated listings is not evidence of
anything, and filing a 0.500 suggestion for it was pure queue noise.

A second, sharper problem was hiding behind the noise: because
`evaluate_pair` ran `phone_extract.evaluate` before `photo_hash`, a pair
that had BOTH a shared (agency) phone number AND strong photo evidence
never got a chance to be scored by `photo_hash` at all — `evaluate_pair`
returns as soon as the first signal in priority order fires, and phone
fired first. Measured: **19 of the 320** pending phone rows were actually
photo-ratio ≥ 0.6 pairs (mostly exactly 1.0, with identical price/m²/
description on both sides) — real duplicates, permanently shadowed at
phone's uncorroborated-or-agency 0.500 tier.

**Decision**: Two changes, landed together because the second only earns
its keep once the first has happened:

1. `evaluate_pair` (`etl/dedup/engine.py`) now runs `photo_hash` before
   `phone` — `address_coords` → `reference_code` → `photo_hash` → `phone`.
   Only phone's position moved; nothing else in the priority order
   changed. (Corrected 2026-08-20, issue #607/S4: the order this record
   originally documented still ended `→ fuzzy` — accurate the moment this
   decision landed, but D-130 retired `fuzzy` outright in the same PR, so
   the shipped `evaluate_pair` order ends at `phone`. There is no fifth
   step any more.) The photo-hash store (D-025) makes a warm re-fetch here
   effectively free — no meaningful cost delta measured for reordering
   ahead of phone specifically.
2. `phone_extract.evaluate` (`etl/dedup/signals/phone_extract.py`) returns
   `None` instead of a 0.500 `PairEvaluation` for:
   - the **uncorroborated** tier (no coordinate/price/size proximity at
     all), and
   - the **corroborated-but-either-side-agency** tier.

   The two non-agency corroborated tiers are untouched: `particular`/
   `particular` still auto-merges at 0.900, and a corroborated pair with
   an unconfirmed (`None`) `listing_kind` on either side still suggests at
   0.750 — both are real, non-agency evidence this module alone can offer.

A one-off migration (`ps dedup purge-phone` / `etl.dedup.engine.
purge_pending_phone`) deletes any `pending`+`match_basis='phone'` row
still standing after a full reevaluation pass — in the ideal case this
finds nothing (every pre-existing phone-pending row is naturally resolved
by the standard D-024 reevaluation on the very next run: merged if
`photo_hash` or phone's surviving tiers now explain it, refreshed onto
`photo_hash`/`fuzzy` if one of those now claims it, or auto-rejected if
nothing fires any more), but exists as the same explicit, reviewable,
idempotent cleanup step as `purge_same_source_pending` (issue #197).

**Alternatives rejected**:
- *Tune the 0.500 tier's threshold instead of silencing it* — there is no
  threshold to tune. The signal itself (a shared phone number, no other
  corroboration, involving an agency) carries no discriminating
  information; the measured precision is effectively the base rate of
  "two random agency listings happen to share their front-desk number,"
  which is not "similar," it's "this agency's normal behavior."
- *Only reorder, leave the 0.500/agency tiers filing suggestions* — would
  still leave ~300 pure-noise rows in the queue; the reorder alone fixes
  the 19 shadowed pairs but does nothing for the other 301.
- *Only silence, leave phone before photo_hash* — would leave the 19
  shadowed pairs unrescued: a silenced phone tier returning `None` still
  falls through to `photo_hash` in the OLD order only if phone comes
  before it in program order and phone's own match returns `None` — but a
  pair whose phone match *would* have fired the surviving 0.750 tier
  (unconfirmed kind, not silenced) still shadows a stronger `photo_hash`
  match under the old order. The reorder is what makes the rescue
  unconditional regardless of which phone tier a pair would have hit.

**Rationale**: Corroboration discipline for phone-in-description already
existed (issue #16); this revises WHICH corroboration levels are worth a
human's attention now that real production data shows the uncorroborated
and agency tiers are indistinguishable from noise, and reorders signal
evaluation so a weaker signal can never shadow a stronger one that would
otherwise resolve the same pair.

**See**: `etl/dedup/engine.py` (`evaluate_pair`), `etl/dedup/signals/
phone_extract.py`, `etl/dedup/cli.py` (`purge-phone`), issue #600 (the
spike), issue #603, D-024 (pending reevaluation), D-025 (photo hash
store).
