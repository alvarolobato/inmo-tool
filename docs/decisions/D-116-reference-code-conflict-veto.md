---
id: D-116
title: Same-agency differing reference codes veto a merge outright
date: 2026-08-19
group: Data / connectors
rule: 'A same-agency (`contact_raw`, portal-agnostic) pair whose reference codes both normalize to real, DIFFERING values is never a duplicate — UNLESS one normalized code is the other plus a trailing extension of at most 3 characters (a formatting artifact, not two properties) — `evaluate_pair` returns no match at all (no merge, no suggestion) for every signal except `cadastral`, regardless of address/coords/photo/size agreement.'
---

# D-116: Same-agency differing reference codes veto a merge outright

*Decided: 2026-08-19*

**Context**: Issue #564, raised by the owner: *"en la gestión de
duplicados si hay una referencia, de la misma inmobiliaria y es
diferente, directamente no son duplicados"* — corrected on scope: *"La
misma inmobiliaria no es el portal, sino el campo inmobiliaria dentro de
un mismo portal o varios."* An agency assigns one reference per property
in its own CRM; two listings from the same agency (`_same_agency`,
`etl/dedup/signals/reference_code.py:125` — the `contact_raw` field,
case-folded/trimmed, already portal-agnostic) carrying two different
usable codes are, by that agency's own bookkeeping, two different
properties. `etl/dedup/engine.py`'s `perform_merge` already flagged this
in a comment (line ~481, pre-existing): a merge where both sides carry
different references is "a signal that the merge was wrong" — written
down, never implemented, until now.

This is precisely the case where every similarity signal is most easily
fooled: same building, same agency, same photographer, adjacent units —
address, coordinates, photo hash and size can all agree between two
genuinely different flats an agency lists side by side.

**Decision**:

1. **The veto**: `reference_code.reference_codes_conflict(a, b)` is
   `True` only when `_same_agency(a, b)` AND both sides' reference codes
   survive the module's existing `_normalize` (placeholder/too-short/
   digit-free codes are rejected, same as the positive-match path) AND
   the normalized codes differ. Absence or an unusable code on either
   side is "we don't know" — never "they differ" — mirroring
   `floor.floors_conflict`'s permissive-on-absence shape (issue #186).
   Different agencies with different codes are not eligible at all
   (`_same_agency` gates first) — codes are agency-namespaced, so that
   case means nothing.

2. **Where it applies**: `engine.evaluate_pair` checks the veto
   immediately after `cadastral.evaluate` and before every other signal
   (`address_coords`, `phone_extract`, `reference_code`'s own weaker
   paths, `photo_hash`, `fuzzy`). On a hit it returns `None` outright —
   **not** a downgrade to a weaker suggestion. This is deliberately
   stronger than the #186 floor veto (which only demotes a merge some
   other signal still supports to a weaker suggestion, e.g. `fuzzy`):
   a same-agency reference conflict is direct evidence the pair is *not*
   a duplicate, so nothing downstream should get to suggest it either.

3. **Cadastral is exempt.** `cadastral.evaluate` runs first and returns
   immediately if it fires. A cadastral reference is a government
   registry ID, not agency bookkeeping — `cadastral.py`'s own docstring
   calls an exact match "conclusive" and "never wrong" (confidence
   1.000, unconditional merge). An agency's own internal-ref mismatch
   (a data-entry slip, a renumbering) does not get to override the
   land-registry identifier.

4. **Effect on an existing `pending` `suggested_merge` row**: no new
   code path — D-024 already re-evaluates every `pending` row against
   current rules on every `run()`. A pending row whose pair now trips
   this veto gets a fresh `evaluation is None` from `evaluate_pair`,
   which `_reevaluate_pending_suggestion`'s existing branch demotes to
   `status='rejected'` with `reevaluated_from`/`reevaluated_reason` set
   — the exact mechanism issue #186's floor veto already exercises for
   its own "no signal fires any more" case. `rejected` (not a new
   `conflict` status) because this is the engine confidently changing
   its verdict under corrected rules, not an ambiguous state needing a
   human `dedup resolve-conflict` call.

