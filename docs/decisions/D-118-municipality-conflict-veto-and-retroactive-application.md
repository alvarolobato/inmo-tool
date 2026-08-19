---
id: D-118
title: Normalized-municipality conflict vetoes a fuzzy suggestion; hard vetoes apply retroactively via a previewed, reversible pass
date: 2026-08-19
group: Data / connectors
rule: "A normalized `property.city` conflict (strip trailing `capital`, fold accents, casefold, collapse+drop whitespace, resolve known district->municipality aliases) vetoes `fuzzy.evaluate` ONLY, mirroring D-117 — never wired into `evaluate_pair`. `ps dedup retroactive [--apply]` (`etl/dedup/retroactive.py`, dry-run by default) reverts D-116 merges via `engine.revert` (never deletes) using the SAME cross-source, non-same-property reachability filter `evaluate_pair` itself has — a raw listing comparison undercounts what is actually unreachable. Reports (never triggers) D-117/D-118 pending-suggestion demotion, which happens on the next `ps dedup run` via D-024. Each arm degrades to unavailable, simulated explicitly in tests, when its rule's PR hasn't merged — never inferred from ambient absence."
---

# D-118: Normalized-municipality conflict vetoes a fuzzy suggestion; hard vetoes apply retroactively via a previewed, reversible pass

*Decided: 2026-08-19*

**Context**: Issue #568, raised by the owner after sampling the pending
backlog that survives #566/D-117's type/rooms veto: *"haz las fusiones en
paralelo y de forma retroactiva. de los que quedan seguro que mirando los
datos eres capaz de saber cuales son iguales y cuáles no, haz un muestreo
y crea más reglas."* A raw `property.city` comparison flags 8,072 pairs in
the pending `fuzzy` backlog, but 5,919 (73%) are one municipality written
two ways (`sevilla capital`/`sevilla`: 4,462; `málaga`/`málaga capital`:
1,117; `málaga`/`malaga`: 50) — the same "the rule is right, the literal
comparison is wrong" shape D-116 (reference codes) and D-117 (type/rooms)
already hit twice this week. The owner separately asked for D-116/D-117 to
be applied retroactively to what's already in the DB, reversibly and
previewed before acting.

**Decision**:

1. **Municipality normalization** (`etl/dedup/signals/municipality.py`,
   `normalize_city`): fold accents, casefold, collapse whitespace, strip a
   trailing `" capital"` token, then drop every remaining
   space/hyphen/underscore/apostrophe (folds e.g. servihabitat's
   no-space-slug `"sanjuandeaznalfarache"` onto
   `"San Juan de Aznalfarache"` — see point 3), then resolve a known
   district->municipality alias. Missing/unusable city on either side is
   permissive (`municipality_conflict` returns `False`), mirroring
   `floor.floors_conflict`'s shape.

2. **Scoped to `fuzzy` only** (`fuzzy.evaluate`), never wired into
   `evaluate_pair` — exactly D-117's shape, for the same measured reason:
   comparing every non-reverted `property_merge_log` row's surviving vs.
   losing property `city` found a REAL Málaga-district merge (`Churriana`
   vs `Málaga`, `photo_hash`, 0.900 confidence, property 6953) an
   engine-wide veto would have broken. Every stronger signal is untouched.

3. **District-vs-municipality is a real, closed alias list**
   (`_DISTRICT_ALIASES`), found by inspecting every distinct `property.city`
   value (654) for anything reading as a district rather than a town, per
   the issue's own instruction to check for the Montequinto shape before
   shipping:
   - `montequinto` -> `dos hermanas` (idealista) — the issue's own named
     example.
   - `churriana` -> `malaga` — corroborated by the real photo_hash merge
     above, not just a gazetteer lookup.
   - 12 `mad<district>` slugs (`madcanillejas`, `madcarabanchel`, ...,
     `madvillaverde`) -> `madrid` — `servihabitat`'s own
     `province-comarca-municipality` URL-slug parser
     (`etl.connectors.servihabitat_mapping.parse_location_slug`) puts a
     Madrid city district in the municipality slot; every other
     servihabitat municipality slug is real, not split further.
   A closed, explicit list (mirrors D-020/D-022's pinned-exact-rule
   discipline) rather than a heuristic — a "looks like a district" guess
   risks swallowing a genuinely different, smaller municipality.

