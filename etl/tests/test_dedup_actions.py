"""Tests for the dedup review-queue action processor (etl/dedup/actions.py).

Integration tests against a real PostgreSQL instance (`dedup_db`, imported
from test_dedup_engine — same fixture, same isolated-per-session database).
This module is the ETL-container half of the dashboard review queue: the
dashboard only ever inserts a `suggested_merge_action` row (see
dashboard/lib/dedup.ts) — `process_pending_actions` is what actually calls
`engine.confirm_suggestion`/`reject_suggestion` and produces the real DB
effects (property/listing reassignment, `property_merge_log`). These tests
exercise that real round trip, not a mock.
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup import actions, engine
from etl.tests.test_dedup_engine import _insert_pair, dedup_db

__all__ = ["dedup_db"]  # re-exported fixture, keep the linter quiet


_suggestion_seq = iter(range(1, 10_000))


def _file_one_suggestion(conn) -> tuple[int, int, int, int, int]:
    """Same fixture shape as TestSuggestionResolution._file_one_suggestion
    in test_dedup_engine.py: a shared, uncorroborated reference_code files a
    suggestion (not an auto-merge) by design (issue #72).

    Each call uses a fresh external_id/reference_code suffix (`_suggestion_seq`)
    so a test that seeds two independent pairs (e.g. one good, one already
    resolved) doesn't collide on `listing`'s (source, external_id) UNIQUE
    constraint.
    """
    n = next(_suggestion_seq)
    listing_a, prop_a, listing_b, prop_b = _insert_pair(
        conn,
        "idealista",
        "fotocasa",
        f"actions-flow-{n}",
        reference_code_a=f"NS-9911-{n}",
        reference_code_b=f"NS-9911-{n}",
        # Distinct, per-call addresses (default is a constant placeholder,
        # see _insert_property) — a test that seeds two independent pairs in
        # the same dedup_db must not have them look like fuzzy matches of
        # *each other* (identical address + size + price would otherwise
        # clear fuzzy's floor across pairs and file spurious extra rows).
        address_a=f"Calle Falsa {n}A",
        address_b=f"Calle Falsa {n}B",
        m2_built_a=Decimal(70),
        m2_built_b=Decimal(180),
        current_price_a=Decimal(200000),
        current_price_b=Decimal(600000),
    )
    result = engine.run(conn)
    assert result.suggested >= 1, "fixture should file at least one suggestion"
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM suggested_merge WHERE listing_id_a IN (%s, %s) "
            "OR listing_id_b IN (%s, %s)",
            (listing_a, listing_b, listing_a, listing_b),
        )
        (suggestion_id,) = cur.fetchone()
    return suggestion_id, listing_a, prop_a, listing_b, prop_b


def _enqueue(conn, suggestion_id: int, action: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO suggested_merge_action (suggestion_id, action) "
            "VALUES (%s, %s) RETURNING id",
            (suggestion_id, action),
        )
        (action_id,) = cur.fetchone()
    conn.commit()
    return action_id


class TestProcessPendingActionsConfirm:
    def test_confirm_action_merges_the_pair_for_real(self, dedup_db):
        """The exact round trip the verification standard asks for: confirm
        via the queue, then assert one property with both listings and a
        property_merge_log row — not a mocked call, a real merge."""
        suggestion_id, listing_a, prop_a, listing_b, prop_b = _file_one_suggestion(
            dedup_db
        )
        action_id = _enqueue(dedup_db, suggestion_id, "confirm")

        processed = actions.process_pending_actions(dedup_db)
        assert processed == 1

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, error_msg, result FROM suggested_merge_action WHERE id = %s",
                (action_id,),
            )
            status, error_msg, result = cur.fetchone()
        assert status == "done"
        assert error_msg is None
        survivor_id = result["survivor_property_id"]
        losing_id = result["losing_property_id"]
        assert {survivor_id, losing_id} == {prop_a, prop_b}

        with dedup_db.cursor() as cur:
            # One property now carries both listings.
            cur.execute(
                "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert [r[0] for r in cur.fetchall()] == [survivor_id]

            # A real property_merge_log row exists for this merge.
            cur.execute(
                "SELECT COUNT(*) FROM property_merge_log "
                "WHERE property_id = %s AND losing_property_id = %s",
                (survivor_id, losing_id),
            )
            assert cur.fetchone()[0] == 1

            # The suggestion itself reflects the confirm.
            cur.execute(
                "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
            )
            assert cur.fetchone()[0] == "confirmed"

    def test_pending_action_is_left_alone_until_processed(self, dedup_db):
        suggestion_id, *_ = _file_one_suggestion(dedup_db)
        action_id = _enqueue(dedup_db, suggestion_id, "confirm")

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge_action WHERE id = %s", (action_id,)
            )
            assert cur.fetchone()[0] == "pending"

    def test_processed_count_excludes_untouched_rows(self, dedup_db):
        suggestion_id, *_ = _file_one_suggestion(dedup_db)
        _enqueue(dedup_db, suggestion_id, "confirm")
        assert actions.process_pending_actions(dedup_db) == 1
        # Nothing left pending -> a second pass processes zero.
        assert actions.process_pending_actions(dedup_db) == 0


class TestProcessPendingActionsReject:
    def test_reject_action_marks_the_suggestion_rejected_without_merging(
        self, dedup_db
    ):
        suggestion_id, listing_a, prop_a, listing_b, prop_b = _file_one_suggestion(
            dedup_db
        )
        action_id = _enqueue(dedup_db, suggestion_id, "reject")

        processed = actions.process_pending_actions(dedup_db)
        assert processed == 1

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
            )
            assert cur.fetchone()[0] == "rejected"

            cur.execute(
                "SELECT status FROM suggested_merge_action WHERE id = %s", (action_id,)
            )
            assert cur.fetchone()[0] == "done"

            # No merge happened — both properties still stand alone.
            cur.execute(
                "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert {r[0] for r in cur.fetchall()} == {prop_a, prop_b}

    def test_rejected_pair_is_not_refiled_by_a_subsequent_run(self, dedup_db):
        """The other half of the review-queue contract this issue calls out
        explicitly: a rejected suggestion must not reappear. engine.run's
        `_load_recorded_pairs` already excludes every status <> 'confirmed'
        (pending/rejected/conflict all stay in the skip set) — this test
        proves it end-to-end through the actual queue-processing path, not
        just by reading the engine's own docstring."""
        suggestion_id, *_ = _file_one_suggestion(dedup_db)
        _enqueue(dedup_db, suggestion_id, "reject")
        actions.process_pending_actions(dedup_db)

        result = engine.run(dedup_db)
        assert result.suggested == 0, "a rejected pair must not be refiled"

        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            # Still exactly the one (rejected) row — no duplicate refiled.
            assert cur.fetchone()[0] == 1


class TestProcessPendingActionsErrorIsolation:
    def test_already_confirmed_suggestion_is_marked_failed_not_raised(self, dedup_db):
        """A stale confirm request (e.g. the CLI already confirmed it, or a
        double-click enqueued two actions) must not crash the whole batch —
        engine.confirm_suggestion's ValueError is caught and recorded."""
        suggestion_id, *_ = _file_one_suggestion(dedup_db)
        engine.confirm_suggestion(dedup_db, suggestion_id)  # already confirmed

        action_id = _enqueue(dedup_db, suggestion_id, "confirm")
        processed = actions.process_pending_actions(dedup_db)
        assert processed == 1

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, error_msg FROM suggested_merge_action WHERE id = %s",
                (action_id,),
            )
            status, error_msg = cur.fetchone()
        assert status == "failed"
        assert error_msg is not None and "already confirmed" in error_msg

    def test_one_bad_action_does_not_block_the_rest_of_the_batch(self, dedup_db):
        suggestion_id_ok, *_ = _file_one_suggestion(dedup_db)
        suggestion_id_bad, *_ = _file_one_suggestion(dedup_db)
        engine.reject_suggestion(dedup_db, suggestion_id_bad)  # already resolved

        _enqueue(dedup_db, suggestion_id_bad, "confirm")  # will fail
        action_id_ok = _enqueue(
            dedup_db, suggestion_id_ok, "confirm"
        )  # should still succeed

        processed = actions.process_pending_actions(dedup_db)
        assert processed == 2

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge_action WHERE id = %s",
                (action_id_ok,),
            )
            assert cur.fetchone()[0] == "done"


