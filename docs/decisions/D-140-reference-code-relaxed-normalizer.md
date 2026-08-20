---
id: D-140
title: Reference-code matching tolerates a trailing unit/variant suffix
date: 2026-08-20
group: Data / connectors
rule: 'One normalizer, `etl.dedup.signals.reference_code.codes_equivalent`, used by BOTH the positive match (`evaluate`) and D-116''s conflict veto (`reference_codes_conflict`) — never two implementations. It tolerates a trailing unit/variant suffix (`-1`, `/2`, `_A`) on exactly ONE side (`LCSE42305` == `LCSE42305-1`), never arbitrary edit distance, never two DIFFERING suffixes on both sides. `_normalize` also strips a leading "ref"/"ref."/"referencia" label. Measured reach against the live corpus (2026-08-20): 0 pairs newly match, 0 newly veto, 0 bug pairs — see rationale for why, and why this still had to ship with #628.'
---

# D-140: Reference-code matching tolerates a trailing unit/variant suffix

*Decided: 2026-08-20*

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

**Measurement (required before shipping, read-only against the live
corpus via `ps prod psql`, never a raw listing query — the actual
cross-source/distinct-property_id pair space `etl.dedup.engine._run`
generates, replicated using the real `etl.dedup.signals.reference_code`
functions, not a reimplementation)**:

| Measurement | Count |
|---|---|
| Pairs that newly MATCH under the relaxed normalizer (suffix-tolerant, not exact) | **0** |
| Pairs newly VETOED by D-116 once `contact_raw` is populated (solvia/servihabitat's deterministic constant — the only #628 change simulable from already-stored rows) | **0** |
| Pairs the STRICT rule would have vetoed that the relaxed rule now matches instead (the #629 bug's size) | **0** |
| (context) Pairs already exactly matching today, unaffected by either change | 16 |
| (context) Pending `suggested_merge` rows with a reference on exactly one side | 241 (136 pisos-side, 96 milanuncios-side, 9 fotocasa-side) |

**Why the reach measures zero today, and why that does NOT mean skip
this**: D-116's veto and the suffix relaxation both require `contact_raw`
populated on BOTH sides of a pair that ALSO shares a reference code. Only
solvia/servihabitat's contribution to #628 is retroactively simulable
(a constant, knowable without a new capture); idealista's real per-listing
agency name and pisos's real reference code are NOT retroactively knowable
from rows already stored under the OLD selectors — they only appear once
the extension captures a page again / a pisos crawl runs. Solvia and
Servihabitat are two different banks' exclusive distress books, so a
cross-servicer pair sharing a reference code is structurally unlikely —
zero is the honest, expected number for that specific slice. The real
arming happens the first time idealista's extension captures a listing
whose agency also appears (under the identical string) on another
already-populated connector, or pisos's connector runs live. Shipping
D-140 alongside D-141/#628 means that first real pair is handled
correctly (matched or genuinely vetoed) from the moment it exists, instead
of silently mismatching until someone thinks to re-measure.

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

**Rationale**: the owner's flagged case is the single most common
real-world variation (a trailing unit/variant suffix), the relaxation is
narrow enough to leave every existing pinned regression test passing
unchanged, and shipping it in the SAME PR as #628's capture widening is
what keeps the capture fix from silently making things worse the moment
it has real data to work with.

**See**: `etl/dedup/signals/reference_code.py` (`codes_equivalent`,
`_normalize`, `_strip_variant_suffix`), `etl/tests/test_dedup_signals_reference_code.py`,
`etl/tests/test_dedup_engine.py`'s `TestReferenceCodeSignal`/
`TestReferenceCodeConflictVeto` (unmodified, still passing), issues
#628/#629, [D-116](D-116-reference-code-conflict-veto.md) (revised),
[D-141](D-141-pisos-detail-fetch-for-reference-agency.md) (the capture-side
fix this ships alongside).
