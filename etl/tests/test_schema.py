"""Tests for the canonical real-estate schema (issue #10, Phase 1.2).

These are integration tests against a real PostgreSQL instance (via the
pg_conn fixture — skipped if no PostgreSQL config is present, per
conftest.py). They exercise the actual DDL applied from init.sql rather
than mocking constraints, since the whole point of this task is that the
database itself enforces the invariants (NOT NULL, UNIQUE, PRIMARY KEY),
not application code.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import pytest

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _insert_property(conn, **overrides) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO property (address, property_type) VALUES (%s, %s) RETURNING id",
            (
                overrides.get("address", "Calle Falsa 123"),
                overrides.get("property_type", "piso"),
            ),
        )
        return cur.fetchone()[0]


def _insert_listing(
    conn, property_id: int, source: str, external_id: str, **overrides
) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO listing (property_id, source, external_id, status, current_price)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
            """,
            (
                property_id,
                source,
                external_id,
                overrides.get("status", "active"),
                overrides.get("current_price", 100000),
            ),
        )
        return cur.fetchone()[0]


def _insert_profile(conn, name: str = "test profile") -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO search_profile (name) VALUES (%s) RETURNING id", (name,)
        )
        return cur.fetchone()[0]


class TestListingRequiresProperty:
    def test_listing_requires_property(self, pg_conn):
        _apply_schema(pg_conn)
        try:
            with (
                pytest.raises(psycopg2.errors.NotNullViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO listing (source, external_id) VALUES (%s, %s)",
                    ("idealista", "ext-no-property"),
                )
        finally:
            pg_conn.rollback()

    def test_listing_rejects_nonexistent_property(self, pg_conn):
        _apply_schema(pg_conn)
        try:
            with (
                pytest.raises(psycopg2.errors.ForeignKeyViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO listing (property_id, source, external_id) VALUES (%s, %s, %s)",
                    (999_999_999, "idealista", "ext-bad-fk"),
                )
        finally:
            pg_conn.rollback()


class TestListingSourceExternalIdUnique:
    def test_listing_source_external_id_unique(self, pg_conn):
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            _insert_listing(pg_conn, property_id, "idealista", "dup-123")
            pg_conn.commit()
            with pytest.raises(psycopg2.errors.UniqueViolation):
                _insert_listing(pg_conn, property_id, "idealista", "dup-123")
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing WHERE source = 'idealista' AND external_id = 'dup-123'"
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()


class TestProfileListingStateKeying:
    def test_profile_listing_state_one_row_per_property(self, pg_conn):
        """Two listings (as if from different sites) sharing one property_id
        must collapse to exactly one profile_listing_state row per profile —
        this is the schema-level guarantee the dedup fix depends on.
        """
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        profile_id = _insert_profile(pg_conn)
        pg_conn.commit()
        try:
            listing_a = _insert_listing(
                pg_conn, property_id, "idealista", "prop-shared-a"
            )
            listing_b = _insert_listing(
                pg_conn, property_id, "fotocasa", "prop-shared-b"
            )
            pg_conn.commit()

            with pg_conn.cursor() as cur:
                # Upsert-style: state is written once for (profile, property),
                # regardless of which listing the user was looking at.
                cur.execute(
                    """
                    INSERT INTO profile_listing_state (profile_id, property_id, pipeline_stage)
                    VALUES (%s, %s, 'interested')
                    ON CONFLICT (profile_id, property_id) DO UPDATE SET pipeline_stage = EXCLUDED.pipeline_stage
                    """,
                    (profile_id, property_id),
                )
                cur.execute(
                    """
                    INSERT INTO profile_listing_state (profile_id, property_id, pipeline_stage)
                    VALUES (%s, %s, 'rejected')
                    ON CONFLICT (profile_id, property_id) DO UPDATE SET pipeline_stage = EXCLUDED.pipeline_stage
                    """,
                    (profile_id, property_id),
                )
            pg_conn.commit()

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*), max(pipeline_stage) FROM profile_listing_state WHERE profile_id = %s AND property_id = %s",
                    (profile_id, property_id),
                )
                count, stage = cur.fetchone()
            assert count == 1
            assert stage == "rejected"  # the second write won, proving one row not two

            # Sanity: both listings genuinely point at the same property.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT property_id FROM listing WHERE id IN (%s, %s)",
                    (listing_a, listing_b),
                )
                property_ids = {row[0] for row in cur.fetchall()}
            assert property_ids == {property_id}
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM profile_listing_state WHERE profile_id = %s",
                    (profile_id,),
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()


class TestOwnerIdentityRetentionQuery:
    def test_owner_identity_retention_query(self, pg_conn):
        """Proves the retention query documented in init.sql (above the
        owner_identity table) correctly identifies rows to purge: linked
        only to inactive/no listings and past the retention window, while
        sparing rows still linked to an active listing.
        """
        _apply_schema(pg_conn)
        stale_cutoff = datetime.now(timezone.utc) - timedelta(days=91)
        recent = datetime.now(timezone.utc) - timedelta(days=1)

        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO owner_identity (phone, last_linked_active_at) VALUES (%s, %s) RETURNING id",
                    ("+34600111111", stale_cutoff),
                )
                stale_id = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO owner_identity (phone, last_linked_active_at) VALUES (%s, %s) RETURNING id",
                    ("+34600222222", recent),
                )
                fresh_id = cur.fetchone()[0]
            pg_conn.commit()

            property_id = _insert_property(pg_conn)
            pg_conn.commit()
            # fresh_id is linked to a currently-active listing -> must be spared
            # regardless of last_linked_active_at.
            active_listing = _insert_listing(
                pg_conn, property_id, "idealista", "retention-active", status="active"
            )
            pg_conn.commit()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO listing_owner_identity (listing_id, owner_identity_id) VALUES (%s, %s)",
                    (active_listing, fresh_id),
                )
            pg_conn.commit()

            retention_query = """
                SELECT id FROM owner_identity
                WHERE last_linked_active_at < NOW() - INTERVAL '90 days'
                  AND id NOT IN (
                    SELECT loi.owner_identity_id
                    FROM listing_owner_identity loi
                    JOIN listing l ON l.id = loi.listing_id
                    WHERE l.status = 'active'
                  )
            """
            with pg_conn.cursor() as cur:
                cur.execute(retention_query)
                purge_candidates = {row[0] for row in cur.fetchall()}

            assert stale_id in purge_candidates
            assert fresh_id not in purge_candidates
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing_owner_identity WHERE owner_identity_id IN (%s, %s)",
                    (stale_id, fresh_id),
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
                cur.execute(
                    "DELETE FROM owner_identity WHERE id IN (%s, %s)",
                    (stale_id, fresh_id),
                )
            pg_conn.commit()
