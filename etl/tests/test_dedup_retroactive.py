"""Tests for etl.dedup.retroactive (issue #568).

Integration tests against a real PostgreSQL instance, same pattern as
test_dedup_engine.py — reuses its `dedup_db` fixture and `_insert_pair`
helper (same pattern test_dedup_actions.py already uses) rather than
duplicating the property/listing insert plumbing.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from etl.dedup import engine, retroactive
from etl.tests.test_dedup_engine import _insert_pair, dedup_db

__all__ = ["dedup_db"]  # re-exported fixture, keep the linter quiet

_LAT = Decimal("40.416775")
_LON = Decimal("-3.703790")


class TestReferenceCodeRuleDegradesCleanly:
    """D-116 (PR #565) hasn't merged into this codebase yet —
    `reference_code.reference_codes_conflict` genuinely doesn't exist.
    This must degrade to '0 candidates', never raise."""

    def test_conflict_fn_is_unavailable_in_this_build(self):
        assert retroactive._reference_codes_conflict_fn() is None

    def test_find_returns_empty_list_not_an_error(self, dedup_db):
        assert retroactive.find_reference_code_veto_merges(dedup_db) == []

    def test_dry_run_report_says_rule_unavailable(self, dedup_db):
        report = retroactive.run_retroactive_pass(dedup_db)
        assert report.applied is False
        assert report.reference_code_rule_available is False
        assert report.reference_code_candidates == ()
        assert report.reverted_merge_log_ids == ()


class TestReferenceCodeVetoRetroactiveRevert:
    """Simulates D-116 landing (monkeypatching the conflict predicate, the
    same injection point `find_reference_code_veto_merges` uses) to prove
    the revert machinery itself is correct: it finds exactly the
    conflicting merge, reverts it losslessly, and dry-run leaves it
    untouched."""

    @staticmethod
    def _fake_conflict(a, b) -> bool:
        return bool(
            a.contact_raw
            and a.contact_raw == b.contact_raw
            and a.reference_code
            and b.reference_code
            and a.reference_code != b.reference_code
        )

    def _make_merged_pair_with_conflicting_codes(self, dedup_db):
        """Two listings that auto-merge today via address_coords (same
        coordinates/size — no reference-code veto exists yet to stop it)
        but carry different reference codes from the same agency —
        exactly the D-116 shape, already merged, the way real pre-#565
        data looks."""
        listing_a, prop_a, listing_b, prop_b = _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "retro-refcode-conflict",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=_LAT,
            lon_a=_LON,
            lat_b=_LAT,
            lon_b=_LON,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            contact_raw_a="Agency X",
            contact_raw_b="Agency X",
            reference_code_a="AAA-111",
            reference_code_b="BBB-222",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT id, property_id, losing_property_id, reverted_at "
                "FROM property_merge_log ORDER BY created_at DESC LIMIT 1"
            )
            merge_log_id, survivor_id, losing_id, reverted_at = cur.fetchone()
        assert reverted_at is None
        return (
            listing_a,
            prop_a,
            listing_b,
            prop_b,
            merge_log_id,
            survivor_id,
            losing_id,
        )

    def test_finds_exactly_the_conflicting_merge(self, dedup_db, monkeypatch):
        monkeypatch.setattr(
            retroactive, "_reference_codes_conflict_fn", lambda: self._fake_conflict
        )
        (
            _listing_a,
            _prop_a,
            _listing_b,
            _prop_b,
            merge_log_id,
            survivor_id,
            losing_id,
        ) = self._make_merged_pair_with_conflicting_codes(dedup_db)

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

    def test_dry_run_writes_nothing(self, dedup_db, monkeypatch):
        monkeypatch.setattr(
            retroactive, "_reference_codes_conflict_fn", lambda: self._fake_conflict
        )
        (
            listing_a,
            _prop_a,
            listing_b,
            _prop_b,
            merge_log_id,
            survivor_id,
            _losing_id,
        ) = self._make_merged_pair_with_conflicting_codes(dedup_db)

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
                (
                    listing_a,
                    listing_b,
                ),
            )
            # Both listings still share the survivor property_id — nothing
            # was reverted.
            assert {row[0] for row in cur.fetchall()} == {survivor_id}

    def test_apply_reverts_exactly_that_merge_deletes_nothing(
        self, dedup_db, monkeypatch
    ):
        monkeypatch.setattr(
            retroactive, "_reference_codes_conflict_fn", lambda: self._fake_conflict
        )
        (
            listing_a,
            _prop_a,
            listing_b,
            _prop_b,
            merge_log_id,
            survivor_id,
            losing_id,
        ) = self._make_merged_pair_with_conflicting_codes(dedup_db)

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

    def test_apply_uses_the_same_revert_primitive_as_ps_dedup_revert(
        self, dedup_db, monkeypatch
    ):
        """`run_retroactive_pass(apply=True)` performs its revert via
        `engine.revert` — the exact function `ps dedup revert <id>` calls
        (etl/dedup/cli.py's `_cmd_revert`) — not a bespoke code path. Pinned
        here by proving `engine.revert`'s own idempotency guard now fires:
        calling it again on the same id is safely rejected as
        already-reverted, rather than silently double-applying."""
        monkeypatch.setattr(
            retroactive, "_reference_codes_conflict_fn", lambda: self._fake_conflict
        )
        (
            _listing_a,
            _prop_a,
            _listing_b,
            _prop_b,
            merge_log_id,
            _survivor_id,
            _losing_id,
        ) = self._make_merged_pair_with_conflicting_codes(dedup_db)

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

    def test_counts_municipality_conflicts_and_leaves_structured_fields_unavailable(
        self, dedup_db
    ):
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

    def test_zero_pending_fuzzy_suggestions_reports_zero(self, dedup_db):
        counts = retroactive.count_pending_fuzzy_demotions(dedup_db)
        assert counts.total_pending_fuzzy == 0
        assert counts.municipality_conflicts == 0
        assert counts.either == 0
