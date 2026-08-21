---
id: D-140
title: Reference-code matching tolerates a trailing unit/variant suffix
date: 2026-08-20
group: Data / connectors
rule: 'One normalizer, `etl.dedup.signals.reference_code.codes_equivalent`, used by BOTH `evaluate` and D-116''s veto (`reference_codes_conflict`) — never two implementations. A trailing unit/variant suffix (`-1`, `/2`, `_A`) on exactly ONE side (`LCSE42305` == `LCSE42305-1`) LIFTS the veto but caps `evaluate` at `suggest`/0.400 — NEVER `merge`, regardless of corroboration (56 measured same-source pairs show a suffix is often how one agency distinguishes two real units). `_normalize`''s leading-label strip requires a real separator/end-of-string boundary (a bare "ref"/"referencia" prefix with no separator is never stripped). Measured reach against the live corpus (2026-08-21): 0 pairs newly match, 0 newly veto, 0 bug pairs.'
---

# D-140: Reference-code matching tolerates a trailing unit/variant suffix

*Decided: 2026-08-20, revised 2026-08-21 after Opus review*

> ## REVISES (2026-08-20) — see [D-116](D-116-reference-code-conflict-veto.md)

**Context**: Issue #629, the owner on a real pair (fotocasa/pisos, same
price/m²/rooms/city — see D-141/issue #628): *"las referencias deben
poder permitir una mínima variación, fíjate que en el anuncio que te dije
una de ellas tiene -1 al final."* The fotocasa side carries `LCSE42305-1`;
the matching listing elsewhere carries the same code without the suffix.

[D-116](D-116-reference-code-conflict-veto.md) states the conflict veto is
"plain inequality, no prefix/fuzzy tolerance" — under that rule
`LCSE42305` and `LCSE42305-1` are different codes. Issue #628 (D-141)
widens `contact_raw` capture (pisos gets it via a new detail fetch,
idealista's page carries an advertiser-name block that was simply never
read, solvia/servihabitat get their own constant selling-entity name).
Once `contact_raw` is populated on both sides of a pair that ALSO shares
this exact suffix variation, D-116's veto — unchanged — would fire on the
one pair the owner just asked to be matched: it would return "no match at
all" for every signal, overriding whatever else agrees. **Fixing #628
without this arms that bug.** That is why the two ship in one PR.

**Decision**: `etl/dedup/signals/reference_code.py` gains ONE new function,
`codes_equivalent(code_a, code_b)`, called by both `evaluate()` (the
positive match path) and `reference_codes_conflict()` (D-116's veto) —
never a second implementation of the same comparison. On top of
`_normalize`'s existing case/whitespace/placeholder handling (now also
stripping a leading `ref`/`ref.`/`referencia` label, purely cosmetic —
see `_LEADING_LABEL_RE`), `codes_equivalent` additionally treats two codes
as equivalent when exactly ONE of them carries a trailing unit/variant
suffix (hyphen/underscore/slash + 1-3 alphanumeric characters,
`_strip_variant_suffix`) whose base equals the other side's full code.
Deliberately narrow:

- Two codes both carrying a suffix, even the same shape, are compared
  literally (`LCSE42305-1` vs. `LCSE42305-2` stays a genuine mismatch —
  that is two different units, not one property rendered two ways).
- No edit-distance/fuzzy tolerance of any kind — a changed digit anywhere
  in the middle of the code is still a different property.
- The two real pairs D-116's own amendment history pinned as "must still
  conflict" (`TestPlainComparisonNoPrefixTolerance`, a space-separated and
  a comma-separated trailing token) are UNCHANGED — neither separator is
  in the tolerated set (`-`, `_`, `/` only), so both stay plain
  inequalities.

