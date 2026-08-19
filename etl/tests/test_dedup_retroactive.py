"""Tests for etl.dedup.retroactive (issue #568).

Integration tests against a real PostgreSQL instance, same pattern as
test_dedup_engine.py — reuses its `dedup_db` fixture and
`_insert_pair`/`_insert_property`/`_insert_listing` helpers (same pattern
test_dedup_actions.py already uses) rather than duplicating the
property/listing insert plumbing.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

import etl.dedup.signals.reference_code as reference_code_module
from etl.dedup import engine, retroactive
from etl.tests.test_dedup_engine import (
    _insert_listing,
    _insert_pair,
    _insert_property,
    dedup_db,
)

__all__ = ["dedup_db"]  # re-exported fixture, keep the linter quiet

_LAT = Decimal("40.416775")
_LON = Decimal("-3.703790")


class TestReferenceCodeRuleDegradesCleanly:
    """D-116 (PR #565) has merged — `reference_code.reference_codes_conflict`
    is live in this codebase today (pinned by
    `test_conflict_fn_is_available_today` below, so this file can't
    silently drift back to testing an imaginary world). The degrade path
    itself is still worth pinning, though: a future build could drop the
    signal (a revert, a rename), and `ps dedup retroactive` must still
    degrade to '0 candidates', never raise. Simulated EXPLICITLY via
    `monkeypatch.delattr` on the real module — never by relying on
    ambient absence, which is exactly the mistake that let these tests
    pass for the wrong reason before #565 merged and then fail for real
    once it did."""

    def test_conflict_fn_is_available_today(self):
        assert retroactive._reference_codes_conflict_fn() is not None

    def test_conflict_fn_is_unavailable_when_reference_code_lacks_the_symbol(
        self, monkeypatch
    ):
        monkeypatch.delattr(reference_code_module, "reference_codes_conflict")
        assert retroactive._reference_codes_conflict_fn() is None

    def test_find_returns_empty_list_not_an_error_when_rule_absent(
        self, dedup_db, monkeypatch
    ):
        monkeypatch.delattr(reference_code_module, "reference_codes_conflict")
        assert retroactive.find_reference_code_veto_merges(dedup_db) == []

    def test_dry_run_report_says_rule_unavailable_when_rule_absent(
        self, dedup_db, monkeypatch
    ):
        monkeypatch.delattr(reference_code_module, "reference_codes_conflict")
        report = retroactive.run_retroactive_pass(dedup_db)
        assert report.applied is False
        assert report.reference_code_rule_available is False
        assert report.reference_code_candidates == ()
        assert report.reverted_merge_log_ids == ()


class TestReferenceCodeVetoRetroactiveRevert:
    """D-116 is live now (PR #565, merged) — wired directly into
    `evaluate_pair` ahead of every signal (cadastral aside). That means
    `engine.run()` can no longer be used to CONSTRUCT a same-agency/
    differing-code merge fixture: the shipped veto refuses to create that
    state today, by design. These tests build the historical, pre-existing
    merge directly via SQL instead — the same shape real pre-#565 data
    looks like: a merge some OTHER, stronger signal made (here,
    `address_coords`) back before anything checked reference codes.

    Cross-source by construction (fotocasa vs idealista) — matching what
    `evaluate_pair`/`engine._run()` could ever actually reach (issue #197
    skips same-source pairs before evaluation, not after), which is also
    what `find_reference_code_veto_merges` itself must now respect (see
    `test_same_source_historical_merge_is_never_flagged` below — the
    regression test for the exact bug an earlier version of that function
    had: comparing every listing on the property against every moved-in
    listing regardless of source, which counted same-source pairs that
    could never have been evaluated in the first place)."""

    def _insert_historical_conflicting_merge(self, dedup_db):
        """Returns (listing_a, survivor_property_id, listing_b,
        losing_property_id, merge_log_id)."""
        prop_a = _insert_property(dedup_db, address="Calle Mayor 5")
        prop_b = _insert_property(dedup_db, address="Calle Mayor 5")
        listing_a = _insert_listing(
            dedup_db,
            prop_a,
            "fotocasa",
            "retro-refcode-a",
            contact_raw="Agency X",
            reference_code="AAA-111",
            current_price=Decimal(250000),
        )
        listing_b = _insert_listing(
            dedup_db,
            prop_b,
            "idealista",
            "retro-refcode-b",
            contact_raw="Agency X",
            reference_code="BBB-222",
            current_price=Decimal(250000),
        )
        dedup_db.commit()

        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET property_id = %s WHERE id = %s",
                (prop_a, listing_b),
            )
            cur.execute(
                """
                INSERT INTO property_merge_log
                    (property_id, merged_listing_ids, match_basis,
                     confidence, losing_property_id, detail)
                VALUES (%s, %s, 'address_coords', 0.950, %s, %s)
                RETURNING id
                """,
                (prop_a, [listing_b], prop_b, json.dumps({})),
            )
            merge_log_id = cur.fetchone()[0]
        dedup_db.commit()
        return listing_a, prop_a, listing_b, prop_b, merge_log_id

    def test_finds_exactly_the_conflicting_merge(self, dedup_db):
        (
            _listing_a,
            survivor_id,
            _listing_b,
            losing_id,
            merge_log_id,
        ) = self._insert_historical_conflicting_merge(dedup_db)

        candidates = retroactive.find_reference_code_veto_merges(dedup_db)

        assert len(candidates) == 1
        candidate = candidates[0]
        assert candidate.merge_log_id == merge_log_id
        assert candidate.property_id == survivor_id
        assert candidate.losing_property_id == losing_id
        assert {candidate.a_reference_code, candidate.b_reference_code} == {
            "AAA-111",
            "BBB-222",
        }

    def test_same_source_historical_merge_is_never_flagged(self, dedup_db):
        """Issue #197: a same-source pair could never reach `evaluate_pair`
        at all, so a historical merge shaped exactly like the conflicting
        one above — but both sides from the SAME source — must not be
        flagged either. This is the regression test for the bug the
        coordinator caught in review."""
        prop_a = _insert_property(dedup_db, address="Calle Mayor 5")
        prop_b = _insert_property(dedup_db, address="Calle Mayor 5")
        _insert_listing(
            dedup_db,
            prop_a,
            "fotocasa",
            "retro-refcode-samesource-a",
            contact_raw="Agency X",
            reference_code="AAA-111",
        )
        listing_b = _insert_listing(
            dedup_db,
            prop_b,
            "fotocasa",
            "retro-refcode-samesource-b",
            contact_raw="Agency X",
            reference_code="BBB-222",
        )
        dedup_db.commit()
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET property_id = %s WHERE id = %s",
                (prop_a, listing_b),
            )
            cur.execute(
                """
                INSERT INTO property_merge_log
                    (property_id, merged_listing_ids, match_basis,
                     confidence, losing_property_id, detail)
                VALUES (%s, %s, 'address_coords', 0.950, %s, %s)
                """,
                (prop_a, [listing_b], prop_b, json.dumps({})),
            )
        dedup_db.commit()

        assert retroactive.find_reference_code_veto_merges(dedup_db) == []

    def test_dry_run_writes_nothing(self, dedup_db):
        (
            listing_a,
            survivor_id,
            listing_b,
            _losing_id,
            merge_log_id,
        ) = self._insert_historical_conflicting_merge(dedup_db)

        report = retroactive.run_retroactive_pass(dedup_db, apply=False)

        assert report.applied is False
        assert len(report.reference_code_candidates) == 1
        assert report.reverted_merge_log_ids == ()
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT reverted_at FROM property_merge_log WHERE id = %s",
                (merge_log_id,),
            )
            assert cur.fetchone()[0] is None
            cur.execute(
                "SELECT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            # Both listings still share the survivor property_id — nothing
            # was reverted.
            assert {row[0] for row in cur.fetchall()} == {survivor_id}

    def test_apply_reverts_exactly_that_merge_deletes_nothing(self, dedup_db):
        (
            listing_a,
            survivor_id,
            listing_b,
            losing_id,
            merge_log_id,
        ) = self._insert_historical_conflicting_merge(dedup_db)

        report = retroactive.run_retroactive_pass(dedup_db, apply=True)

        assert report.applied is True
        assert report.reverted_merge_log_ids == (merge_log_id,)

        with dedup_db.cursor() as cur:
            # Reversible marker set, row NOT deleted.
            cur.execute(
                "SELECT reverted_at FROM property_merge_log WHERE id = %s",
                (merge_log_id,),
            )
            assert cur.fetchone()[0] is not None

            # Both original property rows still physically exist.
            cur.execute(
                "SELECT count(*) FROM property WHERE id IN (%s, %s)",
                (survivor_id, losing_id),
            )
            assert cur.fetchone()[0] == 2

            # Listings point back at their pre-merge properties.
            cur.execute("SELECT property_id FROM listing WHERE id = %s", (listing_a,))
            prop_a_now = cur.fetchone()[0]
            cur.execute("SELECT property_id FROM listing WHERE id = %s", (listing_b,))
            prop_b_now = cur.fetchone()[0]
            assert {prop_a_now, prop_b_now} == {survivor_id, losing_id}

    def test_apply_uses_the_same_revert_primitive_as_ps_dedup_revert(self, dedup_db):
        """`run_retroactive_pass(apply=True)` performs its revert via
        `engine.revert` — the exact function `ps dedup revert <id>` calls
        (etl/dedup/cli.py's `_cmd_revert`) — not a bespoke code path. Pinned
        here by proving `engine.revert`'s own idempotency guard now fires:
        calling it again on the same id is safely rejected as
        already-reverted, rather than silently double-applying."""
        (
            _listing_a,
            _survivor_id,
            _listing_b,
            _losing_id,
            merge_log_id,
        ) = self._insert_historical_conflicting_merge(dedup_db)

        retroactive.run_retroactive_pass(dedup_db, apply=True)
        with pytest.raises(ValueError, match="already reverted"):
            engine.revert(dedup_db, merge_log_id)


class TestCountPendingFuzzyDemotions:
    def _insert_pending_fuzzy_suggestion(self, dedup_db, **kwargs):
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            dedup_db, "fotocasa", "idealista", kwargs.pop("ext_prefix"), **kwargs
        )
        lo, hi = sorted((listing_a, listing_b))
        with dedup_db.cursor() as cur:
            cur.execute(
                """
                INSERT INTO suggested_merge
                    (listing_id_a, listing_id_b, match_basis, confidence, status, detail)
                VALUES (%s, %s, 'fuzzy', 0.550, 'pending', %s)
                """,
                (lo, hi, json.dumps({})),
            )
        dedup_db.commit()
        return listing_a, listing_b

    def test_counts_municipality_conflicts(self, dedup_db):
        self._insert_pending_fuzzy_suggestion(
            dedup_db,
            ext_prefix="retro-pending-municipality-conflict",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            city_a="Málaga",
            city_b="Sevilla",
        )
        self._insert_pending_fuzzy_suggestion(
            dedup_db,
            ext_prefix="retro-pending-no-conflict",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            city_a="Sevilla Capital",
            city_b="Sevilla",
        )

        counts = retroactive.count_pending_fuzzy_demotions(dedup_db)

        assert counts.total_pending_fuzzy == 2
        assert counts.municipality_conflicts == 1
        assert counts.either == 1

    def test_structured_fields_rule_unavailable_is_simulated_explicitly(
        self, dedup_db, monkeypatch
    ):
        """D-117 (PR #567) is still open as of this writing — real ambient
        absence today. Simulated explicitly anyway (monkeypatching the
        exact seam `count_pending_fuzzy_demotions` reads,
        `retroactive._structured_fields_conflict_fn`), not left to depend
        on that ambient fact staying true: the same 'assumption expired
        the moment the PR merged' lesson TestReferenceCodeRuleDegradesCleanly
        pins for D-116 applies here too, pre-emptively."""
        monkeypatch.setattr(retroactive, "_structured_fields_conflict_fn", lambda: None)
        self._insert_pending_fuzzy_suggestion(
            dedup_db,
            ext_prefix="retro-pending-structured-unavailable",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
        )

        counts = retroactive.count_pending_fuzzy_demotions(dedup_db)

        assert counts.structured_fields_rule_available is False
        assert counts.structured_fields_conflicts == 0

    def test_structured_fields_conflicts_counted_once_rule_available(
        self, dedup_db, monkeypatch
    ):
        def fake_structured_conflict(a, b) -> bool:
            return a.city == "TYPE-CONFLICT-A" and b.city == "TYPE-CONFLICT-B"

        monkeypatch.setattr(
            retroactive,
            "_structured_fields_conflict_fn",
            lambda: fake_structured_conflict,
        )
        self._insert_pending_fuzzy_suggestion(
            dedup_db,
            ext_prefix="retro-pending-structured-conflict",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            city_a="TYPE-CONFLICT-A",
            city_b="TYPE-CONFLICT-B",
        )

        counts = retroactive.count_pending_fuzzy_demotions(dedup_db)

        assert counts.structured_fields_rule_available is True
        assert counts.structured_fields_conflicts == 1
        assert counts.either == 1

    def test_structured_fields_conflicts_counted_with_the_real_shipped_predicate(
        self, dedup_db
    ):
        """Regression test for a real bug: `_fetch_listing_records_by_id`
        originally only selected `p.city`, not `p.property_type`/`p.rooms`
        — so every ListingRecord this module built had `property_type`/
        `rooms` permanently `None`, and the REAL (now-merged, D-117)
        `structured_fields_conflict` is permissive-on-absence, so it
        silently returned False for every pair regardless of the actual
        data. `test_structured_fields_conflicts_counted_once_rule_available`
        above never caught this because it monkeypatches the predicate
        entirely (checking `city`, not `property_type`/`rooms`) — this
        test uses the REAL shipped predicate, unmocked, specifically to
        exercise the query/mapping bug that test cannot see."""
        self._insert_pending_fuzzy_suggestion(
            dedup_db,
            ext_prefix="retro-pending-real-structured-conflict",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            rooms_a=2,
            rooms_b=5,
        )

        counts = retroactive.count_pending_fuzzy_demotions(dedup_db)

        assert counts.structured_fields_rule_available is True
        assert counts.structured_fields_conflicts == 1
        assert counts.either == 1

    def test_zero_pending_fuzzy_suggestions_reports_zero(self, dedup_db):
        counts = retroactive.count_pending_fuzzy_demotions(dedup_db)
        assert counts.total_pending_fuzzy == 0
        assert counts.municipality_conflicts == 0
        assert counts.either == 0