5. **Effect on an already-merged property: none, automatically.**
   `run()`'s per-run pairwise loop only evaluates listings that do not
   already share a `property_id` (`if a.property_id == b.property_id:
   continue`) — a merge already performed is structurally outside
   `evaluate_pair`'s reach. This PR does **not** auto-unmerge anything:
   splitting a merged property is a destructive action (it would
   fragment accumulated `ai_assessment`/feedback/scoring history keyed
   on `property_id` — see ARCHITECTURE.md's rationale for property-level
   keying) and deserves an explicit human decision, not a silent
   reversal the moment this rule lands. The PR's blast-radius query
   (read-only, against the live DB) counts how many currently-merged
   properties this veto would have blocked, for the owner to review as a
   deliberate follow-up rather than a byproduct of this change.

6. **A short trailing extension on one code does NOT count as
   "differing" — it is a formatting artifact, not two properties.**
   Amendment made the same day, after the first blast-radius run against
   the live demo DB surfaced two real false positives at 20% of the
   9 flagged pairs: property 37 (`"8385 11"` vs `"8385 11 1"`, both
   listings priced 239000) and property 71434 (`"09502,1"` vs `"09502"`,
   both listings priced 170000) — in both, one code is exactly the other
   plus a short trailing token, and the prices agree exactly. These are
   one property whose reference was recorded with a stray suffix on one
   portal, not two properties; the naive `!=` comparison would have
   vetoed (and, per point 4 above, silently un-suggested/rejected) a
   correct merge.
   The exemption (`reference_code._is_prefix_formatting_artifact`) fires
   ONLY when, after `_normalize`, one code is a strict prefix of the
   other (checked both directions) AND the extra trailing length is at
   most **3 characters**. Both real cases are 2-character tails (`" 1"`,
   `",1"`); every genuine same-agency-different-property pair found in
   the same review (`"3450-09081"`/`"3450-09082"`,
   `"CH-37450-0007"`/`"CH-37450-0006"`, `"TE912BSEV"`/`"TE911BSEV"`,
   `"100096612"`/`"100096617"`) differs mid-string or in its last
   character at the SAME length, never solely by a trailing extension —
   so the exemption does not touch them. The cap is deliberate and
   bounded, not an unbounded prefix check: an unbounded version would
   silently abstain on two genuinely different but coincidentally
   same-prefixed codes (e.g. two unrelated long sequential numeric CRM
   ids sharing a leading digit run) — exactly the "dirty codes" failure
   mode this veto exists to catch, not manufacture. An implementer
   reading only the rule line above must implement this bounded-prefix
   check, not a plain `!=`.
   Re-measured after this amendment: **7 of 558** currently-merged
   properties would be blocked (down from 9 — confirms 37 and 71434
   dropped out and nothing else changed); pending suggestions killed
   stayed at **0**. See the PR body (#565) for the full before/after
   table.

**Alternatives rejected**:
- *Auto-unmerge every already-merged pair that trips the veto* — rejected
  as unacceptably risky for a first landing: no confirmation the flagged
  pairs are actually wrong (vs. e.g. an agency's own re-numbering of one
  listing after the merge), and it would silently rewrite property-level
  history a human hasn't reviewed.
- *Raise `conflict` instead of `rejected` for a re-evaluated pending row*
  — rejected for consistency with the existing D-024/#186 precedent,
  which already treats "no signal fires any more under corrected rules"
  as a `rejected` outcome, not an ambiguous state needing
  `dedup resolve-conflict`.
- *Demote to a weaker suggestion instead of a full veto* (mirroring the
  floor veto's shape exactly) — rejected because the underlying evidence
  is qualitatively different: a floor conflict is corroborating data that
  might itself be wrong (portal formatting, a range description); a
  same-agency reference-code mismatch is the agency's own authoritative
  per-property key saying "different property," per the issue's own
  wording ("directamente no son duplicados").

**Rationale**: The module's own docstring already argued the positive
side of this insight (same-agency-same-code is *not* independent
corroboration, because two listings from one agency always match on
`contact_raw` by construction). The negative side is the mirror image and
just as sound: same-agency-*different*-code is the agency's own records
actively contradicting a merge, which every weaker similarity signal
should defer to.

**See**: `etl/dedup/signals/reference_code.py` (`reference_codes_conflict`,
`_is_prefix_formatting_artifact`, module docstring), `etl/dedup/engine.py`
(`evaluate_pair`), issue #564, issue #186 (`floor.floors_conflict`, the
veto shape this mirrors), D-024 (pending-suggestion re-evaluation), PR
#565 (blast-radius numbers, before and after this amendment).