**Revision (2026-08-21, Opus review of PR #632) — two must-fix findings,
both fixed before merge:**

1. **A suffix-tolerant match must NEVER reach `evaluate`'s `merge` tier.**
   The original version of this decision let `codes_equivalent` feed
   straight into the existing tiering (bare/same-agency/proximity-
   corroborated), so a same-agency pair with matching coordinates+size
   AND a suffix relation landed at the FULL `0.900` auto-merge
   confidence — `_proximity_corroborated`'s coords/size check does not
   discriminate this case at all, since two adjacent units in one
   building routinely share both. **Measured against the live corpus
   (2026-08-21, same-source, same-base grouping): 56 pairs where a bare
   code and its suffixed sibling are held by DIFFERENT `property_id`s** —
   i.e. within one agency's own book, `X` vs `X-1` is frequently how they
   distinguish two real, different units, not a rendering variation of
   one. `evaluate()` now branches on EXACT vs. suffix-tolerant equality
   before either corroboration check runs: a non-exact (suffix-tolerant)
   match is capped at a fixed `_SUFFIX_TOLERANT_CONFIDENCE = 0.400`,
   `decision="suggest"`, unconditionally — proximity corroboration and
   same-agency status are never consulted for it, so no code path can
   promote it to `merge`. An EXACT match is unaffected and still reaches
   the full `0.900` merge tier under the same corroboration rules as
   before. The veto side (`reference_codes_conflict`) is unaffected by
   this fix — a suffix relation still lifts the veto (returns "not a
   conflict"), which is the actually-reported #629 bug; only the
   positive-match tier changed.
2. **The leading-label strip needed a real separator boundary, not an
   optional one.** The original `_LEADING_LABEL_RE` accepted zero
   characters between the label and the code, so it silently corrupted
   or dropped real codes that merely started with "ref": `"REFORMA-12"`
   → `"orma-12"` (corrupted), `"REF1234"` → `"1234"` (a real prefix
   silently dropped), and — worst — `"REF100"` → `"100"` (3 chars, below
   `_MIN_CODE_LENGTH`) → unusable, which nullified D-116's OWN textbook
   example of the collision this veto exists to catch (`reference_codes_
   conflict`'s docstring and this file's own "alternatives rejected"
   section both cite "REF100" vs. "REF1005" as the case a prefix
   exemption must never swallow — the unguarded strip did exactly that).
   Measured justification for keeping the strip at all: only 3 of 11,477
   raw non-null reference codes in the live corpus start with "ref", and
   2 of those already carry a real separator. `_LEADING_LABEL_RE` now
   requires the label to be followed by whitespace, `:`, `-`, or
   end-of-string (a lookahead, not just an optional match) — it strips
   exactly those 2 real cases and leaves everything else, including
   "REFORMA-12"/"REF1234"/"REF100", untouched.

**Measurement (read-only against the live corpus via `ps prod psql`,
re-run 2026-08-21 against the post-fix code — never a raw listing query,
the actual cross-source/distinct-property_id pair space
`etl.dedup.engine._run` generates, replicated using the real
`etl.dedup.signals.reference_code` functions, not a reimplementation)**:

| Measurement | Count |
|---|---|
| Pairs that newly MATCH under the relaxed normalizer (suffix-tolerant, not exact) | **0** |
| Pairs newly VETOED by D-116 once `contact_raw` is populated (solvia/servihabitat's deterministic constant — the only #628 change simulable from already-stored rows) | **0** |
| Pairs the STRICT rule would have vetoed that the relaxed rule now matches instead (the #629 bug's size) | **0** |
| (context) Pairs already exactly matching today, unaffected by either change | 16 |
| (context) Same-source, same-base pairs where a bare code and a suffixed sibling sit on DIFFERENT properties — the evidence for finding 1 above | **56** |
| (context) Pending `suggested_merge` rows with a reference on exactly one side | 149 (115 pisos-side, 27 milanuncios-side, 7 fotocasa-side — re-measured 2026-08-21; was 241/136/96/9 at the PR's original measurement, narrowed by unrelated dedup activity in between) |

**Why the headline three still measure zero, and why that does NOT mean
skip this**: D-116's veto and the suffix relaxation both require
`contact_raw` populated on BOTH sides of a pair that ALSO shares a
reference code. Only solvia/servihabitat's contribution to #628 is
retroactively simulable (a constant, knowable without a new capture);
idealista's real per-listing agency name and pisos's real reference code
are NOT retroactively knowable from rows already stored under the OLD
selectors — they only appear once the extension captures a page again /
a pisos crawl runs. Solvia and Servihabitat are two different banks'
exclusive distress books, so a cross-servicer pair sharing a reference
code is structurally unlikely — zero is the honest, expected number for
that specific slice. The real arming happens the first time idealista's
extension captures a listing whose agency also appears (under the
identical string) on another already-populated connector, or pisos's
connector runs live (see D-141 for why that specifically requires the
production `backfills_missing_reference_code` exemption, not just the
code existing). Shipping D-140 alongside D-141/#628 means that first real
pair is handled correctly (matched-as-suggestion or genuinely vetoed)
from the moment it exists, instead of silently mismatching — or, absent
finding 1's fix above, silently auto-merging two adjacent units — until
someone thinks to re-measure.

**Alternatives rejected**:
- *Tolerate any trailing token regardless of separator* (space, comma,
  etc.) — rejected: would flip `TestPlainComparisonNoPrefixTolerance`'s
  two pinned real pairs from "correctly conflicts" to "incorrectly
  matches," reopening the exact hole D-116's own amendment history
  already closed once.
- *Tolerate a prefix match (shared leading substring, unbounded)* —
  rejected again, for the same reason D-116's amendment history rejected
  it the first time: it would also exempt "REF100" vs. "REF1005," the
  sequential-CRM-id collision shape the veto exists to catch.
- *A second, independent comparison function for the veto vs. the match
  path* — rejected: this project has had two parallel definitions of the
  same comparison drift apart twice before; `codes_equivalent` is the one
  place this logic lives.
- *Let a suffix-tolerant match reach `merge` when corroborated* (the
  ORIGINAL, pre-review version of this decision) — rejected per finding 1
  above: the 56-pair measurement shows corroboration does not
  discriminate real-unit-vs-rendering-variation for this specific
  signal, so trusting it here would auto-merge distinct adjacent units
  on the owner's own documented false-positive pattern.
- *Give the leading-label strip an "already tried, give up" escape or
  drop it entirely* — rejected: 2 real codes in the corpus need it; the
  fix is a correct separator boundary, not removing the feature.

**Rationale**: the owner's flagged case is the single most common
real-world variation (a trailing unit/variant suffix), the relaxation is
narrow enough to leave every existing pinned regression test passing
unchanged, it never outruns what the corpus evidence supports (capped at
`suggest`, never `merge`, for exactly the reason 56 real same-source
pairs demonstrate), and shipping it in the SAME PR as #628's capture
widening is what keeps the capture fix from silently making things worse
the moment it has real data to work with.

**See**: `etl/dedup/signals/reference_code.py` (`codes_equivalent`,
`_normalize`, `_strip_variant_suffix`, `_SUFFIX_TOLERANT_CONFIDENCE`),
`etl/tests/test_dedup_signals_reference_code.py` (`TestCodesEquivalent`,
`TestLeadingLabelBoundary`, `TestEvaluate`'s tier-pinning cases),
`etl/tests/test_dedup_engine.py`'s `TestReferenceCodeSignal`/
`TestReferenceCodeConflictVeto` (unmodified, still passing), issues
#628/#629, [D-116](D-116-reference-code-conflict-veto.md) (revised),
[D-141](D-141-pisos-detail-fetch-for-reference-agency.md) (the capture-side
fix this ships alongside).