4. **The de-spacing normalization is a third finding, not scope creep.**
   Beyond the issue's own checklist (trailing `capital`, accents, case,
   whitespace-collapse), `servihabitat`'s `city` is a lowercased,
   fully de-spaced URL-slug segment (its own docstring: "deliberately
   returned as-is rather than guessed at"). Real evidence this matters:
   `property_merge_log` ids 388/513/514/515 (all `photo_hash`, genuine
   corroborated merges) pair a servihabitat slug city against a
   spaced/accented city for the SAME municipality. Left un-collapsed, the
   comparison key would needlessly veto legitimate `fuzzy` suggestions
   between a servihabitat listing and any other portal's listing of the
   same place — the exact "naive comparison is wrong" trap this issue is
   about, found by doing the issue's own "look for others of that shape"
   check rather than stopping at the first fix.

5. **Retroactive application** (`etl/dedup/retroactive.py`,
   `ps dedup retroactive [--apply]`):
   - **D-116** (PR #565, merged): `find_reference_code_veto_merges`
     replays the SAME reachability filter `engine._run()` itself applies
     — cross-source AND cross-property (issue #197 skips same-source
     pairs before `evaluate_pair` ever sees them) — not a raw listing
     comparison. Measured through that corrected filter: **ZERO**
     currently-merged properties conflict, matching what D-116's own
     shipped module docstring independently documents (only
     `fotocasa`/`milanuncios` populate `contact_raw` today, and
     `milanuncios` captures no `reference_code`, so no reachable pair has
     ever had both fields to compare). An earlier draft of this function
     compared every listing on a merged property against every listing
     that merge moved in, REGARDLESS of source — a materially larger,
     unreachable population — and reported 7 currently-merged properties
     (9 `property_merge_log` rows) as a result. That number was wrong; a
     coordinator review of #569 caught it before merge. When D-116
     eventually does find a real conflicting merge (the moment a second
     connector starts capturing agency name alongside reference code),
     `--apply` reverts it via `engine.revert` — the SAME function
     `ps dedup revert <id>` already calls — never a bespoke unmerge path,
     never a `DELETE`.
   - **D-117/D-118**: zero blast radius against existing merges by
     construction (fuzzy-scoped, never auto-merges), so their retroactive
     effect is entirely D-024's existing per-run pending-suggestion
     reevaluation, exercised by the next `ps dedup run` — this command
     reports the count (`count_pending_fuzzy_demotions`) but does NOT
     trigger it itself, to avoid a revert command silently paying for a
     full O(n^2) production dedup pass as a side effect. Verified this
     reevaluation mechanism actually engages (not assumed) via a DB-backed
     test that files a pending `fuzzy` suggestion, runs `engine.run()`,
     and asserts it lands `status='rejected'` with `reevaluated_from` set.
   - **Dry-run is the default** everywhere (`run_retroactive_pass(conn)`
     with no `apply`, and the CLI with no `--apply`) — writes nothing,
     only reports.
   - **Degrades cleanly when a rule's PR hasn't merged**, rather than
     gating behind merge order: `reference_codes_conflict`/
     `structured_fields_conflict` are imported defensively
     (`_reference_codes_conflict_fn`/`_structured_fields_conflict_fn`);
     absent, the corresponding section reports "rule not present in this
     build" and contributes zero, instead of raising. D-116 (#565) has
     since merged, so that arm is live (at its measured ZERO reach,
     above); D-117 (#567) is still open as of this writing, so its arm
     still degrades to unavailable in practice, not just in a test — the
     degrade-path tests simulate absence EXPLICITLY via
     `monkeypatch.delattr`/`monkeypatch.setattr` on the injection seam,
     never by relying on a dependency being ambiently missing (a lesson
     learned the hard way: the first cut of this PR's tests assumed
     D-116 would stay absent and broke the moment #565 merged). Chosen
     over gating because D-118's own municipality veto is independently
     useful the moment this PR lands, and `ps dedup retroactive` needs no
     code change to pick up each rule once its PR merges, in whichever
     order.

**Alternatives rejected**:
- *Engine-wide municipality veto* — rejected on the measured Churriana
  counter-example, same reasoning as D-117.
- *Gate the retroactive command behind #565/#567 merging first* —
  rejected: it would make this PR's own D-118 rule (which needs no
  dependency) wait on two unrelated open PRs, and the degrade-cleanly
  design costs nothing once they do land.
- *Have `--apply` also trigger `engine.run()` to force-demote pending
  suggestions immediately* — rejected: `engine.run()` is a full O(n^2)
  pairwise scan (~13.3us/pair, minutes at current volume), not a
  lightweight "just the pending rows" path; forcing it as a side effect of
  a revert command would make a fast, surgical operation silently slow and
  couple two independent concerns.
- *Heuristic district detection* (e.g. "looks like `<prefix><city>`") —
  rejected in favour of the explicit closed alias list, same reasoning as
  D-020/D-022.

**Rationale**: Same pattern, third time this week — a field-equality veto
is right in principle and wrong in its literal form until normalized
against real portal data, and the exceptions (district-vs-municipality,
a connector's own slug format) only surface by inspecting the actual
`city` values, not by reasoning about Spanish geography in the abstract.
The retroactive pass reuses D-116/D-117's OWN veto predicates and D-024's
OWN reevaluation mechanism rather than re-deriving either — a revert is a
revert regardless of when the rule that motivates it landed.

**See**: `etl/dedup/signals/municipality.py`, `etl/dedup/signals/fuzzy.py`,
`etl/dedup/retroactive.py`, `etl/dedup/cli.py` (`ps dedup retroactive`),
`etl/tests/test_dedup_signals_municipality.py`,
`etl/tests/test_dedup_engine.py::TestMunicipalityFuzzyVeto`,
`etl/tests/test_dedup_retroactive.py`, issue #568, D-116, D-117, D-024.
