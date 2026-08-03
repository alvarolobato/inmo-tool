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


class TestOwnerIdentityRetention:
    def test_purge_stale_owner_identities(self, pg_conn):
        """purge_stale_owner_identities() must anonymize owner_identity rows
        past the retention window with no active listing — including rows
        that were NEVER linked to an active listing at all (last_linked_active_at
        IS NULL), via the created_at fallback — while sparing rows still
        linked to an active listing regardless of age.
        """
        _apply_schema(pg_conn)
        stale_cutoff = datetime.now(timezone.utc) - timedelta(days=91)
        recent = datetime.now(timezone.utc) - timedelta(days=1)
        stale_id = fresh_id = never_linked_stale_id = property_id = None

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
                # Never linked to anything (last_linked_active_at IS NULL) but
                # created long ago -- must still age out via the COALESCE
                # fallback to created_at, not be retained forever.
                cur.execute(
                    "INSERT INTO owner_identity (phone, last_linked_active_at, created_at) "
                    "VALUES (%s, NULL, %s) RETURNING id",
                    ("+34600333333", stale_cutoff),
                )
                never_linked_stale_id = cur.fetchone()[0]
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

            with pg_conn.cursor() as cur:
                cur.execute("SELECT purge_stale_owner_identities(90)")
                purged_count = cur.fetchone()[0]
            pg_conn.commit()

            assert purged_count == 2  # stale_id + never_linked_stale_id

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT id, phone FROM owner_identity WHERE id IN (%s, %s, %s)",
                    (stale_id, fresh_id, never_linked_stale_id),
                )
                phones = dict(cur.fetchall())
            assert phones[stale_id] is None
            assert phones[never_linked_stale_id] is None
            assert phones[fresh_id] == "+34600222222"
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                if fresh_id is not None:
                    cur.execute(
                        "DELETE FROM listing_owner_identity WHERE owner_identity_id IN (%s, %s, %s)",
                        (stale_id, fresh_id, never_linked_stale_id),
                    )
                if property_id is not None:
                    cur.execute(
                        "DELETE FROM listing WHERE property_id = %s", (property_id,)
                    )
                    cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
                if stale_id is not None:
                    cur.execute(
                        "DELETE FROM owner_identity WHERE id IN (%s, %s, %s)",
                        (stale_id, fresh_id, never_linked_stale_id),
                    )
            pg_conn.commit()


