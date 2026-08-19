"""Retroactive application of dedup hard-veto rules to already-persisted
state (issue #568 — the owner's own request: *"haz las fusiones en
paralelo y de forma retroactiva"*).

Three rules are in scope:

- **D-116** (reference-code conflict, PR #565 — MERGED into main): this
  module REVERTS any non-reverted `property_merge_log` row it finds
  conflicting, via `etl.dedup.engine.revert`, which sets `reverted_at` and
  restores pointers/`profile_listing_state`/`feedback_event` state.
  **Nothing is ever deleted.** Measured current reach against the live
  demo DB, through the SAME reachability filter `engine._run()` itself
  applies (source inequality, on top of property_id inequality — issue
  #197 skips same-source pairs before `evaluate_pair` ever sees them): a
  forward-looking guard, currently **ZERO** — the shipped veto has never
  had an eligible, reachable pair to fire against yet (see
  `etl.dedup.signals.reference_code`'s own module docstring, which
  documents the same ZERO independently). Real protection the moment a
  second connector starts capturing agency name alongside reference code;
  not dead code.
- **D-117** (structured-field conflict, PR #567, open) and **D-118**
  (this issue's municipality veto): both are `fuzzy`-scoped and never
  auto-merge, so they have **zero** blast radius against already-merged
  properties by construction — `fuzzy.evaluate` is never reached for two
  listings that already share a `property_id`
  (`engine._run`'s `if a.property_id == b.property_id: continue`). Their
  retroactive effect is entirely carried by D-024's existing per-run
  pending-suggestion re-evaluation (`engine._reevaluate_pending_suggestion`,
  exercised inside `engine.run()`/`ps dedup run`) — this module does not
  invent a second demotion code path. `count_pending_fuzzy_demotions`
  below answers "how many, without running a real dedup pass" for the
  dry-run report; the demotion itself happens on the next `ps dedup run`
  (already scheduled hourly — see `etl/orchestrator.py`), not synchronously
  with this command. That's a deliberate choice, not an oversight: D-024's
  reevaluation is piggybacked on `engine.run()`'s full O(n^2) pairwise scan
  (there is no lightweight "just the pending rows" code path — see that
  module's docstring on the ~13.3us/pair cost), so triggering it here would
  make a revert command silently pay for a full production dedup pass as a
  side effect. Verified this actually happens (not just assumed) via
  `etl.tests.test_dedup_engine`'s
  `TestMunicipalityFuzzyVeto.test_existing_pending_fuzzy_suggestion_is_demoted_to_rejected`
  and the equivalent test in D-117's own PR (#567) — both construct a
  `pending` `fuzzy` suggestion, call `engine.run()`, and assert it lands at
  `status='rejected'` with `reevaluated_from` set.

**Degrades cleanly when a rule's PR hasn't merged yet** — this module
does NOT gate behind any of them merging first. `reference_codes_conflict`
(D-116) and `structured_fields_conflict` (D-117) are imported defensively
(`_reference_codes_conflict_fn` / `_structured_fields_conflict_fn` below);
when a rule's module/function doesn't exist yet, the corresponding section
reports "rule not present in this build" and contributes zero to every
count, rather than raising ImportError. D-116 (#565) has since merged, so
that arm is live; D-117 (#567) is still open as of this writing, so its
arm still degrades to unavailable in practice, not just in a test — this
was the deliberate choice over gating `ps dedup retroactive` behind both
merging first: D-118's own municipality veto ships and is independently
useful the moment THIS PR lands, and re-running `ps dedup retroactive`
picks up each rule automatically the moment its PR merges, with no code
change here, regardless of merge order.

**Dry-run is the default everywhere** — `run_retroactive_pass(conn)` with
no `apply` argument, and the CLI's `ps dedup retroactive` with no flag,
report what WOULD change and write nothing. `apply=True` /
`--apply` is required to actually call `engine.revert`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from etl.dedup import engine
from etl.dedup.signals.municipality import municipality_conflict
from etl.dedup.types import ListingRecord


def _reference_codes_conflict_fn():
    """D-116's veto predicate, or None if PR #565 hasn't merged yet."""
    try:
        from etl.dedup.signals.reference_code import reference_codes_conflict
    except ImportError:
        return None
    return reference_codes_conflict


def _structured_fields_conflict_fn():
    """D-117's veto predicate, or None if PR #567 hasn't merged yet."""
    try:
        from etl.dedup.signals.structured_fields import structured_fields_conflict
    except ImportError:
        return None
    return structured_fields_conflict


def _fetch_listing_records_by_id(conn, listing_ids) -> dict[int, ListingRecord]:
    """Fetch a specific set of listings in `engine.fetch_listing_records`'s
    shape, keyed by `listing_id`. A narrower, `WHERE l.id = ANY(...)` sibling
    of that function — used here instead of it because this module only
    ever needs a handful of specific listings (the two sides of one
    recorded merge, or one pending suggestion's pair), never the whole
    table."""
    ids = list({int(i) for i in listing_ids})
    if not ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT l.id, l.property_id, l.source, l.external_id, l.listing_kind,
                   l.description, l.photo_urls,
                   p.cadastral_ref, p.address, p.lat, p.lon, p.m2_built,
                   l.current_price, l.contact_raw, l.reference_code, p.floor,
                   p.city
              FROM listing l
              JOIN property p ON p.id = l.property_id
             WHERE l.id = ANY(%s)
            """,
            (ids,),
        )
        rows = cur.fetchall()
    return {
        row[0]: ListingRecord(
            listing_id=row[0],
            property_id=row[1],
            source=row[2],
            external_id=row[3],
            listing_kind=row[4],
            description=row[5],
            photo_urls=tuple(row[6] or ()),
            cadastral_ref=row[7],
            address=row[8],
            lat=row[9],
            lon=row[10],
            m2_built=row[11],
            current_price=row[12],
            contact_raw=row[13],
            reference_code=row[14],
            floor=row[15],
            city=row[16],
        )
        for row in rows
    }


