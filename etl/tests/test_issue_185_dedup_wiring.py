"""Regression coverage for issue #185: the dedup engine never ran.

`etl/dedup/` (engine, six signals, reconciliation, revert) was complete but
reachable only via `python -m etl.dedup.cli run` / `ps dedup run` — nothing
in `run_all_connectors`, the scheduler, or container startup ever invoked
it. Confirmed on the live database: `property_merge_log` and
`suggested_merge` were both empty across every run since the connectors
went live.

Two things are tested here, in the real-PostgreSQL style this repo already
uses for orchestrator/dedup tests (mocking the database would test nothing
meaningful — the whole point is what gets persisted and how a run is
recorded):

1. `TestDedupWiring` — `run_all_connectors` now calls dedup automatically,
   records a `dedup_runs` row, and stays resilient to a dedup failure.
2. `TestOwnerReportedPair` — the exact pair from the issue (property 62:
   milanuncios/534062143 vs property 146: fotocasa/185398766), seeded with
   the real field values reported, run through the now-wired pipeline.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl import orchestrator
from etl.dedup import engine
from etl.dedup.cli import _cmd_run as dedup_cli_run
from etl.tests.fixtures.dummy_connector import DummyConnector

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"
_TEST_PROFILE_NAME = "issue-185-dedup-wiring-fixture-profile"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _apply_test_profile(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM search_profile WHERE name = %s AND archived_at IS NULL",
            (_TEST_PROFILE_NAME,),
        )
        if cur.fetchone() is None:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                (
                    _TEST_PROFILE_NAME,
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [37.3891, -5.9845], "radius_km": 10}}'
                    ),
                ),
            )
    conn.commit()


def _cleanup_dedup_state(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM suggested_merge")
        cur.execute("DELETE FROM property_merge_log")
        cur.execute("DELETE FROM dedup_runs")
        # This file's own fixture profile must not outlive each test: unlike
        # test_orchestrator.py's _TEST_PROFILE_NAME (a single, intentionally
        # session-permanent row several of ITS tests assert an exact active-
        # profile count against), a second lingering active profile here
        # would silently add an extra scope to every other orchestrator test
        # in the same pytest session/database — exactly the kind of
        # cross-file pollution issue #159 was about. Delete-then-recreate
        # per test instead of reusing a permanent row.
        cur.execute("DELETE FROM search_profile WHERE name = %s", (_TEST_PROFILE_NAME,))
    conn.commit()


def _cleanup_connector_state(conn, source: str, run_id: int | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM connector_run_results WHERE connector_name = %s", (source,)
        )
        if run_id is not None:
            cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
        cur.execute("SELECT property_id FROM listing WHERE source = %s", (source,))
        property_ids = [row[0] for row in cur.fetchall()]
        cur.execute("DELETE FROM listing WHERE source = %s", (source,))
        if property_ids:
            cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
    conn.commit()


def _insert_property(conn, **overrides) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO property (cadastral_ref, address, lat, lon, m2_built, floor)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                overrides.get("cadastral_ref"),
                overrides.get("address"),
                overrides.get("lat"),
                overrides.get("lon"),
                overrides.get("m2_built"),
                overrides.get("floor"),
            ),
        )
        return cur.fetchone()[0]


def _insert_listing(
    conn, property_id: int, source: str, external_id: str, **overrides
) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO listing
                (property_id, source, external_id, listing_kind, description,
                 current_price, contact_raw, reference_code, photo_urls)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                property_id,
                source,
                external_id,
                overrides.get("listing_kind"),
                overrides.get("description"),
                overrides.get("current_price"),
                overrides.get("contact_raw"),
                overrides.get("reference_code"),
                overrides.get("photo_urls", []),
            ),
        )
        return cur.fetchone()[0]


@pytest.fixture
def dedup_wiring_db(pg_conn):
    _apply_schema(pg_conn)
    # Cleanup runs AFTER schema application (needs the tables to exist) but
    # BEFORE this file's own fixture profile is (re-)created below, and
    # again on teardown — see _cleanup_dedup_state's docstring on why this
    # profile must not survive past a single test.
    _cleanup_dedup_state(pg_conn)
    _apply_test_profile(pg_conn)
    yield pg_conn
    _cleanup_dedup_state(pg_conn)


class TestDedupWiring:
    """`run_all_connectors` must invoke dedup and record a `dedup_runs` row."""

    def test_run_all_connectors_records_a_dedup_run_linked_to_the_connector_run(
        self, dedup_wiring_db
    ):
        conn = dedup_wiring_db
        connector = DummyConnector(name="test-185-wiring")
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(conn, trigger="test-185")

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT trigger, connector_run_id, status, pairs_compared, "
                    "merged, suggested, conflicts, finished_at IS NOT NULL "
                    "FROM dedup_runs WHERE connector_run_id = %s",
                    (run_id,),
                )
                row = cur.fetchone()
            assert row is not None, (
                "run_all_connectors did not record a dedup_runs row — this is "
                "issue #185's bug: the dedup engine never ran"
            )
            (
                trigger,
                connector_run_id,
                status,
                compared,
                merged,
                suggested,
                conflicts,
                finished,
            ) = row
            assert trigger == "test-185"
            assert connector_run_id == run_id
            assert status == "success"
            assert compared is not None
            assert merged is not None
            assert suggested is not None
            assert conflicts is not None
            assert finished is True
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup_connector_state(conn, connector.name, run_id)

    def test_dedup_runs_even_when_this_sweep_discovers_nothing_new(
        self, dedup_wiring_db
    ):
        """Not gated on new activity: a backlog of existing duplicates must
        get processed even on a run where the connector registry is empty
        (e.g. every connector disabled, or between real connector runs) —
        otherwise "ran and found nothing new to ingest" would still leave a
        pre-existing duplicate pair sitting unprocessed, indistinguishable
        from "dedup never ran" all over again.
        """
        conn = dedup_wiring_db
        prop_a = _insert_property(
            conn, cadastral_ref="1234567AB1234C0001XY", address="Calle Test 1"
        )
        prop_b = _insert_property(
            conn, cadastral_ref="1234567AB1234C0001XY", address="Calle Test 1 bis"
        )
        _insert_listing(conn, prop_a, "sourcex", "backlog-a")
        _insert_listing(conn, prop_b, "sourcey", "backlog-b")
        conn.commit()

        orchestrator.CONNECTORS[:] = []
        try:
            run_id = orchestrator.run_all_connectors(conn, trigger="test-185-empty")

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT merged FROM dedup_runs WHERE connector_run_id = %s",
                    (run_id,),
                )
                (merged,) = cur.fetchone()
            assert merged == 1, (
                "a pre-existing exact-cadastral-match pair should auto-merge "
                "on the very next run_all_connectors call, even with zero "
                "connectors registered this run"
            )

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM property_merge_log WHERE match_basis = 'cadastral'"
                )
                (count,) = cur.fetchone()
            assert count == 1
        finally:
            orchestrator.CONNECTORS.clear()
            with conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                cur.execute(
                    "DELETE FROM property_merge_log WHERE property_id IN (%s, %s) "
                    "OR losing_property_id IN (%s, %s)",
                    (prop_a, prop_b, prop_a, prop_b),
                )
                cur.execute(
                    "DELETE FROM listing WHERE source IN ('sourcex', 'sourcey')"
                )
                cur.execute(
                    "DELETE FROM property WHERE id IN (%s, %s)", (prop_a, prop_b)
                )
            conn.commit()

    def test_dedup_failure_does_not_fail_the_connector_run(
        self, dedup_wiring_db, monkeypatch
    ):
        """A bug in the dedup engine must not retroactively turn an
        already-committed, successful connector sweep into a failed run —
        same resilience posture as notify_materialize_all.
        """
        conn = dedup_wiring_db
        connector = DummyConnector(name="test-185-dedup-failure")
        orchestrator.CONNECTORS[:] = [connector]

        def _boom(_conn):
            raise RuntimeError("simulated dedup engine bug")

        monkeypatch.setattr(engine, "run", _boom)

        try:
            run_id = orchestrator.run_all_connectors(conn, trigger="test-185-failure")

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_runs WHERE id = %s", (run_id,)
                )
                (connector_run_status,) = cur.fetchone()
            assert connector_run_status == "success"

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status, error_msg FROM dedup_runs WHERE connector_run_id = %s",
                    (run_id,),
                )
                dedup_status, error_msg = cur.fetchone()
            assert dedup_status == "failed"
            assert "simulated dedup engine bug" in (error_msg or "")
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup_connector_state(conn, connector.name, run_id)

    def test_ps_dedup_run_cli_also_records_a_dedup_run(self, dedup_wiring_db):
        """`ps dedup run` (etl.dedup.cli) goes through the same
        orchestrator.run_dedup path as the automatic post-sweep call, so a
        manual invocation is equally observable (trigger='cli-manual', no
        connector_run_id).
        """
        conn = dedup_wiring_db
        exit_code = dedup_cli_run(conn)
        assert exit_code == 0

        with conn.cursor() as cur:
            cur.execute(
                "SELECT trigger, connector_run_id, status FROM dedup_runs "
                "ORDER BY id DESC LIMIT 1"
            )
            trigger, connector_run_id, status = cur.fetchone()
        assert trigger == "cli-manual"
        assert connector_run_id is None
        assert status == "success"


class TestOwnerReportedPair:
    """The exact pair from issue #185: two listings of the same 72m²
    third-floor Sevilla flat, ingested from milanuncios and fotocasa,
    which were never compared because nothing ever called the engine.

    Field values are copied verbatim from the issue (coordinates ~83m
    apart, addresses at different granularity — Milanuncios' city/province
    only vs. Fotocasa's neighbourhood/district/municipality, cadastral null
    on both, reference code only on the fotocasa side, no shared phone
    number in either description).
    """

    _MILANUNCIOS_ADDRESS = "Sevilla, Sevilla"
    _FOTOCASA_ADDRESS = "La Oliva, Sur, Sevilla Capital"
    _PRICE = Decimal("21850.00")
    _M2 = Decimal("72.00")
    _MILANUNCIOS_LAT = Decimal("37.357578")
    _MILANUNCIOS_LON = Decimal("-5.968120")
    _FOTOCASA_LAT = Decimal("37.357740")
    _FOTOCASA_LON = Decimal("-5.969037")

    def _seed_pair(self, conn) -> tuple[int, int, int, int]:
        prop_milanuncios = _insert_property(
            conn,
            address=self._MILANUNCIOS_ADDRESS,
            lat=self._MILANUNCIOS_LAT,
            lon=self._MILANUNCIOS_LON,
            m2_built=self._M2,
            floor="3º",
        )
        prop_fotocasa = _insert_property(
            conn,
            address=self._FOTOCASA_ADDRESS,
            lat=self._FOTOCASA_LAT,
            lon=self._FOTOCASA_LON,
            m2_built=self._M2,
            floor="3ª planta",
        )
        listing_milanuncios = _insert_listing(
            conn,
            prop_milanuncios,
            "milanuncios",
            "534062143",
            current_price=self._PRICE,
            description="Piso en venta, 72 m2, 3 dormitorios, muy luminoso.",
            photo_urls=[f"https://img.milanuncios.com/p{i}.jpg" for i in range(11)],
        )
        listing_fotocasa = _insert_listing(
            conn,
            prop_fotocasa,
            "fotocasa",
            "185398766",
            current_price=self._PRICE,
            description="Piso en La Oliva, 72 m2 construidos, 3ª planta.",
            reference_code="9206##9206_0168_PE00",
            photo_urls=[f"https://cdn.fotocasa.es/p{i}.jpg" for i in range(11)],
        )
        conn.commit()
        return prop_milanuncios, listing_milanuncios, prop_fotocasa, listing_fotocasa

    def test_pipeline_run_files_the_pair_as_a_fuzzy_suggestion_not_an_auto_merge(
        self, dedup_wiring_db
    ):
        """Investigation finding (see PR description): neither `cadastral`
        (null both sides), `address_coords` (83m > the 15m gate, AND the
        two addresses' normalized-text similarity is ~0.558 — well under
        the 0.80 bar regardless of distance), `phone` (no shared number),
        nor `reference_code` (only one side has one) clear an auto-merge
        bar. `fuzzy` does fire — same size, same price, and 0.558 address
        similarity clears its 0.55 floor by a hair — filing a suggestion,
        which is the correct, designed-for outcome for a pair this weakly
        corroborated.

        CORRECTION (dedup review-queue issue): this test's `photo_urls`
        (`https://img.milanuncios.com/pN.jpg` / `https://cdn.fotocasa.es/pN.jpg`)
        point at hosts that don't actually serve those images — every
        `fetch_hashes` call for both listings fails, so `photo_hash` never
        gets a chance to fire here, by construction of this fixture, not
        because it doesn't apply to this pair. A prior agent read this test
        and concluded "for the owner's real pair, only `fuzzy` fires" —
        that conclusion does NOT hold against the owner's actual live data:
        a real dedup run against real listings found `photo_hash` firing at
        confidence 0.800 (`match_ratio: 1.0`, all 11 photos matched) for
        this exact reported pair (see docs/decisions/ around the review-queue
        change and the PR description with the live `suggested_merge` row).
        This test is still correct and worth keeping (it pins the *other*
        four signals' priority-order behaviour + wiring), but do not use it
        as evidence about what fires against real, fetchable photos — it
        structurally cannot exercise `photo_hash` at all. See
        etl/tests/test_dedup_signals_photo_hash.py::TestNonImageUrlFiltering
        for photo_hash's own no-network unit tests, and the dedup engine
        module docstring for the general "network signals need network to
        prove anything" caveat.
        """
        conn = dedup_wiring_db
        prop_a, listing_a, prop_b, listing_b = self._seed_pair(conn)
        orchestrator.CONNECTORS[:] = []
        try:
            run_id = orchestrator.run_all_connectors(conn, trigger="test-185-pair")

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT match_basis, confidence, status FROM suggested_merge "
                    "WHERE listing_id_a = %s AND listing_id_b = %s",
                    tuple(sorted((listing_a, listing_b))),
                )
                row = cur.fetchone()
            assert row is not None, (
                "the reported pair produced no suggested_merge row at all — "
                "before the fix, nothing ever called the dedup engine, so "
                "this is exactly issue #185's bug"
            )
            match_basis, confidence, status = row
            assert match_basis == "fuzzy"
            assert status == "pending"
            assert Decimal("0.55") <= confidence <= Decimal("0.59")

            # Not auto-merged — this pair's evidence is real but weak
            # (see docstring); property_merge_log must stay empty until a
            # human confirms.
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM property_merge_log "
                    "WHERE property_id IN (%s, %s) OR losing_property_id IN (%s, %s)",
                    (prop_a, prop_b, prop_a, prop_b),
                )
                (merge_count,) = cur.fetchone()
            assert merge_count == 0
        finally:
            orchestrator.CONNECTORS.clear()
            with conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                cur.execute("DELETE FROM suggested_merge")
                cur.execute(
                    "DELETE FROM listing WHERE source IN ('milanuncios', 'fotocasa') "
                    "AND external_id IN ('534062143', '185398766')"
                )
                cur.execute(
                    "DELETE FROM property WHERE id = ANY(%s)", ([prop_a, prop_b],)
                )
            conn.commit()

    def test_confirming_the_suggestion_ends_with_one_property_in_property_merge_log(
        self, dedup_wiring_db
    ):
        """The literal acceptance criterion: properties 62/146's fixture
        equivalents end up on one `property` with both listings attached
        and the basis recorded in `property_merge_log`. Reached via the
        already-built human-review path (`ps dedup confirm` /
        engine.confirm_suggestion) — now actually reachable for the first
        time, because a normal pipeline run (below) is what files the
        suggestion in the first place.
        """
        conn = dedup_wiring_db
        prop_a, listing_a, prop_b, listing_b = self._seed_pair(conn)
        orchestrator.CONNECTORS[:] = []
        try:
            run_id = orchestrator.run_all_connectors(conn, trigger="test-185-confirm")

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM suggested_merge WHERE listing_id_a = %s AND listing_id_b = %s",
                    tuple(sorted((listing_a, listing_b))),
                )
                suggestion_id = cur.fetchone()[0]

            survivor_id, losing_id, _had_conflict = engine.confirm_suggestion(
                conn, suggestion_id
            )
            assert {survivor_id, losing_id} == {prop_a, prop_b}

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                    (listing_a, listing_b),
                )
                property_ids_after = {row[0] for row in cur.fetchall()}
            assert property_ids_after == {survivor_id}

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT match_basis, confidence FROM property_merge_log "
                    "WHERE property_id = %s AND losing_property_id = %s",
                    (survivor_id, losing_id),
                )
                basis, confidence = cur.fetchone()
            assert basis == "fuzzy"
            assert Decimal("0.55") <= confidence <= Decimal("0.59")
        finally:
            orchestrator.CONNECTORS.clear()
            with conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                cur.execute("DELETE FROM property_merge_log")
                cur.execute("DELETE FROM suggested_merge")
                cur.execute(
                    "DELETE FROM listing WHERE source IN ('milanuncios', 'fotocasa') "
                    "AND external_id IN ('534062143', '185398766')"
                )
                cur.execute(
                    "DELETE FROM property WHERE id = ANY(%s)", ([prop_a, prop_b],)
                )
            conn.commit()