class TestAiAssessmentUniqueness:
    def test_null_prompt_version_is_not_distinct(self, pg_conn):
        """UNIQUE NULLS NOT DISTINCT: two assessments for the same property +
        type with prompt_version left NULL must collide, not silently
        duplicate (the bug: default UNIQUE treats every NULL as distinct).
        """
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO ai_assessment (property_id, assessment_type, result) "
                    "VALUES (%s, 'occupancy', '{}'::jsonb)",
                    (property_id,),
                )
            pg_conn.commit()
            with (
                pytest.raises(psycopg2.errors.UniqueViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO ai_assessment (property_id, assessment_type, result) "
                    "VALUES (%s, 'occupancy', '{}'::jsonb)",
                    (property_id,),
                )
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                # ai_assessment.property_id has no ON DELETE CASCADE (deliberate
                # — see data-model.md), so it must be cleared before property.
                cur.execute(
                    "DELETE FROM ai_assessment WHERE property_id = %s", (property_id,)
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()

    def test_two_listings_of_one_property_share_a_single_assessment(self, pg_conn):
        """#25's core guarantee: a property deduplicated across portals gets
        ONE occupancy verdict, not one per advert.

        Under the old listing_id key this test could not fail — two listings
        meant two legitimately-distinct rows. Keyed on property_id the second
        insert must collide, which is precisely what stops three portals
        producing three contradictory answers about one physical flat.
        """
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            _insert_listing(pg_conn, property_id, "fotocasa", "occ-a")
            _insert_listing(pg_conn, property_id, "milanuncios", "occ-b")
            pg_conn.commit()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(property_id, assessment_type, result, prompt_version) "
                    "VALUES (%s, 'occupancy', '{}'::jsonb, 'occupancy/v1')",
                    (property_id,),
                )
            pg_conn.commit()
            with (
                pytest.raises(psycopg2.errors.UniqueViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(property_id, assessment_type, result, prompt_version) "
                    "VALUES (%s, 'occupancy', '{}'::jsonb, 'occupancy/v1')",
                    (property_id,),
                )
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM ai_assessment WHERE property_id = %s", (property_id,)
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()


class TestAiAssessmentRekeyMigration:
    """#25 re-keyed ai_assessment from listing_id to property_id.

    Fresh installs get the new shape straight from CREATE TABLE and never
    execute the migration block — so passing schema tests prove nothing about
    the upgrade path that every existing database will actually take. These
    tests rebuild the OLD shape by hand, re-apply init.sql, and assert the
    backfill lands.
    """

    @staticmethod
    def _install_old_shape(conn) -> None:
        """Recreate ai_assessment as it existed before #25 (listing-keyed)."""
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS ai_assessment")
            cur.execute(
                """
                CREATE TABLE ai_assessment (
                    id              BIGSERIAL    PRIMARY KEY,
                    listing_id      BIGINT       NOT NULL REFERENCES listing(id),
                    assessment_type TEXT         NOT NULL,
                    result          JSONB        NOT NULL,
                    confidence      NUMERIC(4,3),
                    model           TEXT,
                    prompt_version  TEXT,
                    generated_at    TIMESTAMPTZ,
                    UNIQUE NULLS NOT DISTINCT (listing_id, assessment_type, prompt_version)
                )
                """
            )
        conn.commit()

    def test_migration_collapses_duplicates_keeping_newest(self, pg_conn):
        """Two listings of ONE property, each with its own occupancy verdict.

        Legal under the old listing key, illegal under the new property key.
        The migration must keep exactly one row — the newest — and must not
        abort the whole init.sql run on a unique violation.
        """
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            listing_a = _insert_listing(pg_conn, property_id, "fotocasa", "mig-a")
            listing_b = _insert_listing(pg_conn, property_id, "milanuncios", "mig-b")
            pg_conn.commit()

            self._install_old_shape(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(listing_id, assessment_type, result, prompt_version) "
                    "VALUES (%s, 'occupancy', '{\"status\":\"vacant\"}'::jsonb, 'occupancy/v1')",
                    (listing_a,),
                )
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(listing_id, assessment_type, result, prompt_version) "
                    "VALUES (%s, 'occupancy', '{\"status\":\"tenanted\"}'::jsonb, 'occupancy/v1')",
                    (listing_b,),
                )
            pg_conn.commit()

            _apply_schema(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT property_id, result->>'status' FROM ai_assessment "
                    "WHERE property_id = %s",
                    (property_id,),
                )
                rows = cur.fetchall()
                assert len(rows) == 1, f"expected one collapsed row, got {rows}"
                assert rows[0][0] == property_id
                # Both rows have NULL generated_at (old-shape inserts below
                # never set it), so the dedup falls back to its id tiebreak —
                # a.id < b.id keeps the higher id, the second insert.
                assert rows[0][1] == "tenanted"

                cur.execute(
                    "SELECT 1 FROM information_schema.columns "
                    "WHERE table_name = 'ai_assessment' AND column_name = 'listing_id'"
                )
                assert cur.fetchone() is None, "listing_id should have been dropped"
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM ai_assessment WHERE property_id = %s", (property_id,)
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()

    def test_migration_keeps_latest_generated_at_even_when_its_id_is_lower(
        self, pg_conn
    ):
        """`generated_at`, not `id`, decides "newest" (#156 review, nice-to-have).

        Insert the ACTUALLY-newer verdict with the LOWER id (e.g. a re-run
        that landed on a connection with a smaller sequence value, or a
        restored backup re-inserted before a later one). Under a purely
        id-ordered dedup this row would be discarded; the migration must
        keep it because it is newer by generated_at.
        """
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            listing_a = _insert_listing(pg_conn, property_id, "fotocasa", "mig-gen-a")
            listing_b = _insert_listing(
                pg_conn, property_id, "milanuncios", "mig-gen-b"
            )
            pg_conn.commit()

            self._install_old_shape(pg_conn)
            now = datetime.now(timezone.utc)
            with pg_conn.cursor() as cur:
                # listing_a: LOWER id, but generated LATER.
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(listing_id, assessment_type, result, prompt_version, generated_at) "
                    "VALUES (%s, 'occupancy', '{\"status\":\"tenanted\"}'::jsonb, "
                    "'occupancy/v1', %s)",
                    (listing_a, now),
                )
                # listing_b: HIGHER id, but generated EARLIER.
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(listing_id, assessment_type, result, prompt_version, generated_at) "
                    "VALUES (%s, 'occupancy', '{\"status\":\"vacant\"}'::jsonb, "
                    "'occupancy/v1', %s)",
                    (listing_b, now - timedelta(days=1)),
                )
            pg_conn.commit()

            _apply_schema(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT result->>'status' FROM ai_assessment "
                    "WHERE property_id = %s",
                    (property_id,),
                )
                rows = cur.fetchall()
                assert len(rows) == 1, f"expected one collapsed row, got {rows}"
                # The higher-id row (vacant) is actually the OLDER one and
                # must lose to the lower-id, newer-by-generated_at row.
                assert rows[0][0] == "tenanted"
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM ai_assessment WHERE property_id = %s", (property_id,)
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()

    def test_migration_backfills_property_id_from_listing(self, pg_conn):
        """A single old-shape row must land on its listing's property, and the
        re-keyed table must then reject a second verdict for that property."""
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            listing_id = _insert_listing(pg_conn, property_id, "fotocasa", "mig-solo")
            pg_conn.commit()

            self._install_old_shape(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(listing_id, assessment_type, result, prompt_version) "
                    "VALUES (%s, 'occupancy', '{\"status\":\"vacant\"}'::jsonb, 'occupancy/v1')",
                    (listing_id,),
                )
            pg_conn.commit()

            _apply_schema(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT property_id FROM ai_assessment WHERE property_id = %s",
                    (property_id,),
                )
                assert cur.fetchall() == [(property_id,)]

            with (
                pytest.raises(psycopg2.errors.UniqueViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO ai_assessment "
                    "(property_id, assessment_type, result, prompt_version) "
                    "VALUES (%s, 'occupancy', '{}'::jsonb, 'occupancy/v1')",
                    (property_id,),
                )
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM ai_assessment WHERE property_id = %s", (property_id,)
                )
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()