@dataclass(frozen=True)
class ReferenceCodeRevertCandidate:
    """One `property_merge_log` row D-116 would now veto — the exact pair
    of listings that conflict, for the operator to eyeball before `--apply`
    reverts it."""

    merge_log_id: int
    property_id: int  # surviving property at the time of this merge event
    losing_property_id: int
    a_listing_id: int
    a_reference_code: str | None
    b_listing_id: int
    b_reference_code: str | None


def find_reference_code_veto_merges(conn) -> list[ReferenceCodeRevertCandidate]:
    """D-116 (issue #564/#565): every non-reverted `property_merge_log` row
    where the listing(s) that row moved onto the surviving property
    (`merged_listing_ids`) conflict, per `reference_codes_conflict`, with
    at least one listing that was already on the surviving property before
    this specific merge event (i.e. currently on `property_id`, minus the
    ones this row itself moved) — restricted to CROSS-SOURCE pairs only.

    That source-inequality restriction is not optional decoration: issue
    #197 means `engine._run()` never hands `evaluate_pair` a same-source
    pair at all (skipped before evaluation, at pair-generation time, not
    filtered from the result afterward). A same-source pair could
    therefore never have been checked against `reference_codes_conflict`
    when the historical merge was made, so this function must not flag
    one either — an earlier version of this function compared every
    listing on the property against every listing this merge moved in,
    regardless of source, which is a DIFFERENT, larger population than
    what `evaluate_pair` can ever reach and produced a wrong, inflated
    blast-radius number (an early draft misread this as "7 currently-
    merged properties", all same-source pairs that were never actually
    reachable). See `etl.dedup.signals.reference_code`'s own module
    docstring, which independently documents current reach as measured
    at ZERO against the live demo DB, for the same reason plus one more:
    only `fotocasa`/`milanuncios` populate `contact_raw` at all today, and
    `milanuncios` captures no `reference_code`.

    Returns `[]`, not an error, when D-116 hasn't merged yet
    (`_reference_codes_conflict_fn() is None`) — see this module's
    docstring on degrading cleanly.
    """
    conflict_fn = _reference_codes_conflict_fn()
    if conflict_fn is None:
        return []

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, property_id, losing_property_id, merged_listing_ids
              FROM property_merge_log
             WHERE reverted_at IS NULL AND losing_property_id IS NOT NULL
            """
        )
        merge_rows = cur.fetchall()

    candidates: list[ReferenceCodeRevertCandidate] = []
    for merge_log_id, property_id, losing_property_id, merged_listing_ids in merge_rows:
        moved_ids = list(merged_listing_ids or ())
        if not moved_ids:
            continue
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM listing WHERE property_id = %s AND operation = 'sale'",
                (property_id,),
            )
            current_ids = [row[0] for row in cur.fetchall()]
        other_side_ids = [i for i in current_ids if i not in set(moved_ids)]
        if not other_side_ids:
            # Nothing pre-existing to conflict against (e.g. every current
            # listing on this property traces back to this same merge
            # event) — nothing to check.
            continue

        moved_records = _fetch_listing_records_by_id(conn, moved_ids)
        other_records = _fetch_listing_records_by_id(conn, other_side_ids)

        flagged = False
        for a in other_records.values():
            for b in moved_records.values():
                # Issue #197: engine._run() never hands evaluate_pair a
                # same-source pair at all (skipped before evaluation, not
                # filtered out after). A same-source pair here could never
                # have been checked against reference_codes_conflict in
                # the first place, so it must not be flagged either —
                # this is exactly the mistake an earlier draft of this
                # function made, replaying a raw listing comparison
                # instead of the engine's own reachability rule (source
                # inequality, on top of the property_id inequality this
                # loop already gets for free by construction). See
                # etl.dedup.signals.reference_code's own docstring on why
                # that distinction matters for this exact veto.
                if a.source == b.source:
                    continue
                if conflict_fn(a, b):
                    candidates.append(
                        ReferenceCodeRevertCandidate(
                            merge_log_id=merge_log_id,
                            property_id=property_id,
                            losing_property_id=losing_property_id,
                            a_listing_id=a.listing_id,
                            a_reference_code=a.reference_code,
                            b_listing_id=b.listing_id,
                            b_reference_code=b.reference_code,
                        )
                    )
                    flagged = True
                    break
            if flagged:
                break

    return candidates


@dataclass(frozen=True)
class PendingFuzzyDemotionCounts:
    """Dry-run counts for the pending `fuzzy` suggested_merge backlog: how
    many of TODAY's pending rows carry a conflict D-117/D-118 would now
    reject. These are diagnostic counts, not a second demotion mechanism —
    see this module's docstring for why the actual demotion happens on the
    next `ps dedup run`, not here."""

    total_pending_fuzzy: int
    structured_fields_conflicts: int  # D-117
    municipality_conflicts: int  # D-118 (this issue)
    either: int  # union: at least one of the two rules fires
    structured_fields_rule_available: bool


def count_pending_fuzzy_demotions(conn) -> PendingFuzzyDemotionCounts:
    """Of every currently-`pending`, `match_basis='fuzzy'` suggestion, how
    many carry a D-117 (`structured_fields_conflict`) and/or D-118
    (`municipality_conflict`) conflict between their two listings.

    D-117's predicate degrades to "never fires" (0 contribution,
    `structured_fields_rule_available=False`) when PR #567 hasn't merged
    yet — see this module's docstring. D-118 is always available; it ships
    in this same PR.
    """
    structured_fn = _structured_fields_conflict_fn()

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT listing_id_a, listing_id_b
              FROM suggested_merge
             WHERE status = 'pending' AND match_basis = 'fuzzy'
            """
        )
        pairs = cur.fetchall()

    total = len(pairs)
    all_ids = {lid for pair in pairs for lid in pair}
    records = _fetch_listing_records_by_id(conn, all_ids)

    structured_count = 0
    municipality_count = 0
    either_count = 0
    for listing_id_a, listing_id_b in pairs:
        a = records.get(listing_id_a)
        b = records.get(listing_id_b)
        if a is None or b is None:
            # A listing behind this suggestion no longer exists as
            # recorded (moved/merged away since the suggestion was filed)
            # — nothing to evaluate; the normal re-evaluation path handles
            # this case on its own next run.
            continue
        struct_hit = structured_fn(a, b) if structured_fn is not None else False
        muni_hit = municipality_conflict(a, b)
        if struct_hit:
            structured_count += 1
        if muni_hit:
            municipality_count += 1
        if struct_hit or muni_hit:
            either_count += 1

    return PendingFuzzyDemotionCounts(
        total_pending_fuzzy=total,
        structured_fields_conflicts=structured_count,
        municipality_conflicts=municipality_count,
        either=either_count,
        structured_fields_rule_available=structured_fn is not None,
    )


