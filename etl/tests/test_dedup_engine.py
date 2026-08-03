"""Tests for the deduplication engine (issue #16, Phase 2.2).

Integration tests against a real PostgreSQL instance (pg_conn fixture,
skipped if unavailable — same pattern as test_schema.py/test_orchestrator.py)
since the engine's whole job is what ends up persisted (merges, suggestions,
reconciled state), which mocking the database would not meaningfully test.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import imagehash
import pytest

from etl import orchestrator
from etl.connectors import base
from etl.connectors.base import CanonicalListingVersion
from etl.dedup import engine
from etl.dedup.engine import _PhotoHashCache
from etl.dedup.signals import phone_extract, reference_code
from etl.dedup.types import ListingRecord

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
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
                overrides.get("address", "Calle Falsa 123"),
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
                 current_price, contact_raw, reference_code)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                property_id,
                source,
                external_id,
                overrides.get("listing_kind"),
                overrides.get("description"),
                overrides.get("current_price", Decimal(100000)),
                overrides.get("contact_raw"),
                overrides.get("reference_code"),
            ),
        )
        return cur.fetchone()[0]


def _insert_pair(
    conn, source_a: str, source_b: str, ext_prefix: str, **kwargs
) -> tuple[int, int, int, int]:
    """Insert two properties + one listing each, split kwargs by _a/_b suffix.

    Returns (listing_id_a, property_id_a, listing_id_b, property_id_b).
    """
    prop_kwargs_a = {k[:-2]: v for k, v in kwargs.items() if k.endswith("_a")}
    prop_kwargs_b = {k[:-2]: v for k, v in kwargs.items() if k.endswith("_b")}
    listing_keys = {
        "listing_kind",
        "description",
        "current_price",
        "contact_raw",
        "reference_code",
    }
    listing_kwargs_a = {
        k: prop_kwargs_a.pop(k) for k in list(prop_kwargs_a) if k in listing_keys
    }
    listing_kwargs_b = {
        k: prop_kwargs_b.pop(k) for k in list(prop_kwargs_b) if k in listing_keys
    }

    prop_a = _insert_property(conn, **prop_kwargs_a)
    prop_b = _insert_property(conn, **prop_kwargs_b)
    listing_a = _insert_listing(
        conn, prop_a, source_a, f"{ext_prefix}-a", **listing_kwargs_a
    )
    listing_b = _insert_listing(
        conn, prop_b, source_b, f"{ext_prefix}-b", **listing_kwargs_b
    )
    conn.commit()
    return listing_a, prop_a, listing_b, prop_b


def _insert_profile(conn, name: str = "test profile") -> int:
    # `scope` is explicitly supplied because D-013 removed its DB-level
    # `'{}'` default: an INSERT that forgets a scope must fail loudly rather
    # than quietly creating a profile that matches nothing. These fixtures
    # don't care what the scope *is*, only that one is present.
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
            (name, "{}"),
        )
        conn.commit()
        return cur.fetchone()[0]


def _set_pls(
    conn, profile_id: int, property_id: int, stage: str, matched: bool = True
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO profile_listing_state (profile_id, property_id, pipeline_stage, matched) "
            "VALUES (%s, %s, %s, %s)",
            (profile_id, property_id, stage, matched),
        )
    conn.commit()


def _cleanup(conn) -> None:
    with conn.cursor() as cur:
        # suggested_merge_action FKs to suggested_merge ON DELETE CASCADE,
        # so this explicit delete isn't strictly required for the DELETE
        # below to succeed — but test_dedup_actions.py's tests leave 'done'/
        # 'failed' rows behind, and clearing them here keeps every test in
        # this shared, per-session database starting from a clean queue.
        cur.execute("DELETE FROM suggested_merge_action")
        cur.execute("DELETE FROM suggested_merge")
        cur.execute("DELETE FROM property_merge_log")
        cur.execute("DELETE FROM feedback_event")
        cur.execute("DELETE FROM profile_listing_state")
        cur.execute("DELETE FROM search_profile")
        cur.execute("DELETE FROM listing")
        cur.execute("DELETE FROM property")
    conn.commit()


@pytest.fixture
def dedup_db(pg_conn):
    _apply_schema(pg_conn)
    _cleanup(pg_conn)
    yield pg_conn
    _cleanup(pg_conn)


def _record(listing_id: int, property_id: int, **overrides) -> ListingRecord:
    return ListingRecord(
        listing_id=listing_id,
        property_id=property_id,
        source=overrides.get("source", "idealista"),
        external_id=overrides.get("external_id", str(listing_id)),
        listing_kind=overrides.get("listing_kind"),
        description=overrides.get("description"),
        photo_urls=overrides.get("photo_urls", ()),
        cadastral_ref=overrides.get("cadastral_ref"),
        address=overrides.get("address"),
        lat=overrides.get("lat"),
        lon=overrides.get("lon"),
        m2_built=overrides.get("m2_built"),
        current_price=overrides.get("current_price"),
        contact_raw=overrides.get("contact_raw"),
        reference_code=overrides.get("reference_code"),
        floor=overrides.get("floor"),
    )


class TestCadastralExactMatch:
    def test_cadastral_exact_match_merges(self):
        """EC-2 at the signal-dispatch level (in-memory ListingRecords).

        Complemented by the DB round-trip below — this one isolates the
        matching logic itself.
        """
        a = _record(1, 100, cadastral_ref="1234567AB1234C0001AB")
        b = _record(2, 200, cadastral_ref="1234567AB1234C0001AB")
        evaluation = engine.evaluate_pair(a, b, _PhotoHashCache())
        assert evaluation.basis == "cadastral"
        assert evaluation.confidence == Decimal("1.000")
        assert evaluation.decision == "merge"

    def test_two_property_rows_may_share_a_cadastral_ref(self, dedup_db):
        """The schema must *permit* the state this signal exists to detect.

        Replaces a test that asserted the opposite. `property.cadastral_ref`
        was UNIQUE (task 1.2), on the intuitive reasoning that a cadastral
        reference identifies exactly one real property — true of the world,
        false of this table, because `property` rows are created one per
        listing at ingest. The same flat on two portals legitimately yields
        two rows, and if both sources publish the reference, both carry it.

        UNIQUE therefore made signal 1 unreachable by construction: it
        detects two-rows-same-ref, which the constraint forbade. Issue #140
        dropped it for a plain index. If someone reintroduces UNIQUE, this
        test fails loudly rather than the signal silently going dark again.
        """
        first = _insert_property(dedup_db, cadastral_ref="1234567AB1234C0001AB")
        second = _insert_property(dedup_db, cadastral_ref="1234567AB1234C0001AB")
        assert first != second

    def test_cross_source_cadastral_match_auto_merges_end_to_end(self, dedup_db):
        """The acceptance criterion that matters (#140): the signal fires for real.

        Two listings from different sources, no other corroborating signal —
        different addresses, no coordinates, no shared phone, no shared
        reference code, materially different sizes and prices. Only the
        cadastral reference ties them together, so a merge here can only
        have come from signal 1.
        """
        _insert_pair(
            dedup_db,
            "solvia",
            "servihabitat",
            "cadastral-cross-source",
            cadastral_ref_a="3061226YH0036S0007SM",
            cadastral_ref_b="3061226YH0036S0007SM",
            address_a="Calle Mayor 1",
            address_b="C/ Mayor nº1, esc. 2",
            m2_built_a=Decimal(80),
            m2_built_b=Decimal(95),
            current_price_a=Decimal(230000),
            current_price_b=Decimal(219000),
        )

        result = engine.run(dedup_db)

        assert result.merged == 1
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis, confidence FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            basis, confidence = cur.fetchone()
            assert basis == "cadastral"
            assert confidence == Decimal("1.000")
            # Both listings now hang off one surviving property row.
            cur.execute(
                "SELECT COUNT(DISTINCT property_id) FROM listing "
                "WHERE source IN ('solvia', 'servihabitat')"
            )
            assert cur.fetchone()[0] == 1

    @pytest.mark.parametrize(
        "placeholder",
        [
            "N/A",
            "-",
            "00000000000000000000",
            "AAAAAAAAAAAAAAAAAAAA",
            "sin referencia",
            "  ",
        ],
    )
    def test_placeholder_refs_ingested_for_real_do_not_merge(
        self, dedup_db, placeholder
    ):
        """The counterweight to the test above (#154 review, finding 3).

        Signal 1 merges at confidence 1.000 — the one level that bypasses
        every corroboration rule the weaker signals have. #140 dropped the
        UNIQUE on `property.cadastral_ref`, and with it the accident that
        made mass-collision impossible, so a portal publishing the same
        placeholder on every listing would union its entire inventory into
        one property.

        Deliberately ingested through `_upsert_canonical_listing` rather
        than `_insert_pair`: the guard lives in
        `CanonicalListingVersion.__post_init__`, so seeding the rows
        directly would bypass the very thing under test and pass whether
        or not it works. `00000000000000000000` and the all-A variant are
        the interesting cases — both are twenty alphanumeric characters, so
        a length-and-charset check alone passes them. The first version of
        this fix did exactly that, and this test is what caught it.
        """
        for i, source in enumerate(("solvia", "servihabitat")):
            orchestrator._upsert_canonical_listing(
                dedup_db,
                CanonicalListingVersion(
                    external_id=f"placeholder-{i}",
                    source=source,
                    url=f"https://example.test/placeholder-{i}",
                    listing_kind="particular",
                    status="active",
                    current_price=Decimal(200000 + i * 45000),
                    description=f"listing {i}",
                    photo_urls=(),
                    contact_raw=None,
                    address=f"Calle Distinta {i}",
                    lat=None,
                    lon=None,
                    property_type="piso",
                    m2_built=Decimal(70 + i * 30),
                    m2_useful=None,
                    rooms=None,
                    bathrooms=None,
                    floor=None,
                    has_elevator=None,
                    year_built=None,
                    energy_rating=None,
                    cadastral_ref=placeholder,
                ),
            )

        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM property WHERE cadastral_ref IS NOT NULL")
            assert cur.fetchone()[0] == 0, (
                f"{placeholder!r} must be rejected to NULL before it is stored"
            )

        result = engine.run(dedup_db)

        assert result.merged == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM property_merge_log")
            assert cur.fetchone()[0] == 0
            cur.execute(
                "SELECT COUNT(DISTINCT property_id) FROM listing "
                "WHERE source IN ('solvia', 'servihabitat')"
            )
            assert cur.fetchone()[0] == 2, "unrelated properties must stay separate"

    def test_a_genuine_ref_still_survives_normalization(self):
        """Guards the other direction: the check must not eat real data.

        Lower case and stray whitespace are how a real reference arrives
        from a portal that pretty-prints it; rejecting those would silently
        disable signal 1 for the servicer batch (#132) — the failure mode
        that is invisible because it looks exactly like "no duplicates".
        """
        assert (
            base.normalize_cadastral_ref("  9872023vh5797s0001wx  ")
            == "9872023VH5797S0001WX"
        )
        assert base.normalize_cadastral_ref("9872023 VH5797 S0001 WX") == (
            "9872023VH5797S0001WX"
        )
        assert base.normalize_cadastral_ref(None) is None


class TestPhoneSignal:
    def test_phone_match_with_size_mismatch_is_suggestion_not_merge(self, dedup_db):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "phone-size-mismatch",
            m2_built_a=Decimal(40),
            m2_built_b=Decimal(200),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso luminoso, llamar al 622334455",
            description_b="Casa espaciosa, contactar 622334455",
            current_price_a=Decimal(150000),
            current_price_b=Decimal(600000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis, status FROM suggested_merge")
            basis, status = cur.fetchone()
            assert basis == "phone"
            assert status == "pending"

    def test_agency_phone_match_never_auto_merges(self, dedup_db):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "agency-phone",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="agency",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1

    def test_particular_phone_match_requires_corroboration_to_merge(self, dedup_db):
        # Corroborated: matching size/price proximity -> auto-merge.
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "particular-corroborated",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis, confidence FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            basis, confidence = cur.fetchone()
            assert basis == "phone"
            assert confidence == Decimal("0.900")

        # Not corroborated: same phone, wildly different price/size -> suggestion only.
        _insert_pair(
            dedup_db,
            "idealista",
            "milanuncios",
            "particular-uncorroborated",
            m2_built_a=Decimal(30),
            m2_built_b=Decimal(300),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Estudio, tel 611222333",
            description_b="Chalet de lujo, tel 611222333",
            current_price_a=Decimal(90000),
            current_price_b=Decimal(2000000),
        )
        result2 = engine.run(dedup_db)
        assert result2.merged == 0
        assert result2.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT confidence FROM suggested_merge WHERE match_basis = 'phone' "
                "ORDER BY created_at DESC LIMIT 1"
            )
            (confidence,) = cur.fetchone()
            assert confidence == Decimal("0.500")

    def test_corroborated_phone_with_unconfirmed_kind_is_suggestion_not_merge(
        self, dedup_db
    ):
        """The 0.75 tier from phone_extract.py's module docstring: corroborated
        (matching size/price proximity) but listing_kind is None on one or
        both sides — not a positively-confirmed 'particular', so this must
        NOT reach the 0.9 auto-merge tier, but it's also stronger evidence
        than an uncorroborated match, so it must NOT collapse to the 0.5
        tier either. Previously untested (Opus review, PR #55) despite the
        engine having shipped with this exact branch since task 2.2 landed.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "unconfirmed-kind-corroborated",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b=None,
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis, confidence, status FROM suggested_merge")
            basis, confidence, status = cur.fetchone()
            assert basis == "phone"
            assert confidence == Decimal("0.750")
            assert status == "pending"


class TestReferenceCodeSignal:
    """Issue #72: EC-2/EC-3 — a shared reference code alone must never
    auto-merge (collision risk between unrelated agencies); corroboration
    (same agency name, or address/price/size proximity) is required."""

    def test_shared_reference_code_without_corroboration_is_suggestion(self, dedup_db):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "ref-code-uncorroborated",
            m2_built_a=Decimal(40),
            m2_built_b=Decimal(200),
            contact_raw_a="Inmobiliaria Uno",
            contact_raw_b="Inmobiliaria Dos",
            reference_code_a="NS603",
            reference_code_b="NS603",
            current_price_a=Decimal(150000),
            current_price_b=Decimal(600000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis, confidence, status FROM suggested_merge")
            basis, confidence, status = cur.fetchone()
            assert basis == "reference_code"
            assert confidence == Decimal("0.500")
            assert status == "pending"

    def test_shared_reference_code_with_same_agency_only_is_suggestion_not_merge(
        self, dedup_db
    ):
        # Same agency name is NOT independent corroboration on its own
        # (Opus review of #86): two listings from one agency always match
        # on contact_raw by construction, so a batch/campaign code or a
        # copy-paste error across an agency's own unrelated listings must
        # not auto-merge just because the agency name matches. Deliberately
        # mismatched size/price with no proximity corroboration — this
        # should land as a same-agency-tier suggestion (0.750), not a merge.
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "ref-code-same-agency",
            m2_built_a=Decimal(40),
            m2_built_b=Decimal(200),
            current_price_a=Decimal(150000),
            current_price_b=Decimal(600000),
            contact_raw_a="Inmobiliaria Sevilla 2000",
            contact_raw_b="INMOBILIARIA SEVILLA 2000",
            reference_code_a="NS603",
            reference_code_b="ns603",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis, confidence, status FROM suggested_merge")
            basis, confidence, status = cur.fetchone()
            assert basis == "reference_code"
            assert confidence == Decimal("0.750")
            assert status == "pending"

    def test_shared_reference_code_with_same_agency_and_proximity_auto_merges(
        self, dedup_db
    ):
        # Same agency PLUS real proximity corroboration should still merge —
        # the proximity check alone is sufficient, agency identity is
        # incidental here.
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "ref-code-same-agency-and-proximity",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
            contact_raw_a="Inmobiliaria Sevilla 2000",
            contact_raw_b="INMOBILIARIA SEVILLA 2000",
            reference_code_a="NS603",
            reference_code_b="ns603",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis, confidence FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            basis, confidence = cur.fetchone()
            assert basis == "reference_code"
            assert confidence == Decimal("0.900")

    @pytest.mark.parametrize("placeholder", ["0", "-", "REF", "sin referencia"])
    def test_placeholder_reference_codes_never_match(self, dedup_db, placeholder):
        # Low-cardinality/placeholder values ("0", "-", "REF") must never be
        # treated as real reference codes — otherwise unrelated listings
        # sharing a default/unset value would manufacture false matches.
        # Parametrized (one pair per test run, not accumulated in a loop)
        # so this test is only about reference_code staying inert on
        # placeholder values, not about isolating it from every other
        # signal in the engine when multiple pairs coexist in one DB.
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "ref-code-placeholder",
            address_a="Calle Alfa 1",
            address_b="Avenida Omega 99",
            m2_built_a=Decimal(40),
            m2_built_b=Decimal(200),
            current_price_a=Decimal(150000),
            current_price_b=Decimal(600000),
            contact_raw_a="Inmobiliaria Uno",
            contact_raw_b="Inmobiliaria Dos",
            reference_code_a=placeholder,
            reference_code_b=placeholder,
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0

    def test_shared_reference_code_with_size_price_corroboration_auto_merges(
        self, dedup_db
    ):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "ref-code-size-price-corroborated",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
            contact_raw_a="Inmobiliaria Uno",
            contact_raw_b="Inmobiliaria Dos",
            reference_code_a="NS603",
            reference_code_b="NS603",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0

    def test_different_reference_codes_do_not_match(self, dedup_db):
        # Deliberately mismatched size/price/address (distinct addresses,
        # not the shared _insert_property default) so no *other* signal
        # (fuzzy's address+price+size fallback in particular) coincidentally
        # fires and masks whether reference_code itself is correctly inert
        # here.
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "ref-code-different",
            address_a="Calle Alfa 1",
            address_b="Avenida Omega 99",
            m2_built_a=Decimal(40),
            m2_built_b=Decimal(200),
            current_price_a=Decimal(150000),
            current_price_b=Decimal(900000),
            reference_code_a="NS603",
            reference_code_b="AB100",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0


class TestNoSignal:
    def test_unrelated_listings_not_merged_or_suggested(self, dedup_db):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "unrelated",
            address_a="Calle Alcala 1, Madrid",
            address_b="Rambla Catalunya 50, Barcelona",
            m2_built_a=Decimal(60),
            m2_built_b=Decimal(200),
            description_a="Piso sin mas detalles",
            description_b="Atico de lujo",
            current_price_a=Decimal(200000),
            current_price_b=Decimal(1500000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0


class TestRevert:
    def test_revert_restores_prior_property_ids(self, dedup_db):
        listing_a, prop_a, listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "revert-me",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
        )
        engine.run(dedup_db)
        with dedup_db.cursor() as cur:
            cur.execute("SELECT id FROM property_merge_log ORDER BY id DESC LIMIT 1")
            (merge_log_id,) = cur.fetchone()

        engine.revert(dedup_db, merge_log_id)

        with dedup_db.cursor() as cur:
            cur.execute("SELECT property_id FROM listing WHERE id = %s", (listing_a,))
            (restored_a,) = cur.fetchone()
            cur.execute("SELECT property_id FROM listing WHERE id = %s", (listing_b,))
            (restored_b,) = cur.fetchone()
        assert {restored_a, restored_b} == {prop_a, prop_b}

        with pytest.raises(ValueError, match="already reverted"):
            engine.revert(dedup_db, merge_log_id)

    def test_revert_restores_reconciled_profile_state_and_feedback_events(
        self, dedup_db
    ):
        """The bug Opus's review of PR #55 actually caught: the original
        revert() restored listing.property_id pointers only, silently
        losing every profile_listing_state row reconcile_merge deleted (and
        never re-keying feedback_event back) — a real data-loss bug on a
        revert operation, not a documented limitation worth accepting.
        Covers both restoration shapes: a profile where only the losing
        side had state (simple re-key) and one where both sides had
        differing, non-conflicting stages (the survivor's own row gets
        mutated in place and must be restored too, not just re-created for
        the losing side).
        """
        _listing_a, prop_a, _listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "revert-full-state",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 655667788",
            description_b="Piso reformado, tel 655667788",
            current_price_a=Decimal(320000),
            current_price_b=Decimal(315000),
        )
        survivor_id, losing_id = sorted((prop_a, prop_b))

        profile_only_losing = _insert_profile(dedup_db, "only-losing-had-state")
        _set_pls(dedup_db, profile_only_losing, losing_id, "reviewing")

        profile_both = _insert_profile(dedup_db, "both-sides-had-state")
        _set_pls(dedup_db, profile_both, survivor_id, "new")
        _set_pls(dedup_db, profile_both, losing_id, "interested")
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE profile_listing_state SET score = 4.2, rank_explanation = 'pre-merge score' "
                "WHERE profile_id = %s AND property_id = %s",
                (profile_both, survivor_id),
            )
            cur.execute(
                "INSERT INTO feedback_event (profile_id, property_id, feedback_type) "
                "VALUES (%s, %s, 'accept')",
                (profile_both, losing_id),
            )
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.merged == 1

        # Sanity-check the pre-revert (post-merge) state matches what
        # reconcile_merge is documented to do, before proving revert undoes it.
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM profile_listing_state WHERE profile_id = %s",
                (profile_only_losing,),
            )
            assert cur.fetchone()[0] == 1  # simple re-key, one row total
            cur.execute(
                "SELECT pipeline_stage, score, rank_explanation "
                "FROM profile_listing_state WHERE profile_id = %s AND property_id = %s",
                (profile_both, survivor_id),
            )
            stage, score, rank_explanation = cur.fetchone()
            assert stage == "interested"  # bumped from 'new'
            assert score is None and rank_explanation is None  # nulled for rescoring
            cur.execute(
                "SELECT count(*) FROM feedback_event WHERE profile_id = %s AND property_id = %s",
                (profile_both, survivor_id),
            )
            assert cur.fetchone()[0] == 1  # re-keyed onto survivor

            cur.execute("SELECT id FROM property_merge_log ORDER BY id DESC LIMIT 1")
            (merge_log_id,) = cur.fetchone()

        engine.revert(dedup_db, merge_log_id)

        with dedup_db.cursor() as cur:
            # profile_only_losing: row must exist again under the losing
            # property, at its original stage.
            cur.execute(
                "SELECT property_id, pipeline_stage FROM profile_listing_state "
                "WHERE profile_id = %s",
                (profile_only_losing,),
            )
            restored_property_id, restored_stage = cur.fetchone()
            assert restored_property_id == losing_id
            assert restored_stage == "reviewing"

            # profile_both: the survivor's row must be back to its
            # pre-merge values, AND the losing side's row must exist again.
            cur.execute(
                "SELECT pipeline_stage, score, rank_explanation "
                "FROM profile_listing_state WHERE profile_id = %s AND property_id = %s",
                (profile_both, survivor_id),
            )
            stage, score, rank_explanation = cur.fetchone()
            assert stage == "new"
            assert score == Decimal("4.200")
            assert rank_explanation == "pre-merge score"

            cur.execute(
                "SELECT pipeline_stage FROM profile_listing_state "
                "WHERE profile_id = %s AND property_id = %s",
                (profile_both, losing_id),
            )
            (restored_losing_stage,) = cur.fetchone()
            assert restored_losing_stage == "interested"

            # feedback_event must be back on the losing property, not the survivor.
            cur.execute(
                "SELECT property_id FROM feedback_event WHERE profile_id = %s",
                (profile_both,),
            )
            (fb_property_id,) = cur.fetchone()
            assert fb_property_id == losing_id


class TestReconciliation:
    def test_reconcile_unions_feedback_keeps_most_advanced_stage(self, dedup_db):
        _listing_a, prop_a, _listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reconcile-advance",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 633445566",
            description_b="Piso reformado, tel 633445566",
            current_price_a=Decimal(300000),
            current_price_b=Decimal(295000),
        )
        profile_id = _insert_profile(dedup_db)
        _set_pls(dedup_db, profile_id, prop_a, "new")
        _set_pls(dedup_db, profile_id, prop_b, "interested")
        with dedup_db.cursor() as cur:
            # A feedback_event on EACH side — "union" is only meaningfully
            # tested if both sides contribute a row; a single event on just
            # the losing side (the original version of this test) can't
            # distinguish "unioned" from "re-keyed and the other one lost".
            cur.execute(
                "INSERT INTO feedback_event (profile_id, property_id, feedback_type) "
                "VALUES (%s, %s, 'note')",
                (profile_id, prop_a),
            )
            cur.execute(
                "INSERT INTO feedback_event (profile_id, property_id, feedback_type) "
                "VALUES (%s, %s, 'accept')",
                (profile_id, prop_b),
            )
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.conflicts == 0

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT property_id, pipeline_stage FROM profile_listing_state WHERE profile_id = %s",
                (profile_id,),
            )
            rows = cur.fetchall()
            assert len(rows) == 1
            survivor_property_id, stage = rows[0]
            assert stage == "interested"

            cur.execute(
                "SELECT feedback_type FROM feedback_event "
                "WHERE profile_id = %s AND property_id = %s ORDER BY feedback_type",
                (profile_id, survivor_property_id),
            )
            feedback_types = [row[0] for row in cur.fetchall()]
            assert feedback_types == ["accept", "note"]

    def test_reconcile_combines_matched_with_or_and_revert_restores_both_sides(
        self, dedup_db
    ):
        """Opus review of PR #57: `matched` was added (task 2.4, #18) after
        reconcile.py/engine.py were first written, so neither knew about it.
        A merge must not silently drop one side's `matched=true` just
        because the other side was `false`, and revert must restore each
        side's *own* pre-merge value, not the merged OR result."""
        _listing_a, prop_a, _listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reconcile-matched",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 655667788",
            description_b="Piso reformado, tel 655667788",
            current_price_a=Decimal(280000),
            current_price_b=Decimal(275000),
        )
        profile_id = _insert_profile(dedup_db)
        # Same stage on both sides (identical_stage_dropped branch) so this
        # test isolates `matched` reconciliation from stage reconciliation.
        _set_pls(dedup_db, profile_id, prop_a, "new", matched=False)
        _set_pls(dedup_db, profile_id, prop_b, "new", matched=True)
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.conflicts == 0

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT property_id, matched FROM profile_listing_state WHERE profile_id = %s",
                (profile_id,),
            )
            rows = cur.fetchall()
            assert len(rows) == 1
            _survivor_property_id, matched = rows[0]
            assert matched is True, (
                "OR-combination: either side matched=true should win"
            )

            cur.execute("SELECT id FROM property_merge_log ORDER BY id DESC LIMIT 1")
            merge_log_id = cur.fetchone()[0]

        engine.revert(dedup_db, merge_log_id)

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT property_id, matched FROM profile_listing_state "
                "WHERE profile_id = %s ORDER BY property_id",
                (profile_id,),
            )
            restored = dict(cur.fetchall())
            assert restored[prop_a] is False
            assert restored[prop_b] is True

    def test_reconcile_flags_genuine_conflicts_for_human_review(self, dedup_db):
        listing_a, prop_a, listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reconcile-conflict",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 644556677",
            description_b="Piso reformado, tel 644556677",
            current_price_a=Decimal(310000),
            current_price_b=Decimal(305000),
        )
        profile_id = _insert_profile(dedup_db)
        _set_pls(dedup_db, profile_id, prop_a, "rejected")
        _set_pls(dedup_db, profile_id, prop_b, "offer_made")
        survivor_id = min(prop_a, prop_b)
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE profile_listing_state SET score = 3.0 "
                "WHERE profile_id = %s AND property_id = %s",
                (profile_id, survivor_id),
            )
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.conflicts == 1

        with dedup_db.cursor() as cur:
            # Exactly one PLS row survives — the PK forbids two for the
            # same (profile, property) pair; that's the point being tested.
            cur.execute(
                "SELECT score FROM profile_listing_state WHERE profile_id = %s",
                (profile_id,),
            )
            rows = cur.fetchall()
            assert len(rows) == 1
            (score,) = rows[0]
            # The surviving row's score is nulled even though the conflict
            # left its pipeline_stage untouched — the property's identity
            # changed via merge, so a pre-merge score is stale regardless
            # of which reconciliation branch handled the stage (Opus
            # review, PR #55 — previously only the non-conflict
            # differing-stage branch did this).
            assert score is None

            cur.execute(
                "SELECT status, detail FROM suggested_merge WHERE listing_id_a = %s OR listing_id_b = %s",
                (min(listing_a, listing_b), min(listing_a, listing_b)),
            )
            status, detail = cur.fetchone()
            assert status == "conflict"
            conflict = detail["conflicts"][0]
            assert {conflict["survivor_stage"], conflict["losing_stage"]} == {
                "rejected",
                "offer_made",
            }


