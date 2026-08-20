---
id: D-116
title: Same-agency differing reference codes veto a merge outright
date: 2026-08-19
group: Data / connectors
rule: 'A same-agency (`contact_raw`, portal-agnostic) pair whose reference codes both clear `_normalize` and are NOT `codes_equivalent` (D-140: exact equality, or a trailing unit/variant suffix on exactly one side — never a bare `!=`, never wider fuzziness) is never a duplicate — `evaluate_pair` returns no match at all (no merge, no suggestion) for every signal except `cadastral`. Measured reach against the live corpus is ZERO as of 2026-08-20 (issues #628/#629 widened `contact_raw` capture to idealista/solvia/servihabitat, so multiple connectors now populate both fields — but no reachable cross-source pair happens to share matching values yet, not because no connector combination can) — see D-140 for the full measurement.'
---

# D-116: Same-agency differing reference codes veto a merge outright

*Decided: 2026-08-19*

> ## REVISED (2026-08-20) — see [D-140](D-140-reference-code-relaxed-normalizer.md)
>
> The "plain inequality, no prefix/fuzzy tolerance" claim in point 7 below
> is no longer exactly true: `reference_codes_conflict` now compares
> through `codes_equivalent`, which tolerates a trailing unit/variant
> suffix (`-1`, `/2`, `_A`) on exactly one side — the owner's own flagged
> example (issue #629). The veto's placement, cadastral exemption, and
> pending-row re-evaluation (points 1-5 below) are unchanged and still
> accurate. Point 6's connector-population TABLE below is a HISTORICAL
> snapshot from 2026-08-19 (only fotocasa/milanuncios populated
> `contact_raw` then) — issue #628 has since widened capture to
> idealista/solvia/servihabitat, so that table and its "only fotocasa and
> milanuncios ever supply it" claim are now stale. The reach conclusion
> (ZERO) still holds today, but for the reason D-140's own fresh
> measurement explains, not the one this table gives — read D-140's
> measurement table as the current one, this section as archaeology of
> why the veto was first written.

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
   reversal the moment this rule lands.

6. **Measured reach against the live corpus AS OF 2026-08-19: ZERO. State
   this plainly — do not read the numbers below as evidence the rule was
   doing anything yet.** (See the top-of-file REVISED note: this point's
   connector-population table is a historical snapshot, now stale —
   D-140 carries the current one.) `engine._run` never calls
   `evaluate_pair` on a
   same-source pair (issue #197, `etl/dedup/engine.py`) or on a pair
   already sharing a `property_id` — so the veto can only ever fire on a
   pair that is cross-source AND not-yet-merged. As populated by every
   registered connector today:

   | source | sale listings | `contact_raw` populated | usable `reference_code` |
   |---|---:|---:|---:|
   | fotocasa | 3,759 | 3,744 | 3,095 |
   | milanuncios | 115 | 115 | **0** |
   | every other source (13 connectors) | 8,323 | **0** | mostly populated |

   `_same_agency` requires `contact_raw` on BOTH sides — only fotocasa
   and milanuncios ever supply it, so a reachable eligible pair must be
   one fotocasa listing and one milanuncios listing. Milanuncios
   captures no `reference_code` at all, so `_normalize(b.reference_code)`
   is `None` for that side every time, and `reference_codes_conflict`
   returns `False` before ever comparing codes. **No reachable, eligible
   pair exists in the current corpus.** Measured three ways against the
   live DB, all read-only, all through `fetch_listing_records` +
   `run()`'s own two filters (source inequality, property_id
   inequality) rather than a raw listing query:
   - Currently-merged properties the veto would have blocked (restricted
     to cross-source pairs within them, since same-source pairs inside a
     merged property were never evaluated by anything to begin with):
     **0** (of 590).
   - Corpus-wide reachable (cross-source, cross-property) pairs the veto
     would kill today: **0**.
   - Pending `suggested_merge` rows the veto would kill: **0** (of
     28,408 scanned).

   This is a **forward-looking guard**, not yet an active rule: it
   becomes real protection the moment a second connector starts
   capturing agency name (`contact_raw`) alongside reference code — e.g.
   an Idealista connector that adds `contact_raw`, since Idealista
   already carries 3,245 usable reference codes today. Until then it
   changes nothing about what actually merges. Do not cite this decision
   as evidence of blocked merges in any status report; cite it as a
   rule now in place for when the data supports it.

7. **A prefix-based exemption was added, then reverted — recorded here
   for the audit trail, not re-added without new evidence.** The first
   blast-radius measurement (queried raw listing pairs sharing a
   `property_id` directly in SQL, WITHOUT going through `run()`'s
   same-source filter) found 9 "blocked" merged properties, including
   two that looked like false positives: property 37 (`"8385 11"` vs
   `"8385 11 1"`, both listings priced 239000) and property 71434
   (`"09502,1"` vs `"09502"`, both listings priced 170000) — one code is
   the other plus a short trailing token, prices tie exactly. A prefix
   exemption (`_is_prefix_formatting_artifact`, capped at a 3-character
   tail) was added on the strength of that measurement. A fresh-context
   review of the PR found the measurement itself was invalid: **both
   "false positive" pairs are fotocasa/fotocasa — same-source, hence
   structurally unreachable through `evaluate_pair` regardless of this
   veto's presence.** The naive `!=` comparison would never have fired
   on them either way, so the exemption prevented nothing, while it
   would also have exempted e.g. `"REF100"` vs `"REF1005"` (a 1-character
   tail) — exactly the sequential-CRM-id collision this veto exists to
   catch. **Reverted.** `reference_codes_conflict` is a plain inequality
   once both codes clear `_normalize`, with no prefix/edit-distance/
   fuzzy tolerance layered on top. Do not reintroduce that kind of
   tolerance without a blast-radius measurement taken through `run()`'s
   own pair generator (source inequality AND property_id inequality),
   never a raw listing query — see point 6's "measured three ways" for
   why that distinction is the entire lesson of this amendment.

8. **The owner's own motivating case stays unevaluable, and that is
   worth saying plainly rather than only in code.** Property 152 holds
   fotocasa listing 152 (`px04342`) and fotocasa listing 585
   (`px04969`) — same agency, two different references, one property,
   merged transitively through one or more Idealista listings that
   bridged them (Idealista carries no `contact_raw` today, so it could
   not itself be vetoed, but its address/coords/photo match to each
   fotocasa listing pulled both onto the same `property_id`). This is
   exactly the shape the owner described in #564 — and after this PR it
   **stays merged**, and the fotocasa/fotocasa pair **stays
   unevaluable**, because issue #197's same-source skip means
   `evaluate_pair` (hence this veto) is never asked about it, transitive
   merge or not. Catching this specific case would require relaxing
   #197's same-source skip specifically for same-agency-different-
   reference pairs — a real, scoped change, but one with its own blast
   radius (#197 exists because same-source *duplicates* are "really
   strange," per the owner, and relaxing it selectively changes that
   assumption for exactly the population this veto targets). **Not
   implemented here** — this is an owner decision to make deliberately,
   not a byproduct of landing the veto itself.

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

**See**: `etl/dedup/signals/reference_code.py`
(`reference_codes_conflict`, module docstring), `etl/dedup/engine.py`
(`evaluate_pair`), issue #564, issue #197 (same-source pair skip — the
reason measured reach is currently zero), issue #186
(`floor.floors_conflict`, the veto shape this mirrors), D-024
(pending-suggestion re-evaluation), PR #565 (full review history: the
original blast-radius measurement, the prefix-exemption amendment, and
its revert once the measurement was corrected).