@dataclass(frozen=True)
class RetroactiveReport:
    """Everything `ps dedup retroactive` prints, and the ONLY thing
    `run_retroactive_pass` returns — dry-run or applied, the shape is
    identical, so a caller can't tell the two apart except via `applied`
    and whether `reverted_merge_log_ids` is populated."""

    applied: bool
    reference_code_rule_available: bool
    reference_code_candidates: tuple[ReferenceCodeRevertCandidate, ...] = field(
        default_factory=tuple
    )
    reverted_merge_log_ids: tuple[int, ...] = field(default_factory=tuple)
    pending_demotions: PendingFuzzyDemotionCounts | None = None


def run_retroactive_pass(conn, apply: bool = False) -> RetroactiveReport:
    """The one entry point `ps dedup retroactive` calls.

    Dry-run (`apply=False`, the default) computes and returns every count
    below, writing nothing. `apply=True` additionally calls
    `etl.dedup.engine.revert` for every D-116 candidate found — each
    revert is its own committed transaction (see `engine.revert`), so a
    failure partway through leaves every already-reverted row reverted and
    every not-yet-reached row untouched, not a half-applied mess.

    D-117/D-118 never write anything here regardless of `apply` — see this
    module's docstring for why (D-024's existing reevaluation, exercised
    by the next `ps dedup run`, owns that).
    """
    candidates = find_reference_code_veto_merges(conn)
    pending_demotions = count_pending_fuzzy_demotions(conn)

    reverted: list[int] = []
    if apply:
        for candidate in candidates:
            engine.revert(conn, candidate.merge_log_id)
            reverted.append(candidate.merge_log_id)

    return RetroactiveReport(
        applied=apply,
        reference_code_rule_available=_reference_codes_conflict_fn() is not None,
        reference_code_candidates=tuple(candidates),
        reverted_merge_log_ids=tuple(reverted),
        pending_demotions=pending_demotions,
    )