class TestSuggestionResolution:
    """Issue #60: the suggestion queue used to be write-only.

    `run` filed medium-confidence pairs for review, but nothing could ever
    act on that review — `_pair_already_recorded` skipped any pair with a
    suggestion row forever, so approving one had literally no effect.
    """

    def _file_one_suggestion(self, conn) -> tuple[int, int, int, int, int]:
        """Create a pair that lands as a *suggestion* (not an auto-merge).

        A shared reference_code with no corroboration is suggestion-only by
        design (issue #72's collision-risk rule), which makes it the natural
        fixture for exercising the confirm/reject path.
        """
        listing_a, prop_a, listing_b, prop_b = _insert_pair(
            conn,
            "idealista",
            "fotocasa",
            "confirm-flow",
            reference_code_a="NS-4471",
            reference_code_b="NS-4471",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(180),
            current_price_a=Decimal(200000),
            current_price_b=Decimal(600000),
        )
        result = engine.run(conn)
        assert result.suggested == 1, "fixture should file exactly one suggestion"
        assert result.merged == 0
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM suggested_merge")
            (suggestion_id,) = cur.fetchone()
        return suggestion_id, listing_a, prop_a, listing_b, prop_b

    def test_confirm_merges_the_pair_and_logs_it(self, dedup_db):
        suggestion_id, listing_a, prop_a, listing_b, prop_b = self._file_one_suggestion(
            dedup_db
        )

        survivor_id, losing_id, _ = engine.confirm_suggestion(dedup_db, suggestion_id)
        assert {survivor_id, losing_id} == {prop_a, prop_b}
        assert survivor_id == min(prop_a, prop_b)

        with dedup_db.cursor() as cur:
            # Both listings now point at the survivor — a real merge, not
            # just a status flip on the suggestion row.
            cur.execute(
                "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert [r[0] for r in cur.fetchall()] == [survivor_id]

            # Recorded in property_merge_log identically to an auto-merge,
            # carrying the *original* basis rather than a synthetic one.
            cur.execute(
                "SELECT match_basis, losing_property_id "
                "FROM property_merge_log WHERE property_id = %s",
                (survivor_id,),
            )
            basis, logged_losing = cur.fetchone()
            assert basis == "reference_code"
            assert logged_losing == losing_id

            # Provenance lives on the suggestion, not in the merge log's
            # detail column — that one is reconcile_merge's revert snapshot
            # and is read structurally by `revert`.
            cur.execute(
                "SELECT status, resolved_at, detail FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            status, resolved_at, detail = cur.fetchone()
            assert status == "confirmed"
            assert resolved_at is not None
            assert detail["confirmed_merge"] == {
                "survivor_property_id": survivor_id,
                "losing_property_id": losing_id,
                "had_conflict": False,
            }

    def test_confirmed_pair_no_longer_appears_in_the_review_queue(self, dedup_db):
        """AC: 'a confirmed-then-merged pair no longer appears in suggestions'.

        `ps dedup suggestions` lists status IN ('pending','conflict'), so a
        confirmed row drops out of it.
        """
        suggestion_id, *_ = self._file_one_suggestion(dedup_db)
        engine.confirm_suggestion(dedup_db, suggestion_id)

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM suggested_merge "
                "WHERE status IN ('pending','conflict')"
            )
            assert cur.fetchone()[0] == 0

    def test_confirmed_merge_is_revertable_like_any_other(self, dedup_db):
        """A human-confirmed merge goes through perform_merge, so `revert`
        works on it unchanged — that reuse is the reason to route through
        perform_merge rather than hand-rolling the confirm path."""
        suggestion_id, listing_a, prop_a, listing_b, prop_b = self._file_one_suggestion(
            dedup_db
        )
        engine.confirm_suggestion(dedup_db, suggestion_id)

        with dedup_db.cursor() as cur:
            cur.execute("SELECT id FROM property_merge_log")
            (merge_log_id,) = cur.fetchone()
        engine.revert(dedup_db, merge_log_id)

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT id, property_id FROM listing WHERE id IN (%s, %s) ORDER BY id",
                (listing_a, listing_b),
            )
            restored = dict(cur.fetchall())
        assert restored[listing_a] == prop_a
        assert restored[listing_b] == prop_b

    def test_rerunning_after_confirm_does_not_refile_the_pair(self, dedup_db):
        """The confirmed pair is excluded from the skip set so it *can* be
        re-evaluated — but post-merge both listings share a property, so the
        run short-circuits before ever reaching the suggestion path."""
        suggestion_id, *_ = self._file_one_suggestion(dedup_db)
        engine.confirm_suggestion(dedup_db, suggestion_id)

        result = engine.run(dedup_db)
        assert result.suggested == 0
        assert result.merged == 0

        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 1  # still just the confirmed one

    def test_pending_suggestion_is_not_refiled_on_the_next_run(self, dedup_db):
        """The skip set still does its original job for un-reviewed rows —
        the batching change (#61) must not regress this."""
        self._file_one_suggestion(dedup_db)
        result = engine.run(dedup_db)
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 1

    def test_reject_keeps_the_pair_out_of_future_runs(self, dedup_db):
        suggestion_id, *_ = self._file_one_suggestion(dedup_db)
        engine.reject_suggestion(dedup_db, suggestion_id)

        result = engine.run(dedup_db)
        assert result.suggested == 0
        assert result.merged == 0

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, resolved_at FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            status, resolved_at = cur.fetchone()
            assert status == "rejected"
            assert resolved_at is not None

    def test_confirming_an_already_confirmed_suggestion_is_refused(self, dedup_db):
        suggestion_id, *_ = self._file_one_suggestion(dedup_db)
        engine.confirm_suggestion(dedup_db, suggestion_id)
        with pytest.raises(ValueError, match="already confirmed"):
            engine.confirm_suggestion(dedup_db, suggestion_id)

    def test_confirming_a_conflict_row_points_at_resolve_conflict(self, dedup_db):
        """A 'conflict' row means a merge already happened and left clashing
        per-profile state — merging again is not the right action, so confirm
        refuses and names the command that is."""
        _listing_a, prop_a, _listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "conflict-confirm",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 644556677",
            description_b="Piso reformado, tel 644556677",
            current_price_a=Decimal(310000),
            current_price_b=Decimal(305000),
        )
        profile_id = _insert_profile(dedup_db)
        _set_pls(dedup_db, profile_id, prop_a, "rejected")
        _set_pls(dedup_db, profile_id, prop_b, "offer_made")
        assert engine.run(dedup_db).conflicts == 1

        with dedup_db.cursor() as cur:
            cur.execute("SELECT id FROM suggested_merge WHERE status = 'conflict'")
            (conflict_id,) = cur.fetchone()

        with pytest.raises(ValueError, match="resolve-conflict"):
            engine.confirm_suggestion(dedup_db, conflict_id)

        engine.resolve_conflict(dedup_db, conflict_id)
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, resolved_at FROM suggested_merge WHERE id = %s",
                (conflict_id,),
            )
            status, resolved_at = cur.fetchone()
            assert status == "rejected"
            assert resolved_at is not None

        # And it's out of the review queue for good.
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM suggested_merge "
                "WHERE status IN ('pending','conflict')"
            )
            assert cur.fetchone()[0] == 0

    def test_resolve_conflict_refuses_a_non_conflict_row(self, dedup_db):
        suggestion_id, *_ = self._file_one_suggestion(dedup_db)
        with pytest.raises(ValueError, match="not 'conflict'"):
            engine.resolve_conflict(dedup_db, suggestion_id)

    def test_unknown_suggestion_id_is_refused(self, dedup_db):
        with pytest.raises(ValueError, match="No suggested_merge row"):
            engine.confirm_suggestion(dedup_db, 999999)