class TestEnumLikeColumnsConstrained:
    def test_pipeline_stage_rejects_invalid_value(self, pg_conn):
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        profile_id = _insert_profile(pg_conn)
        pg_conn.commit()
        try:
            with (
                pytest.raises(psycopg2.errors.CheckViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO profile_listing_state (profile_id, property_id, pipeline_stage) "
                    "VALUES (%s, %s, 'not-a-real-stage')",
                    (profile_id, property_id),
                )
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()

    def test_listing_status_event_rejects_invalid_status(self, pg_conn):
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            listing_id = _insert_listing(
                pg_conn, property_id, "idealista", "bad-status-evt"
            )
            pg_conn.commit()
            with (
                pytest.raises(psycopg2.errors.CheckViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO listing_status_event (listing_id, observed_at, status) "
                    "VALUES (%s, NOW(), 'not-a-real-status')",
                    (listing_id,),
                )
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()

    def test_listing_operation_rejects_invalid_value(self, pg_conn):
        _apply_schema(pg_conn)
        property_id = _insert_property(pg_conn)
        pg_conn.commit()
        try:
            with (
                pytest.raises(psycopg2.errors.CheckViolation),
                pg_conn.cursor() as cur,
            ):
                cur.execute(
                    "INSERT INTO listing (property_id, source, external_id, operation) "
                    "VALUES (%s, %s, %s, 'alquiler')",
                    (property_id, "idealista", "bad-operation"),
                )
        finally:
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing WHERE property_id = %s", (property_id,)
                )
                cur.execute("DELETE FROM property WHERE id = %s", (property_id,))
            pg_conn.commit()