class _NoCloseConnProxy:
    """Wraps a real psycopg2 connection but swallows `.close()`.

    `cli.main()` unconditionally closes whatever `get_connection()` hands
    it (`finally: conn.close()`) — correct for real usage, but this test
    hands it the shared, function-scoped `dedup_db` fixture connection,
    which the fixture's own teardown (`_cleanup`, run *after* this test
    returns) still needs to issue cursor operations on. A real close() here
    would make that teardown raise on a closed connection. Everything else
    is forwarded untouched.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


class TestCliProcessActions:
    def test_process_actions_cli_subcommand_drains_the_queue(
        self, dedup_db, monkeypatch, capsys
    ):
        """`ps dedup process-actions` (the manual/CLI equivalent of the
        background poll loop) drains the queue through the same
        `process_pending_actions` this module tests directly above.
        """
        from etl.dedup import cli as dedup_cli

        suggestion_id, *_ = _file_one_suggestion(dedup_db)
        _enqueue(dedup_db, suggestion_id, "confirm")

        monkeypatch.setattr(
            dedup_cli, "get_connection", lambda config: _NoCloseConnProxy(dedup_db)
        )
        exit_code = dedup_cli.main(["process-actions"])
        assert exit_code == 0

        captured = capsys.readouterr()
        assert "Processed 1" in captured.out

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
            )
            assert cur.fetchone()[0] == "confirmed"