class TestRecordedPairBatching:
    """Issue #61b: the skip check was one query per candidate pair."""

    def test_skip_check_costs_one_query_per_run_not_one_per_pair(self, dedup_db):
        """At 60 listings the old code issued 1770 SELECTs (60*59/2) just to
        ask 'have I seen this pair?'. Count them for real by wrapping the
        cursor, rather than asserting the code merely *looks* batched.

        Split across two sources (30/30), not all "idealista" as this test
        originally had it (issue #197 review): with a single source, every
        one of the 1770 candidate pairs is now same-source and skipped
        before ever reaching the recorded-pairs check this test is actually
        about, which would make `pairs_compared` assert 0 rather than
        testing the batching behaviour at all. C(60,2) = 1770 total pairs;
        C(30,2)*2 = 870 of those are same-source (skipped by issue #197's
        pair-generation filter, counted in same_source_skipped instead);
        the remaining 900 are the cross-source pairs this test's assertion
        below is about.
        """
        n = 60
        sources = ("idealista", "fotocasa")
        for i in range(n):
            prop = _insert_property(dedup_db, address=f"Calle Batch {i}")
            _insert_listing(dedup_db, prop, sources[i % 2], f"batch-{i}")
        dedup_db.commit()

        suggested_merge_selects = []

        class _CountingCursor:
            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql, params=None):
                if "FROM suggested_merge" in sql and sql.lstrip().upper().startswith(
                    "SELECT"
                ):
                    suggested_merge_selects.append(sql)
                return self._inner.execute(sql, params)

            def __getattr__(self, name):
                return getattr(self._inner, name)

            def __enter__(self):
                self._inner.__enter__()
                return self

            def __exit__(self, *exc):
                return self._inner.__exit__(*exc)

        class _CountingConnection:
            """psycopg2 connections don't allow attribute assignment, so wrap
            rather than monkeypatch `.cursor` onto the real connection."""

            def __init__(self, inner):
                self._inner = inner

            def cursor(self, *args, **kwargs):
                return _CountingCursor(self._inner.cursor(*args, **kwargs))

            def __getattr__(self, name):
                return getattr(self._inner, name)

        result = engine.run(_CountingConnection(dedup_db))

        total_pairs = n * (n - 1) // 2
        same_source_pairs = 2 * (n // 2) * (n // 2 - 1) // 2
        assert total_pairs == 1770
        assert same_source_pairs == 870
        assert result.same_source_skipped == same_source_pairs
        assert result.pairs_compared == total_pairs - same_source_pairs == 900
        assert len(suggested_merge_selects) == 1, (
            f"expected a single preload query, got {len(suggested_merge_selects)} "
            "— the per-pair skip check is back"
        )


class TestSameSourceFiltering:
    """Issue #197: 'in the same connector they wouldn't be duplicates, only
    if they come from different connectors ... a duplicate in the same
    connector would be really strange' (owner). The filter lives in
    engine.run()'s pair-generation loop, before evaluate_pair is ever
    called — these tests exercise it through run(), not evaluate_pair
    directly, since the whole point is that a same-source pair never
    reaches evaluate_pair at all.
    """

    def test_same_source_cadastral_match_is_never_merged_or_suggested(self, dedup_db):
        """Counterpart to TestCadastralExactMatch's cross-source auto-merge
        test: identical setup, same source both sides. Cadastral is called
        out explicitly in issue #197 ('applies to every signal including
        cadastral') — a definitive, always-merge-cross-source signal must
        still never fire same-source.
        """
        _insert_pair(
            dedup_db,
            "solvia",
            "solvia",
            "cadastral-same-source",
            cadastral_ref_a="3061226YH0036S0007SM",
            cadastral_ref_b="3061226YH0036S0007SM",
            address_a="Calle Mayor 1",
            address_b="C/ Mayor nº1, esc. 2",
            m2_built_a=Decimal(80),
            m2_built_b=Decimal(95),
            current_price_a=Decimal(230000),
            current_price_b=Decimal(219000),
        )
        result = engine.run(dedup_db)

        assert result.merged == 0
        assert result.suggested == 0
        assert result.same_source_skipped == 1
        assert result.same_source_cadastral_collisions == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT count(*) FROM property_merge_log")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT count(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 0

    def test_same_source_phone_match_is_never_merged_or_suggested(self, dedup_db):
        """Counterpart to TestPhoneSignal's corroborated-particular
        cross-source auto-merge test."""
        _insert_pair(
            dedup_db,
            "idealista",
            "idealista",
            "phone-same-source",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0
        assert result.same_source_skipped == 1

    def test_same_source_fuzzy_candidate_is_never_suggested(self, dedup_db):
        _insert_pair(
            dedup_db,
            "fotocasa",
            "fotocasa",
            "fuzzy-same-source",
            address_a="Calle Alcala 10, Madrid",
            address_b="Calle Alcala 10, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(72),
            current_price_a=Decimal(200000),
            current_price_b=Decimal(205000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0
        assert result.same_source_skipped == 1

    def test_cross_source_counterpart_of_same_fixture_still_matches(self, dedup_db):
        """Sanity check that the filter is source-keyed, not a blanket
        suppression: the same cadastral fixture shape as the test above,
        with two different sources, still auto-merges."""
        _insert_pair(
            dedup_db,
            "solvia",
            "servihabitat",
            "cadastral-cross-source-contrast",
            cadastral_ref_a="8061226YH0036S0007ZZ",
            cadastral_ref_b="8061226YH0036S0007ZZ",
            address_a="Calle Mayor 1",
            address_b="C/ Mayor nº1, esc. 2",
            m2_built_a=Decimal(80),
            m2_built_b=Decimal(95),
            current_price_a=Decimal(230000),
            current_price_b=Decimal(219000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.same_source_skipped == 0

    def test_pair_generation_drops_measurably_on_a_mixed_corpus(self, dedup_db):
        """Issue #197 acceptance: 'pair-generation cost drops measurably;
        state the before/after pair count.' Builds a 40-listing corpus (2
        sources, 20 each), no property already shared, so every one of
        C(40,2)=780 candidate pairs is a genuine pair-generation decision.
        'Before' (what the pre-#197 loop would have compared) is
        recoverable as pairs_compared + same_source_skipped, since the
        filter only removes iterations from the loop — it doesn't change
        anything else about which pairs exist. See the PR description for
        the real-corpus numbers this scales up to.
        """
        for i in range(40):
            source = "idealista" if i % 2 == 0 else "fotocasa"
            prop = _insert_property(dedup_db, address=f"Calle Corpus {i}")
            _insert_listing(dedup_db, prop, source, f"corpus-{i}")
        dedup_db.commit()

        result = engine.run(dedup_db)

        before = result.pairs_compared + result.same_source_skipped
        assert before == 40 * 39 // 2 == 780
        assert result.same_source_skipped == 2 * (20 * 19 // 2) == 380
        assert result.pairs_compared == 400


class TestPurgeSameSourcePending:
    """Issue #197's one-off migration: `engine.purge_same_source_pending`
    deletes existing `pending` suggested_merge rows whose two listings
    share a source, and nothing else.
    """

    def _seed_suggestion(
        self, conn, source_a: str, source_b: str, ext_prefix: str, status: str
    ) -> int:
        """Insert a suggested_merge row directly (bypassing engine.run(),
        which would never file a same-source suggestion post-#197) to
        simulate a row left over from before this change shipped."""
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            conn, source_a, source_b, ext_prefix
        )
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO suggested_merge
                    (listing_id_a, listing_id_b, match_basis, confidence, status)
                VALUES (%s, %s, 'fuzzy', 0.550, %s) RETURNING id
                """,
                (*sorted((listing_a, listing_b)), status),
            )
            suggestion_id = cur.fetchone()[0]
        conn.commit()
        return suggestion_id

    def test_purges_only_pending_same_source_rows(self, dedup_db):
        same_source_pending = self._seed_suggestion(
            dedup_db, "idealista", "idealista", "purge-same-pending", "pending"
        )
        same_source_confirmed = self._seed_suggestion(
            dedup_db, "idealista", "idealista", "purge-same-confirmed", "confirmed"
        )
        same_source_rejected = self._seed_suggestion(
            dedup_db, "fotocasa", "fotocasa", "purge-same-rejected", "rejected"
        )
        cross_source_pending = self._seed_suggestion(
            dedup_db, "idealista", "fotocasa", "purge-cross-pending", "pending"
        )

        deleted = engine.purge_same_source_pending(dedup_db)

        assert deleted == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT id FROM suggested_merge ORDER BY id")
            remaining = {row[0] for row in cur.fetchall()}
        assert remaining == {
            same_source_confirmed,
            same_source_rejected,
            cross_source_pending,
        }
        assert same_source_pending not in remaining

    def test_idempotent_second_run_deletes_nothing(self, dedup_db):
        self._seed_suggestion(
            dedup_db, "idealista", "idealista", "purge-idempotent", "pending"
        )
        first = engine.purge_same_source_pending(dedup_db)
        second = engine.purge_same_source_pending(dedup_db)
        assert first == 1
        assert second == 0

    def test_cli_purge_same_source_subcommand(self, dedup_db, monkeypatch, capsys):
        from etl.dedup import cli as dedup_cli

        self._seed_suggestion(
            dedup_db, "idealista", "idealista", "purge-cli", "pending"
        )

        class _NoCloseConnProxy:
            """Same reasoning as test_dedup_actions.py's own copy: cli.main()
            unconditionally closes whatever get_connection() hands it, but
            this test hands it the shared, function-scoped dedup_db fixture
            connection, which the fixture's own teardown still needs."""

            def __init__(self, conn):
                self._conn = conn

            def __getattr__(self, name):
                return getattr(self._conn, name)

            def close(self):
                pass

        monkeypatch.setattr(
            dedup_cli, "get_connection", lambda config: _NoCloseConnProxy(dedup_db)
        )
        exit_code = dedup_cli.main(["purge-same-source"])
        assert exit_code == 0
        captured = capsys.readouterr()
        assert "Purged 1" in captured.out


class TestAddressCoordsSignal:
    """No dedicated coverage existed for address_coords.evaluate's
    coords+size+address merge path before issue #186 added the floor veto
    — these tests cover both the pre-existing merge behaviour and the new
    veto together.
    """

    _LAT = Decimal("40.416775")
    _LON = Decimal("-3.703790")
    # A few meters away — inside the 15m coords_close gate.
    _LAT_NEAR = Decimal("40.416790")
    _LON_NEAR = Decimal("-3.703790")

    def test_matching_coords_size_address_and_no_floor_data_auto_merges(self, dedup_db):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "address-coords-merge",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT_NEAR,
            lon_b=self._LON_NEAR,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            # Deliberately far apart — address_coords doesn't gate on
            # price at all, only fuzzy does, and this signal must fire
            # before fuzzy is ever reached.
            current_price_a=Decimal(250000),
            current_price_b=Decimal(400000),
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis, confidence FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            basis, confidence = cur.fetchone()
            assert basis == "address_coords"
            assert confidence == Decimal("0.900")

    def test_conflicting_floor_vetoes_the_merge_and_demotes_to_a_weaker_suggestion(
        self, dedup_db
    ):
        """Issue #186's illustration, structurally: same building
        (coords+address match), different unit (floor disagrees). The
        merge is vetoed; because the address text is identical here,
        fuzzy's weaker bar still fires, so the pair isn't dropped outright
        — a human sees it as a suggestion with the floor conflict flagged
        in `detail`, exactly the "discriminating data... nothing read it"
        gap issue #186 describes, now read.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "address-coords-floor-veto",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT_NEAR,
            lon_b=self._LON_NEAR,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            floor_a="10º",
            floor_b="A partir de la 15ª planta",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis, confidence, detail FROM suggested_merge")
            basis, confidence, detail = cur.fetchone()
            assert basis == "fuzzy"
            assert confidence == Decimal("0.590")
            assert detail["floor_conflict"] is True

    def test_floors_agreeing_still_auto_merges(self, dedup_db):
        """Counterweight: the veto must fire on conflict, not on agreement."""
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "address-coords-floor-agree",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT_NEAR,
            lon_b=self._LON_NEAR,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(400000),
            floor_a="3º",
            floor_b="3ª planta",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0

    def test_floor_missing_on_one_side_does_not_block_the_merge(self, dedup_db):
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "address-coords-floor-absent",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT_NEAR,
            lon_b=self._LON_NEAR,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(400000),
            floor_a="10º",
            floor_b=None,
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0


class TestFloorCorroborationAcrossSignals:
    """Issue #186's core acceptance, exercised in-memory (ListingRecord via
    _record, no DB) against the corroboration helpers directly — the same
    style as TestCadastralExactMatch.test_cadastral_exact_match_merges.
    """

    def test_phone_corroboration_blocked_by_conflicting_floor(self):
        a = _record(
            1, 100, m2_built=Decimal(70), current_price=Decimal(285000), floor="10º"
        )
        b = _record(
            2,
            200,
            m2_built=Decimal(70),
            current_price=Decimal(279000),
            floor="A partir de la 15ª planta",
        )
        assert phone_extract._corroborated(a, b) is False

    def test_phone_corroboration_permits_absent_floor(self):
        a = _record(
            1, 100, m2_built=Decimal(70), current_price=Decimal(285000), floor="10º"
        )
        b = _record(
            2, 200, m2_built=Decimal(70), current_price=Decimal(279000), floor=None
        )
        assert phone_extract._corroborated(a, b) is True

    def test_phone_corroboration_permits_agreeing_floor(self):
        a = _record(
            1, 100, m2_built=Decimal(70), current_price=Decimal(285000), floor="3º"
        )
        b = _record(
            2,
            200,
            m2_built=Decimal(70),
            current_price=Decimal(279000),
            floor="3ª planta",
        )
        assert phone_extract._corroborated(a, b) is True

    def test_reference_code_proximity_corroboration_blocked_by_conflicting_floor(
        self,
    ):
        a = _record(
            1, 100, m2_built=Decimal(70), current_price=Decimal(285000), floor="Bajo"
        )
        b = _record(
            2,
            200,
            m2_built=Decimal(70),
            current_price=Decimal(279000),
            floor="Ático",
        )
        assert reference_code._proximity_corroborated(a, b) is False

    def test_reference_code_proximity_corroboration_permits_absent_floor(self):
        a = _record(
            1, 100, m2_built=Decimal(70), current_price=Decimal(285000), floor=None
        )
        b = _record(
            2, 200, m2_built=Decimal(70), current_price=Decimal(279000), floor="Ático"
        )
        assert reference_code._proximity_corroborated(a, b) is True

    def test_phone_corroborated_merge_is_blocked_by_db_backed_conflicting_floor(
        self, dedup_db
    ):
        """DB round-trip proof that engine.fetch_listing_records actually
        reads property.floor into ListingRecord.floor — the in-memory
        tests above exercise the corroboration helpers directly and can't
        catch a wiring bug in the SELECT/row-unpacking itself."""
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "phone-floor-veto-db",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b="particular",
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
            floor_a="10º",
            floor_b="A partir de la 15ª planta",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis, confidence FROM suggested_merge")
            basis, confidence = cur.fetchone()
            assert basis == "phone"
            assert confidence == Decimal("0.500")


class TestPhotoHashAutoMerge:
    """Issue #188 (approved once #197 removed same-source pairing):
    match_ratio == 1.0 + size/price tolerance + no floor conflict
    auto-merges; anything short of that stays a suggestion. Exercised via
    engine.evaluate_pair directly with a pre-populated _PhotoHashCache
    (real synthetic ImageHash values, distance controlled by construction)
    rather than through engine.run(), so no network fetch is ever
    attempted — same no-network split test_dedup_signals_photo_hash.py's
    own tests use.
    """

    _IDENTICAL_HEX = "ffff0000ffff0000"

    def _cache_with_identical_hashes(
        self, listing_id_a: int, listing_id_b: int
    ) -> _PhotoHashCache:
        cache = _PhotoHashCache()
        cache._cache[listing_id_a] = [imagehash.hex_to_hash(self._IDENTICAL_HEX)]
        cache._cache[listing_id_b] = [imagehash.hex_to_hash(self._IDENTICAL_HEX)]
        return cache

    def test_suggestion_197_shape_auto_merges(self):
        """The owner's own measured example: milanuncios 139m²/503.000€ vs
        fotocasa 145m²/503.000€ — 4.14% size gap (built-vs-useful m²
        across portals), identical price. Inside tolerance."""
        a = _record(
            1,
            100,
            source="milanuncios",
            m2_built=Decimal(139),
            current_price=Decimal(503000),
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            m2_built=Decimal(145),
            current_price=Decimal(503000),
        )
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation.basis == "photo_hash"
        assert evaluation.decision == "merge"
        assert evaluation.confidence == Decimal("0.900")

    def test_suggestion_412_shape_price_gap_within_tolerance_auto_merges(self):
        """58m² both sides, 170.000€ vs 169.000€ — 0.59% price gap (one
        portal a day stale). Inside the 2% price tolerance."""
        a = _record(
            1,
            100,
            source="fotocasa",
            m2_built=Decimal(58),
            current_price=Decimal(170000),
        )
        b = _record(
            2, 200, source="solvia", m2_built=Decimal(58), current_price=Decimal(169000)
        )
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation.decision == "merge"

    def test_size_gap_beyond_tolerance_stays_a_suggestion(self):
        a = _record(
            1,
            100,
            source="milanuncios",
            m2_built=Decimal(100),
            current_price=Decimal(200000),
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            m2_built=Decimal(120),
            current_price=Decimal(200000),
        )  # 16.7% apart — well past the 5% size tolerance
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation.basis == "photo_hash"
        assert evaluation.decision == "suggest"

    def test_price_gap_beyond_tolerance_stays_a_suggestion(self):
        a = _record(
            1,
            100,
            source="milanuncios",
            m2_built=Decimal(70),
            current_price=Decimal(200000),
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            m2_built=Decimal(70),
            current_price=Decimal(230000),
        )  # 13% apart — well past the 2% price tolerance
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation.decision == "suggest"

    def test_conflicting_floor_vetoes_the_auto_merge(self):
        """Suggestion 197's exact structural shape: identical photos and
        price, 6m² apart (within tolerance), floors "10º" vs "A partir de
        la 15ª planta" — the floor veto must win even though photo/size/
        price all clear the auto-merge bar."""
        a = _record(
            1,
            100,
            source="milanuncios",
            m2_built=Decimal(139),
            current_price=Decimal(503000),
            floor="10º",
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            m2_built=Decimal(145),
            current_price=Decimal(503000),
            floor="A partir de la 15ª planta",
        )
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation.basis == "photo_hash"
        assert evaluation.decision == "suggest"
        assert evaluation.detail["floor_conflict"] is True

    def test_agreeing_floor_does_not_block_the_auto_merge(self):
        a = _record(
            1,
            100,
            source="milanuncios",
            m2_built=Decimal(139),
            current_price=Decimal(503000),
            floor="3º",
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            m2_built=Decimal(145),
            current_price=Decimal(503000),
            floor="3ª planta",
        )
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation.decision == "merge"

    def test_partial_photo_overlap_never_auto_merges_even_with_matching_size_price(
        self,
    ):
        """match_ratio < 1.0 (not a full match) must never auto-merge
        regardless of size/price agreement — only an exact overlap does.
        Hex values chosen so the Hamming distance between any two distinct
        ones exceeds photo_hash._HASH_HAMMING_THRESHOLD (10): h1-h2=32,
        h1-h4=32, h2-h4=32 (verified independently), so hashes_a's h3
        genuinely has no match in hashes_b, giving matched=2/len(3)=0.667 —
        comfortably inside [MIN_MATCH_RATIO, 1.0) but not equal to 1.0.
        """
        h1 = imagehash.hex_to_hash("0000000000000000")
        h2 = imagehash.hex_to_hash("0f0f0f0f0f0f0f0f")
        h3 = imagehash.hex_to_hash("ffffffffffffffff")
        h4 = imagehash.hex_to_hash("5555555555555555")
        cache = _PhotoHashCache()
        cache._cache[1] = [h1, h2, h3]
        cache._cache[2] = [h1, h2, h4]

        a = _record(
            1,
            100,
            source="milanuncios",
            m2_built=Decimal(70),
            current_price=Decimal(200000),
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            m2_built=Decimal(70),
            current_price=Decimal(200000),
        )
        evaluation = engine.evaluate_pair(a, b, cache)
        assert evaluation.basis == "photo_hash"
        assert evaluation.detail["match_ratio"] == pytest.approx(2 / 3, abs=0.001)
        assert evaluation.decision == "suggest"
