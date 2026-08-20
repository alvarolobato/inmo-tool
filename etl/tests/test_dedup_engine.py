"""Tests for the deduplication engine (issue #16, Phase 2.2).

Integration tests against a real PostgreSQL instance (pg_conn fixture,
skipped if unavailable — same pattern as test_schema.py/test_orchestrator.py)
since the engine's whole job is what ends up persisted (merges, suggestions,
reconciled state), which mocking the database would not meaningfully test.
"""

from __future__ import annotations

import io
import json
import zlib
from decimal import Decimal
from pathlib import Path

import imagehash
import pytest
from PIL import Image

from etl import orchestrator
from etl.connectors import base
from etl.connectors.base import CanonicalListingVersion
from etl.dedup import engine
from etl.dedup.engine import _PhotoHashCache
from etl.dedup.signals import fuzzy, phone_extract, reference_code
from etl.dedup.signals import photo_hash as photo_hash_signal
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
            INSERT INTO property
                (cadastral_ref, address, lat, lon, m2_built, floor,
                 property_type, rooms)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                overrides.get("cadastral_ref"),
                overrides.get("address", "Calle Falsa 123"),
                overrides.get("lat"),
                overrides.get("lon"),
                overrides.get("m2_built"),
                overrides.get("floor"),
                overrides.get("property_type"),
                overrides.get("rooms"),
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
                 current_price, contact_raw, reference_code, operation,
                 photo_urls)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
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
                overrides.get("operation", "sale"),
                # Issue #206: needed by TestPhotoHashSourceHealth below to
                # seed real photo_urls that engine.run() actually fetches —
                # every other test in this file omits it (default ()),
                # matching the pre-#206 behaviour exactly.
                overrides.get("photo_urls", []),
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
        # Issue #221: the photo-hash store commits on its own connection, so
        # rows written by one test outlive that test's transaction. Left
        # behind, they'd turn a later test's intended live fetch into a store
        # hit — the tests here reuse URLs like `https://<host>/p0.jpg`.
        cur.execute("DELETE FROM photo_hashes")
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
        property_type=overrides.get("property_type"),
        rooms=overrides.get("rooms"),
    )


class TestFetchListingRecordsExcludesRentals:
    """Issue #31: `fetch_listing_records` must never feed an
    `operation='rent'` row into the pairwise matcher — see that function's
    own docstring for why (rentals are read in aggregate by
    rent-estimate.ts's own query, never resolved to a canonical property
    the way two sale listings are; matching one against a sale listing
    would risk a spurious cross-operation merge)."""

    def test_rent_listing_never_appears_in_fetched_records(self, dedup_db):
        sale_property = _insert_property(dedup_db, address="Calle Sale 1")
        sale_listing = _insert_listing(
            dedup_db, sale_property, "fotocasa", "sale-1", operation="sale"
        )
        rent_property = _insert_property(dedup_db, address="Calle Rent 1")
        _insert_listing(
            dedup_db, rent_property, "milanuncios_rental", "rent-1", operation="rent"
        )
        dedup_db.commit()

        records = engine.fetch_listing_records(dedup_db)
        listing_ids = {r.listing_id for r in records}

        assert sale_listing in listing_ids
        # The exact assertion this test exists for: a rent listing must be
        # structurally absent, not merely unmatched by any signal.
        assert not any(r.source == "milanuncios_rental" for r in records)

    def test_a_property_with_both_a_sale_and_a_rent_listing_only_surfaces_the_sale_one(
        self, dedup_db
    ):
        """Same real-world case rent-estimate.ts's module docstring flags
        as a risk: a physical unit that happens to be advertised for both
        sale and rent (or a merged property that ended up with one of
        each). Only the sale listing should ever reach the matcher."""
        shared_property = _insert_property(dedup_db, address="Calle Mixta 1")
        sale_listing = _insert_listing(
            dedup_db, shared_property, "fotocasa", "mixed-sale", operation="sale"
        )
        _insert_listing(
            dedup_db,
            shared_property,
            "milanuncios_rental",
            "mixed-rent",
            operation="rent",
        )
        dedup_db.commit()

        records = engine.fetch_listing_records(dedup_db)
        this_property_records = [r for r in records if r.property_id == shared_property]

        assert len(this_property_records) == 1
        assert this_property_records[0].listing_id == sale_listing


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
    def test_uncorroborated_phone_match_files_no_suggestion(self, dedup_db):
        """Issue #603 (D-129): previously a 0.500 suggestion — #600
        measured this exact tier as pure agency noise on the live corpus,
        so it's silenced (returns None) rather than tuned. Dissimilar
        addresses so fuzzy (still active pending issue #601) doesn't pick
        up what phone deliberately drops — this test is about phone alone.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "phone-uncorroborated",
            address_a="Calle Alcala 10, Madrid",
            address_b="Avenida Diagonal 200, Barcelona",
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
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 0

    def test_agency_phone_match_files_no_suggestion(self, dedup_db):
        """Issue #603 (D-129): previously a 0.500 suggestion regardless of
        corroboration. #600 measured 100% of the pending phone backlog as
        agency-sided — this tier is now silenced outright, not just
        blocked from auto-merging.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "agency-phone",
            address_a="Calle Alcala 10, Madrid",
            address_b="Avenida Diagonal 200, Barcelona",
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
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 0

    def test_particular_phone_match_requires_corroboration_to_merge(self, dedup_db):
        # Corroborated: matching size/price proximity -> auto-merge (unchanged).
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

        # Not corroborated: same phone, wildly different price/size, and
        # dissimilar addresses -> issue #603 silences phone entirely; no
        # suggestion is filed for this pair by any basis.
        _insert_pair(
            dedup_db,
            "idealista",
            "milanuncios",
            "particular-uncorroborated",
            address_a="Calle Serrano 50, Madrid",
            address_b="Paseo de Gracia 12, Barcelona",
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
        assert result2.suggested == 0
        with dedup_db.cursor() as cur:
            # Zero phone suggestion rows: the corroborated pair above went
            # straight to property_merge_log (a merge, not a suggestion),
            # and this uncorroborated pair is silenced outright.
            cur.execute(
                "SELECT COUNT(*) FROM suggested_merge WHERE match_basis = 'phone'"
            )
            assert cur.fetchone()[0] == 0

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


class TestPhoneOrderingRescue:
    """Issue #603 (D-129): photo_hash now runs BEFORE phone in
    `evaluate_pair`. #600 measured 19 of the 320 pending phone rows on the
    live corpus as pairs that ALSO carried a photo-ratio >= 0.6 match
    (mostly 1.0, identical price/m2/description) — with the old order,
    phone's own tier claimed the pair first and shadowed that stronger
    evidence, freezing it at a weak/silenced phone verdict forever.

    Uses `engine.evaluate_pair` directly with a pre-populated
    `_PhotoHashCache` (same no-network pattern as
    `TestPhotoHashAutoMerge`), not `engine.run()` — no network fetch is
    ever attempted.
    """

    _IDENTICAL_HEX = "ffff0000ffff0000"

    def _cache_with_identical_hashes(
        self, listing_id_a: int, listing_id_b: int
    ) -> _PhotoHashCache:
        cache = _PhotoHashCache()
        cache._cache[listing_id_a] = [imagehash.hex_to_hash(self._IDENTICAL_HEX)]
        cache._cache[listing_id_b] = [imagehash.hex_to_hash(self._IDENTICAL_HEX)]
        return cache

    def test_ordering_lets_photo_hash_claim_a_pair_phone_would_otherwise_shadow(self):
        """Isolates the REORDER specifically (not the silencing): uses
        phone's SURVIVING corroborated-unconfirmed-kind tier (0.750
        suggest, untouched by issue #603's silencing) so this pair would
        still generate a phone-basis verdict under the OLD evaluate_pair
        order — reverting only the reorder (leaving the silencing intact)
        must turn this test red, because phone's 0.750 tier alone would
        then run first and shadow photo_hash's stronger 0.900 merge.
        """
        shared_description = "Piso reformado, tel 622334455"
        a = _record(
            1,
            100,
            source="idealista",
            listing_kind="particular",
            description=shared_description,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            listing_kind=None,  # unconfirmed — phone's 0.750 tier applies
            description=shared_description,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )

        # Own the precondition: phone alone, evaluated in isolation, DOES
        # fire for this pair (confirms the shadow risk is real, not
        # incidental to this fixture).
        phone_only = phone_extract.evaluate(a, b)
        assert phone_only is not None
        assert phone_only.decision == "suggest"
        assert phone_only.confidence == Decimal("0.750")

        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation is not None
        assert evaluation.basis == "photo_hash"
        assert evaluation.decision == "merge"
        assert evaluation.confidence == Decimal("0.900")

    def test_agency_sided_shadow_shape_from_600_now_resolves_via_photo_hash(self):
        """The production shape #600 actually measured: an agency-sided
        shared phone (which, per issue #603's silencing, contributes
        nothing on its own — see TestPhoneSignal.
        test_agency_phone_match_files_no_suggestion) alongside a full
        photo match. photo_hash resolves it outright rather than the pair
        going unmatched.
        """
        shared_description = "Piso reformado, tel 622334455"
        a = _record(
            1,
            100,
            source="idealista",
            listing_kind="agency",
            description=shared_description,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )
        b = _record(
            2,
            200,
            source="fotocasa",
            listing_kind="particular",
            description=shared_description,
            m2_built=Decimal(70),
            current_price=Decimal(285000),
        )
        assert phone_extract.evaluate(a, b) is None  # silenced on its own

        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation is not None
        assert evaluation.basis == "photo_hash"
        assert evaluation.decision == "merge"


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


class TestReferenceCodeConflictVeto:
    """Issue #564 (D-116): a same-agency pair whose reference codes both
    normalize to real, DIFFERING values is a hard veto — no merge, no
    suggestion, regardless of which other signal would otherwise fire
    (except `cadastral`). Mirrors TestFloorCorroborationAcrossSignals'
    split: in-memory `evaluate_pair` coverage, then a DB round trip for
    the D-024 pending-reevaluation / already-merged behaviour."""

    _LAT = Decimal("40.416775")
    _LON = Decimal("-3.703790")
    _IDENTICAL_HEX = "ffff0000ffff0000"

    def _cache_with_identical_hashes(
        self, listing_id_a: int, listing_id_b: int
    ) -> _PhotoHashCache:
        cache = _PhotoHashCache()
        cache._cache[listing_id_a] = [imagehash.hex_to_hash(self._IDENTICAL_HEX)]
        cache._cache[listing_id_b] = [imagehash.hex_to_hash(self._IDENTICAL_HEX)]
        return cache

    def test_same_agency_different_codes_blocks_merge_despite_full_agreement(self):
        """The module docstring's own worst case: same building, same
        agency, same photographer, adjacent units. Address, coordinates,
        size, price and photo hash all agree — the veto must still win,
        checked directly against evaluate_pair (engine-level, not just the
        signal)."""
        a = _record(
            1,
            100,
            source="fotocasa",
            address="Calle Mayor 5",
            lat=self._LAT,
            lon=self._LON,
            m2_built=Decimal(70),
            current_price=Decimal(250000),
            contact_raw="Inmobiliaria Sevilla 2000",
            reference_code="NS603",
        )
        b = _record(
            2,
            200,
            source="idealista",
            address="Calle Mayor 5",
            lat=self._LAT,
            lon=self._LON,
            m2_built=Decimal(70),
            current_price=Decimal(250000),
            contact_raw="INMOBILIARIA SEVILLA 2000",
            reference_code="AB100",
        )
        evaluation = engine.evaluate_pair(a, b, self._cache_with_identical_hashes(1, 2))
        assert evaluation is None

    def test_cadastral_match_is_exempt_from_the_veto(self):
        """A cadastral reference is a government registry ID, not agency
        bookkeeping — cadastral.evaluate runs (and wins) before the veto
        is even checked."""
        a = _record(
            1,
            100,
            cadastral_ref="3061226YH0036S0007SM",
            contact_raw="Inmobiliaria Sevilla 2000",
            reference_code="NS603",
        )
        b = _record(
            2,
            200,
            cadastral_ref="3061226YH0036S0007SM",
            contact_raw="INMOBILIARIA SEVILLA 2000",
            reference_code="AB100",
        )
        evaluation = engine.evaluate_pair(a, b, _PhotoHashCache())
        assert evaluation.basis == "cadastral"
        assert evaluation.decision == "merge"

    def test_cross_portal_same_agency_different_codes_blocks_merge_db_backed(
        self, dedup_db
    ):
        """The high-value case the owner flagged: one agency syndicating
        the SAME contact_raw to Fotocasa and Idealista under two different
        internal refs — two different flats, not a dedup target."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "refcode-veto-cross-portal",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT,
            lon_b=self._LON,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            contact_raw_a="Inmobiliaria Sevilla 2000",
            contact_raw_b="INMOBILIARIA SEVILLA 2000",
            reference_code_a="NS603",
            reference_code_b="AB100",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0

    def test_different_agencies_different_codes_does_not_veto_address_coords_merge(
        self, dedup_db
    ):
        """Different agencies + different codes means nothing (codes are
        agency-namespaced) — the veto must not fire, so address_coords
        merges exactly as it did before this change."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "refcode-different-agencies-unchanged",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT,
            lon_b=self._LON,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(400000),
            contact_raw_a="Inmobiliaria Uno",
            contact_raw_b="Inmobiliaria Dos",
            reference_code_a="NS603",
            reference_code_b="AB100",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            assert cur.fetchone()[0] == "address_coords"

    def test_placeholder_code_never_vetoes_same_agency_merge(self, dedup_db):
        """A CRM template default ("REF") left on one side must be treated
        as absent, never as "differing" — otherwise it would block every
        legitimate merge for that agency."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "refcode-placeholder-never-vetoes",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT,
            lon_b=self._LON,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(400000),
            contact_raw_a="Inmobiliaria Sevilla 2000",
            contact_raw_b="INMOBILIARIA SEVILLA 2000",
            reference_code_a="NS603",
            reference_code_b="REF",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0

    def test_existing_pending_suggestion_is_demoted_to_rejected_on_reevaluation(
        self, dedup_db
    ):
        """D-024: pending suggestions are re-evaluated every run, not
        frozen. A suggestion filed under the old rules (e.g. on
        address_coords, before this veto existed) must be demoted to
        'rejected' now that the same-agency reference conflict makes
        evaluate_pair return no match at all — the same mechanism issue
        #186's floor veto already exercises for this exact case."""
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "refcode-veto-pending-demoted",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT,
            lon_b=self._LON,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(400000),
            contact_raw_a="Inmobiliaria Sevilla 2000",
            contact_raw_b="INMOBILIARIA SEVILLA 2000",
            reference_code_a="NS603",
            reference_code_b="AB100",
        )
        lo, hi = sorted((listing_a, listing_b))
        with dedup_db.cursor() as cur:
            cur.execute(
                """
                INSERT INTO suggested_merge
                    (listing_id_a, listing_id_b, match_basis, confidence, status, detail)
                VALUES (%s, %s, 'address_coords', 0.900, 'pending', %s)
                """,
                (lo, hi, json.dumps({})),
            )
        dedup_db.commit()

        result = engine.run(dedup_db)

        assert result.merged == 0
        assert result.reevaluated_rejected == 1
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, detail FROM suggested_merge "
                "WHERE listing_id_a = %s AND listing_id_b = %s",
                (lo, hi),
            )
            status, detail = cur.fetchone()
            assert status == "rejected"
            assert "reevaluated_from" in detail

    def test_already_merged_property_is_not_automatically_unmerged(self, dedup_db):
        """This landing does not retroactively split a property merged
        before the veto existed — run()'s pairwise loop only evaluates
        listings that don't already share a property_id (see D-116's
        decision record for why an automatic unmerge is out of scope)."""
        listing_a, prop_a, listing_b, _prop_b = _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "refcode-veto-already-merged",
            contact_raw_a="Inmobiliaria Sevilla 2000",
            contact_raw_b="INMOBILIARIA SEVILLA 2000",
            reference_code_a="NS603",
            reference_code_b="AB100",
        )
        # Simulate a merge performed before this veto existed.
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET property_id = %s WHERE id = %s",
                (prop_a, listing_b),
            )
        dedup_db.commit()

        result = engine.run(dedup_db)

        assert result.merged == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert [row[0] for row in cur.fetchall()] == [prop_a]


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
        """A second run against unchanged data must not create a *second*
        row for the same pair (the batching change, #61, must not regress
        this) — but issue #214 means it's no longer a silent no-op either:
        the row is re-evaluated and refreshed in place, just landing on the
        same verdict since nothing about the pair or the rules changed."""
        suggestion_id, *_ = self._file_one_suggestion(dedup_db)
        result = engine.run(dedup_db)
        assert result.suggested == 0
        assert result.merged == 0
        # Issue #214: re-evaluated, not skipped — but the verdict didn't
        # change (same data, same rules), so it's the "still pending,
        # refreshed" bucket, not merged or rejected.
        assert result.reevaluated_total == 1
        assert result.reevaluated_updated == 1
        assert result.reevaluated_merged == 0
        assert result.reevaluated_rejected == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 1
            cur.execute(
                "SELECT status, detail FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            status, detail = cur.fetchone()
            assert status == "pending"
            # Refreshed, and the refresh is auditable — a `reevaluated_from`
            # key distinguishes an engine re-score from a human decision.
            assert "reevaluated_from" in detail

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


class TestPendingSuggestionReevaluation:
    """Issue #214: a `pending` `suggested_merge` row used to be frozen the
    moment it was filed — `_load_recorded_pairs` treated it exactly like
    `rejected`/`conflict` and the main loop skipped it forever, no matter
    how much `evaluate_pair`'s rules changed underneath it. These tests
    exercise the fix through `engine.run()` end to end (real DB round
    trip), each one changing an actual rule between two runs and asserting
    the *outcome* changes — not just that some field got touched.
    """

    def test_pending_reevaluated_to_merged_when_a_veto_rule_is_lifted(self, dedup_db):
        """A phone match corroborated on price/size proximity, but with one
        side's `listing_kind` unconfirmed (`None`) — phone_extract's
        surviving 0.750 corroborated-unconfirmed-kind tier (issue #603/
        D-129 silenced the uncorroborated and agency tiers, but left this
        one alone), filed as a `pending` suggestion.

        Simulates #214's real-world trigger (new information making a
        previously-uncertain pair mergeable) with a real DB state change —
        a later connector sweep confirming the second listing's kind as
        'particular' — rather than a monkeypatch, then re-running. Under
        the pre-#214 code this pending row would never be looked at again;
        under the fix it's re-scored, both sides now read 'particular',
        and the pair auto-merges.
        """
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reeval-merge",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b=None,
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
        )

        first = engine.run(dedup_db)
        assert first.suggested == 1
        assert first.merged == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT id, match_basis, confidence, status FROM suggested_merge"
            )
            suggestion_id, basis, confidence, status = cur.fetchone()
            assert (basis, confidence, status) == ("phone", Decimal("0.750"), "pending")

        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET listing_kind = 'particular' WHERE id = %s",
                (listing_b,),
            )
        dedup_db.commit()

        second = engine.run(dedup_db)

        assert second.suggested == 0
        assert second.merged == 1
        assert second.reevaluated_total == 1
        assert second.reevaluated_merged == 1
        assert second.reevaluated_rejected == 0
        assert second.reevaluated_updated == 0

        with dedup_db.cursor() as cur:
            # A real merge happened — both listings now share a property.
            cur.execute(
                "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert len(cur.fetchall()) == 1

            # The *original* row was resolved in place, not superseded by a
            # second row — the pair is unique, so a fresh INSERT would have
            # violated idx_suggested_merge_pair; this asserts the update
            # path was actually taken.
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 1

            cur.execute(
                "SELECT status, match_basis, confidence, resolved_at, detail "
                "FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            status, basis, confidence, resolved_at, detail = cur.fetchone()
            assert status == "confirmed"
            assert basis == "phone"
            assert confidence == Decimal("0.900")
            assert resolved_at is not None
            # Auditable: what it used to say, and that the engine (not a
            # human) is what changed it.
            assert detail["reevaluated_from"]["confidence"] == 0.75
            assert detail["reevaluated_from"]["status"] == "pending"
            assert "auto_confirmed_merge" in detail
            assert "confirmed_merge" not in detail  # that key is confirm_suggestion's

    def test_pending_reevaluated_to_rejected_when_no_signal_fires_any_more(
        self, dedup_db
    ):
        """The other acceptance direction: re-evaluation must also be able
        to move a pair OUT of the queue, not just into a merge. Files a
        `fuzzy`-basis suggestion (identical address text, price/size within
        tolerance, nothing stronger available), then tightens
        `fuzzy._MIN_TEXT_SIMILARITY` past what any two strings could ever
        score — the direct analogue of the #186 floor-veto acceptance case:
        a rule change makes the pair fail every signal, and a pending row
        that fails every signal has nothing left supporting it, so it
        becomes `rejected` rather than sitting in the queue forever.
        """
        listing_a, prop_a, listing_b, prop_b = _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reeval-reject",
            address_a="Calle Alcala 10, Madrid",
            address_b="Calle Alcala 10, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(72),
            current_price_a=Decimal(200000),
            current_price_b=Decimal(205000),
        )

        first = engine.run(dedup_db)
        assert first.suggested == 1
        assert first.merged == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT id, match_basis, status FROM suggested_merge")
            suggestion_id, basis, status = cur.fetchone()
            assert (basis, status) == ("fuzzy", "pending")

        with pytest.MonkeyPatch.context() as mp:
            # No real address-text similarity score can reach 1.5 — this is
            # "the rule got strict enough that nothing clears it any more",
            # not a data change.
            mp.setattr(fuzzy, "_MIN_TEXT_SIMILARITY", 1.5)
            second = engine.run(dedup_db)

        assert second.suggested == 0
        assert second.merged == 0
        assert second.reevaluated_total == 1
        assert second.reevaluated_rejected == 1
        assert second.reevaluated_merged == 0
        assert second.reevaluated_updated == 0

        with dedup_db.cursor() as cur:
            # Never merged — listings stay on their own separate properties.
            cur.execute(
                "SELECT DISTINCT property_id FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert {row[0] for row in cur.fetchall()} == {prop_a, prop_b}

            cur.execute(
                "SELECT status, resolved_at, detail FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            status, resolved_at, detail = cur.fetchone()
            assert status == "rejected"
            assert resolved_at is not None
            assert detail["reevaluated_from"]["match_basis"] == "fuzzy"
            assert "reevaluated_reason" in detail

    def test_pending_still_pending_when_nothing_about_it_changed(self, dedup_db):
        """Baseline: unchanged data + unchanged rules re-scores to the same
        verdict — `TestSuggestionResolution.
        test_pending_suggestion_is_not_refiled_on_the_next_run` covers this
        through the reference_code fixture; this one pins the same
        invariant through the fuzzy signal, which is the one every one of
        this class's two acceptance tests above mutates a rule on, so it's
        worth also seeing it do nothing when no rule moves.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reeval-noop",
            address_a="Calle Alcala 10, Madrid",
            address_b="Calle Alcala 10, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(72),
            current_price_a=Decimal(200000),
            current_price_b=Decimal(205000),
        )
        engine.run(dedup_db)
        second = engine.run(dedup_db)
        assert second.reevaluated_total == 1
        assert second.reevaluated_updated == 1
        assert second.reevaluated_merged == 0
        assert second.reevaluated_rejected == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT status FROM suggested_merge")
            assert cur.fetchone()[0] == "pending"

    def test_pending_with_an_in_flight_action_is_left_alone(self, dedup_db):
        """Issue #214's answer to "what about a suggestion a human has
        already looked at but not acted on yet": there is no `viewed_at`/
        session concept anywhere in this schema, so this run cannot know a
        human is *staring* at a suggestion. What it *can* know is that a
        human already clicked confirm/reject a moment ago and the resulting
        `suggested_merge_action` row hasn't been drained by
        `etl.dedup.actions.run_action_poll_loop` yet — reevaluating (and
        potentially rejecting) the suggestion underneath that in-flight
        decision would race it. This suggestion must come out completely
        untouched while the action is still `pending`, and get picked up
        normally once it no longer is.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "reeval-inflight",
            address_a="Calle Alcala 10, Madrid",
            address_b="Calle Alcala 10, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(72),
            current_price_a=Decimal(200000),
            current_price_b=Decimal(205000),
        )
        engine.run(dedup_db)
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT id, match_basis, confidence, detail FROM suggested_merge"
            )
            suggestion_id, basis_before, confidence_before, _detail_before = (
                cur.fetchone()
            )
            cur.execute(
                "INSERT INTO suggested_merge_action (suggestion_id, action) "
                "VALUES (%s, 'confirm')",
                (suggestion_id,),
            )
        dedup_db.commit()

        with pytest.MonkeyPatch.context() as mp:
            # Even a rule change that would otherwise reject this pair must
            # not touch it while an action is in flight.
            mp.setattr(fuzzy, "_MIN_TEXT_SIMILARITY", 1.5)
            result = engine.run(dedup_db)

        assert result.reevaluated_total == 0
        assert result.pairs_compared == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis, confidence, status, detail "
                "FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            basis_after, confidence_after, status_after, detail_after = cur.fetchone()
            assert (basis_after, confidence_after) == (basis_before, confidence_before)
            assert status_after == "pending"
            assert "reevaluated_from" not in detail_after

        # Once the action is no longer pending (drained by the poll loop,
        # successfully or not), a normal run reevaluates it again.
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE suggested_merge_action SET status = 'done' "
                "WHERE suggestion_id = %s",
                (suggestion_id,),
            )
        dedup_db.commit()

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(fuzzy, "_MIN_TEXT_SIMILARITY", 1.5)
            result = engine.run(dedup_db)

        assert result.reevaluated_total == 1
        assert result.reevaluated_rejected == 1


class TestSamePropertyPendingResolution:
    """Issue #604: a `pending` suggested_merge row whose two listings
    already share a property_id — because a DIFFERENT pair's merge
    unified them, not a merge of this pair itself — used to be
    permanently invisible to reevaluation. `_run`'s
    `a.property_id == b.property_id` skip ran BEFORE `pending_by_pair` was
    ever consulted, so this exact shape of row could never leave `pending`
    no matter how many runs happened (71 stale rows measured on the live
    corpus — #600).

    These tests seed that state directly (a pending suggestion for (A, B),
    then a manual `UPDATE listing SET property_id` pointing B at A's
    property — standing in for "a third listing's merge pulled B onto A's
    property") rather than orchestrating a second real merge through
    `evaluate_pair`. That keeps the fixture owning its exact precondition
    (a `pending` row + two listings already on one property) instead of
    hoping a chain of signals produces it — the shape this bug needs to
    reproduce, made explicit rather than incidental.
    """

    def _seed_pending_pair(self, conn, source_a, source_b, ext_prefix, **kwargs):
        listing_a, prop_a, listing_b, prop_b = _insert_pair(
            conn, source_a, source_b, ext_prefix, **kwargs
        )
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO suggested_merge
                    (listing_id_a, listing_id_b, match_basis, confidence, status)
                VALUES (%s, %s, 'photo_hash', 0.700, 'pending') RETURNING id
                """,
                sorted((listing_a, listing_b)),
            )
            suggestion_id = cur.fetchone()[0]
        conn.commit()
        return listing_a, prop_a, listing_b, prop_b, suggestion_id

    def test_resolves_pending_suggestion_whose_listings_were_unified_by_a_different_merge(
        self, dedup_db
    ):
        listing_a, prop_a, listing_b, _prop_b, suggestion_id = self._seed_pending_pair(
            dedup_db, "idealista", "fotocasa", "same-prop-604"
        )

        # Simulate the bug's real trigger: a third listing's merge folded
        # B's property onto A's — never a merge of THIS pair directly.
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET property_id = %s WHERE id = %s",
                (prop_a, listing_b),
            )
        dedup_db.commit()

        # Own the precondition before asserting anything about what
        # run() does with it: this row really is the exact stale shape
        # #600 measured — pending, but its two listings already share a
        # property.
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
            )
            assert cur.fetchone()[0] == "pending"
            cur.execute(
                "SELECT COUNT(DISTINCT property_id) FROM listing WHERE id IN (%s, %s)",
                (listing_a, listing_b),
            )
            assert cur.fetchone()[0] == 1

        result = engine.run(dedup_db)

        assert result.same_property_pending_resolved == 1
        assert result.merged == 0
        assert result.pairs_compared == 0  # never reaches evaluate_pair

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, resolved_at, detail FROM suggested_merge WHERE id = %s",
                (suggestion_id,),
            )
            status, resolved_at, detail = cur.fetchone()
            assert status == "confirmed"
            assert resolved_at is not None
            assert detail["resolved_reason"] == "listings already unified"
            assert detail["reevaluated_from"]["status"] == "pending"
            assert detail["reevaluated_from"]["match_basis"] == "photo_hash"

            # No new merge was performed — nothing to log.
            cur.execute("SELECT COUNT(*) FROM property_merge_log")
            assert cur.fetchone()[0] == 0
            # And no second row was created for the pair either.
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 1

    def test_second_run_is_a_no_op_once_resolved(self, dedup_db):
        """Idempotency: once resolved to `confirmed`, `_load_recorded_pairs`
        excludes the row entirely (its own `WHERE status <> 'confirmed'`),
        so a second run must neither touch it again nor recount it.
        """
        _listing_a, prop_a, listing_b, _prop_b, suggestion_id = self._seed_pending_pair(
            dedup_db, "idealista", "fotocasa", "same-prop-604-idem"
        )
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET property_id = %s WHERE id = %s",
                (prop_a, listing_b),
            )
        dedup_db.commit()

        first = engine.run(dedup_db)
        assert first.same_property_pending_resolved == 1

        second = engine.run(dedup_db)
        assert second.same_property_pending_resolved == 0
        assert second.pairs_compared == 0

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
            )
            assert cur.fetchone()[0] == "confirmed"

    def test_different_property_pending_row_reevaluates_independently(self, dedup_db):
        """Regression guard: the new same-property short-circuit must not
        interfere with the pre-existing issue #214 reevaluation path for a
        pending row whose two listings genuinely still sit on different
        properties — both mechanisms must coexist across runs without
        either swallowing the other.
        """
        _la, prop_a, lb, _pb, same_prop_suggestion_id = self._seed_pending_pair(
            dedup_db, "idealista", "fotocasa", "same-prop-604-mixed-a"
        )
        with dedup_db.cursor() as cur:
            cur.execute(
                "UPDATE listing SET property_id = %s WHERE id = %s", (prop_a, lb)
            )
        dedup_db.commit()

        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "same-prop-604-mixed-b",
            address_a="Calle Alcala 10, Madrid",
            address_b="Calle Alcala 10, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(72),
            current_price_a=Decimal(200000),
            current_price_b=Decimal(205000),
        )

        first = engine.run(dedup_db)
        assert first.same_property_pending_resolved == 1
        assert first.suggested == 1  # the fresh fuzzy pair, filed for the first time
        assert first.reevaluated_total == 0  # nothing pre-existing to reevaluate yet

        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status FROM suggested_merge WHERE id = %s",
                (same_prop_suggestion_id,),
            )
            assert cur.fetchone()[0] == "confirmed"

        second = engine.run(dedup_db)
        # Already confirmed and excluded by _load_recorded_pairs — nothing
        # left for the #604 path to do.
        assert second.same_property_pending_resolved == 0
        # The fuzzy pair, now pending from run 1, goes through the
        # pre-existing #214 path unaffected.
        assert second.reevaluated_total == 1
        assert second.reevaluated_updated == 1


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


class TestPurgePendingPhone:
    """Issue #603's one-off migration: `engine.purge_pending_phone` deletes
    remaining `pending` `match_basis='phone'` suggested_merge rows, and
    nothing else."""

    def _seed_suggestion(
        self, conn, ext_prefix: str, status: str, match_basis: str = "phone"
    ) -> int:
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            conn, "idealista", "fotocasa", ext_prefix
        )
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO suggested_merge
                    (listing_id_a, listing_id_b, match_basis, confidence, status)
                VALUES (%s, %s, %s, 0.500, %s) RETURNING id
                """,
                (*sorted((listing_a, listing_b)), match_basis, status),
            )
            suggestion_id = cur.fetchone()[0]
        conn.commit()
        return suggestion_id

    def test_purges_only_pending_phone_rows(self, dedup_db):
        phone_pending = self._seed_suggestion(
            dedup_db, "purge-phone-pending", "pending"
        )
        phone_confirmed = self._seed_suggestion(
            dedup_db, "purge-phone-confirmed", "confirmed"
        )
        phone_rejected = self._seed_suggestion(
            dedup_db, "purge-phone-rejected", "rejected"
        )
        other_basis_pending = self._seed_suggestion(
            dedup_db, "purge-phone-other-basis", "pending", match_basis="fuzzy"
        )

        deleted = engine.purge_pending_phone(dedup_db)

        assert deleted == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT id FROM suggested_merge ORDER BY id")
            remaining = {row[0] for row in cur.fetchall()}
        assert remaining == {phone_confirmed, phone_rejected, other_basis_pending}
        assert phone_pending not in remaining

    def test_idempotent_second_run_deletes_nothing(self, dedup_db):
        self._seed_suggestion(dedup_db, "purge-phone-idempotent", "pending")
        first = engine.purge_pending_phone(dedup_db)
        second = engine.purge_pending_phone(dedup_db)
        assert first == 1
        assert second == 0

    def test_cli_purge_phone_subcommand(self, dedup_db, monkeypatch, capsys):
        from etl.dedup import cli as dedup_cli

        self._seed_suggestion(dedup_db, "purge-phone-cli", "pending")

        class _NoCloseConnProxy:
            """Same reasoning as TestPurgeSameSourcePending's own copy."""

            def __init__(self, conn):
                self._conn = conn

            def __getattr__(self, name):
                return getattr(self._conn, name)

            def close(self):
                pass

        monkeypatch.setattr(
            dedup_cli, "get_connection", lambda config: _NoCloseConnProxy(dedup_db)
        )
        exit_code = dedup_cli.main(["purge-phone"])
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
        catch a wiring bug in the SELECT/row-unpacking itself.

        Uses phone's surviving corroborated-unconfirmed-kind tier (0.750,
        untouched by issue #603's silencing) rather than the retired
        uncorroborated tier: if `property.floor` were NOT actually wired
        through (floor reads back as None on both sides), the floor veto
        would never fire, corroboration would succeed via the price/size
        fallback, and this pair WOULD file a 0.750 suggestion. Dissimilar
        addresses keep fuzzy (still active pending issue #601) from
        picking up what the floor veto is meant to block.
        """
        _insert_pair(
            dedup_db,
            "idealista",
            "fotocasa",
            "phone-floor-veto-db",
            address_a="Calle Alcala 10, Madrid",
            address_b="Avenida Diagonal 200, Barcelona",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            listing_kind_a="particular",
            listing_kind_b=None,
            description_a="Piso reformado, tel 622334455",
            description_b="Piso reformado, tel 622334455",
            current_price_a=Decimal(285000),
            current_price_b=Decimal(279000),
            floor_a="10º",
            floor_b="A partir de la 15ª planta",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM suggested_merge")
            assert cur.fetchone()[0] == 0


class TestStructuredFieldsFuzzyVeto:
    """Issue #566: a `property_type`/`rooms` contradiction vetoes a `fuzzy`
    suggestion outright — scoped to that ONE signal, not wired into
    evaluate_pair ahead of every signal, because the live-DB blast-radius
    measurement (below) found those fields are noisy per-connector
    metadata that regularly disagree even on definite, strongly-
    corroborated duplicates matched by address_coords/reference_code/
    photo_hash. See etl/dedup/signals/fuzzy.py and structured_fields.py's
    module docstrings for the full reasoning."""

    _LAT = Decimal("40.416775")
    _LON = Decimal("-3.703790")

    def test_fuzzy_suggestion_vetoed_by_property_type_conflict(self, dedup_db):
        """A weak, address-text-only match (no coordinates, so
        address_coords never fires) that agrees on price/size but
        genuinely disagrees on property_type must not be suggested."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-type-conflict-vetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            property_type_a="piso",
            property_type_b="local",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0

    def test_fuzzy_suggestion_vetoed_by_rooms_diff_of_two(self, dedup_db):
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-rooms-conflict-vetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            rooms_a=2,
            rooms_b=5,
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 0

    def test_fuzzy_suggestion_not_vetoed_by_rooms_diff_of_one(self, dedup_db):
        """The deliberate tolerance: a 1-room difference must not block a
        fuzzy suggestion from being filed."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-rooms-diff-one-unvetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            rooms_a=2,
            rooms_b=3,
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis FROM suggested_merge")
            assert cur.fetchone()[0] == "fuzzy"

    def test_fuzzy_suggestion_not_vetoed_by_piso_atico_synonym(self, dedup_db):
        """The main risk this issue flagged: property_type is already
        canonicalized at connector ingestion, but piso/atico is a genuine
        floor-position synonym pair (verified against the live demo DB
        backlog) and must not veto a fuzzy suggestion."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-piso-atico-synonym-unvetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            property_type_a="piso",
            property_type_b="atico",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1

    def test_fuzzy_suggestion_not_vetoed_by_missing_type_or_rooms(self, dedup_db):
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-missing-fields-unvetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            property_type_a="piso",
            property_type_b=None,
            rooms_a=2,
            rooms_b=None,
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1

    def test_existing_pending_fuzzy_suggestion_is_demoted_to_rejected(self, dedup_db):
        """D-024: pending suggestions are re-evaluated every run. A `fuzzy`
        suggestion filed before this veto existed must be demoted to
        'rejected' now that the type conflict makes fuzzy.evaluate (and so
        evaluate_pair) return no match at all."""
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-veto-pending-demoted",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            property_type_a="piso",
            property_type_b="nave",
        )
        lo, hi = sorted((listing_a, listing_b))
        with dedup_db.cursor() as cur:
            cur.execute(
                """
                INSERT INTO suggested_merge
                    (listing_id_a, listing_id_b, match_basis, confidence, status, detail)
                VALUES (%s, %s, 'fuzzy', 0.590, 'pending', %s)
                """,
                (lo, hi, json.dumps({})),
            )
        dedup_db.commit()

        result = engine.run(dedup_db)

        assert result.merged == 0
        assert result.reevaluated_rejected == 1
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT status, detail FROM suggested_merge "
                "WHERE listing_id_a = %s AND listing_id_b = %s",
                (lo, hi),
            )
            status, detail = cur.fetchone()
            assert status == "rejected"
            assert "reevaluated_from" in detail

    def test_fuzzy_suggestion_not_vetoed_when_size_and_price_are_identical(
        self, dedup_db
    ):
        """B1 (PR #567 review): a genuinely-incompatible type pair
        (chalet/piso — NOT the piso/atico family) must not veto a fuzzy
        suggestion when m2_built AND current_price are BOTH exactly
        identical on both sides — the live-DB pattern the review found in
        97 of 97 type-conflicting currently-merged properties (a portal
        type-mapping quirk, not two properties)."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-identical-size-price-type-conflict-unvetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(90),
            m2_built_b=Decimal(90),
            current_price_a=Decimal(260000),
            current_price_b=Decimal(260000),
            property_type_a="chalet",
            property_type_b="piso",
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1
        with dedup_db.cursor() as cur:
            cur.execute("SELECT match_basis FROM suggested_merge")
            assert cur.fetchone()[0] == "fuzzy"

    def test_fuzzy_suggestion_not_vetoed_by_rooms_zero_treated_as_absent(
        self, dedup_db
    ):
        """B3 (PR #567 review): rooms=0 is a scrape-artifact placeholder
        for at least one connector (this issue's own property 121/128
        example: the SAME fotocasa listing scraped once with rooms=0 and
        once with rooms=4), not a genuine studio count — must not veto."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-rooms-zero-treated-as-absent-unvetoed",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            rooms_a=0,
            rooms_b=4,
        )
        result = engine.run(dedup_db)
        assert result.merged == 0
        assert result.suggested == 1

    def test_veto_reverted_regression_check(self, dedup_db):
        """Proves the veto is what blocks the suggestion, not some other
        rule: monkeypatching structured_fields_conflict (as imported into
        fuzzy.py) to always return False (reverting only the veto's
        *behaviour*, keeping every other line of plumbing untouched) must
        let the type-conflicting pair get suggested again via fuzzy."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "fuzzy-veto-regression-check",
            address_a="Calle Mayor 5, Madrid",
            address_b="Calle Mayor 5, Madrid",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(71),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(260000),
            property_type_a="piso",
            property_type_b="local",
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(fuzzy, "structured_fields_conflict", lambda a, b: False)
            result = engine.run(dedup_db)

        assert result.merged == 0
        assert result.suggested == 1

    def test_property_type_conflict_does_not_block_address_coords_merge(self, dedup_db):
        """The blast-radius finding this design is built around: a pair
        that's a genuine duplicate on much stronger evidence (matching
        coordinates, identical size/price) must still auto-merge via
        address_coords even when property_type disagrees — real live-DB
        clusters (e.g. property 1313/6122: fotocasa 'piso' vs idealista
        'chalet', same address/price, matched via address_coords) showed
        this is noisy per-connector metadata, not evidence of two
        properties."""
        _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "type-conflict-does-not-block-address-coords",
            address_a="Calle Mayor 5",
            address_b="Calle Mayor 5",
            lat_a=self._LAT,
            lon_a=self._LON,
            lat_b=self._LAT,
            lon_b=self._LON,
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            property_type_a="piso",
            property_type_b="chalet",
        )
        result = engine.run(dedup_db)
        assert result.merged == 1
        assert result.suggested == 0
        with dedup_db.cursor() as cur:
            cur.execute(
                "SELECT match_basis FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            assert cur.fetchone()[0] == "address_coords"

    def test_rooms_conflict_does_not_block_photo_hash_auto_merge(self, dedup_db):
        """Same finding, for photo_hash's issue #188 exact-match auto-merge
        path (91 of 99 live-DB blast-radius hits were on this exact
        signal) — an exact photo overlap, corroborated by size/price, must
        still auto-merge even when rooms disagree by >=2."""
        cache = _PhotoHashCache()
        listing_a, _prop_a, listing_b, _prop_b = _insert_pair(
            dedup_db,
            "fotocasa",
            "idealista",
            "rooms-conflict-does-not-block-photo-hash",
            m2_built_a=Decimal(70),
            m2_built_b=Decimal(70),
            current_price_a=Decimal(250000),
            current_price_b=Decimal(250000),
            rooms_a=2,
            rooms_b=6,
        )
        identical_hex = "ffff0000ffff0000"
        cache._cache[listing_a] = [imagehash.hex_to_hash(identical_hex)]
        cache._cache[listing_b] = [imagehash.hex_to_hash(identical_hex)]
        records = {r.listing_id: r for r in engine.fetch_listing_records(dedup_db)}
        evaluation = engine.evaluate_pair(records[listing_a], records[listing_b], cache)
        assert evaluation is not None
        assert evaluation.basis == "photo_hash"
        assert evaluation.decision == "merge"


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


def _stub_fetch(hashes_for, *, cached_hashed_for=None):
    """A `photo_hash.fetch_hashes_with_stats` stand-in for the health tests.

    `hashes_for(source)` gives the hashes a live fetch produced;
    `cached_hashed_for(source)` (optional) how many came out of the #221 store
    instead. Live attempts are derived from the URLs the real function would
    have requested, so a video-only `photo_urls` still counts as zero attempts
    here exactly as it does in production.
    """

    def _fetch(urls, source="unknown", store_conn=None):
        cached = cached_hashed_for(source) if cached_hashed_for else 0
        live_urls = [u for u in urls if photo_hash_signal._looks_like_photo_url(u)]
        live_attempted = max(len(live_urls) - cached, 0)
        hashes = hashes_for(source)
        stats = photo_hash_signal.PhotoFetchStats(
            live_attempted=live_attempted,
            live_hashed=max(len(hashes) - cached, 0),
            cached_hashed=cached,
        )
        return hashes, stats

    return _fetch


class TestPhotoHashCacheSourceHealth:
    """Issue #206: `_PhotoHashCache` tracks attempted/hashed photo counts
    per source as it fetches (piggybacking on the existing memoization
    pass, one extra dict update per listing) so a run can report which
    sources had a 0% photo-hash success rate. No DB/network needed here —
    `photo_hash.fetch_hashes_with_stats` itself is monkeypatched, same
    no-network split every other engine-level photo_hash test in this file
    uses.
    """

    def test_a_source_with_every_photo_failing_is_reported(self, monkeypatch):
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            _stub_fetch(lambda source: []),
        )
        cache = _PhotoHashCache()
        listing = _record(
            1, 100, source="milanuncios", photo_urls=("https://a.example/1.jpg",)
        )
        cache.get(listing)
        assert cache.zero_success_sources() == {"milanuncios": 1}

    def test_a_source_with_at_least_one_success_is_not_reported(self, monkeypatch):
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            _stub_fetch(lambda source: [imagehash.hex_to_hash("0" * 16)]),
        )
        cache = _PhotoHashCache()
        listing = _record(
            1, 100, source="fotocasa", photo_urls=("https://a.example/1.jpg",)
        )
        cache.get(listing)
        assert cache.zero_success_sources() == {}

    def test_counts_accumulate_across_multiple_listings_of_the_same_source(
        self, monkeypatch
    ):
        """A source's health is judged across the whole run, not per
        listing — one listing with a lucky fetch shouldn't hide another's
        total failure, and vice versa (only a source with ZERO successes
        across every listing counts as degraded)."""
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            _stub_fetch(lambda source: []),
        )
        cache = _PhotoHashCache()
        cache.get(
            _record(
                1, 100, source="milanuncios", photo_urls=("https://a.example/1.jpg",)
            )
        )
        cache.get(
            _record(
                2,
                200,
                source="milanuncios",
                photo_urls=("https://a.example/2.jpg", "https://a.example/3.jpg"),
            )
        )
        assert cache.zero_success_sources() == {"milanuncios": 3}

    def test_a_listing_with_no_attemptable_photos_does_not_count_as_a_failure(
        self, monkeypatch
    ):
        """An empty/video-only photo_urls shouldn't make a source look
        degraded — there was nothing to attempt in the first place."""
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            _stub_fetch(lambda source: []),
        )
        cache = _PhotoHashCache()
        cache.get(_record(1, 100, source="idealista", photo_urls=()))
        assert cache.zero_success_sources() == {}

    def test_a_fully_warm_source_reports_nothing_rather_than_healthy(self, monkeypatch):
        """Issue #221: every photo came out of the store, so this run made no
        network request at all and has NO evidence about the CDN either way.

        Reporting nothing is the honest answer. The tempting alternative —
        treating the cached hashes as successes — is what silenced this
        detector: it makes a source look healthy on the strength of hashes
        recorded before the outage. The paired
        `..._despite_cached_successes` test below is the other half: as soon
        as there IS live traffic to judge, a dead CDN is reported again.
        """
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            _stub_fetch(
                lambda source: [imagehash.hex_to_hash("0" * 16)] * 2,
                cached_hashed_for=lambda source: 2,
            ),
        )
        cache = _PhotoHashCache()
        cache.get(
            _record(
                1,
                100,
                source="milanuncios",
                photo_urls=("https://a.example/1.jpg", "https://a.example/2.jpg"),
            )
        )
        assert cache.zero_success_sources() == {}

    def test_a_source_whose_live_fetches_all_fail_is_reported_despite_cached_successes(
        self, monkeypatch
    ):
        """The #209/#213 shape, and the regression PR #226 was opened on.

        The store is warm with hashes recorded while the CDN was healthy; a
        newly-ingested listing's URLs now 404 without exception. Counting the
        cached hashes as this run's successes made the source look perfectly
        healthy — 100% of live fetches failing, zero warnings. Only live
        traffic decides.
        """
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            # 8 hashes returned, every one of them from the store; the 4 URLs
            # actually requested over the network all failed.
            _stub_fetch(
                lambda source: [imagehash.hex_to_hash("0" * 16)] * 8,
                cached_hashed_for=lambda source: 8,
            ),
        )
        cache = _PhotoHashCache()
        cache.get(
            _record(
                1,
                100,
                source="milanuncios",
                photo_urls=tuple(f"https://a.example/{i}.jpg" for i in range(12)),
            )
        )
        assert cache.zero_success_sources() == {"milanuncios": 4}

    def test_mixed_sources_only_the_failing_one_is_reported(self, monkeypatch):
        monkeypatch.setattr(
            photo_hash_signal,
            "fetch_hashes_with_stats",
            _stub_fetch(
                lambda source: (
                    [] if source == "milanuncios" else [imagehash.hex_to_hash("0" * 16)]
                )
            ),
        )
        cache = _PhotoHashCache()
        cache.get(
            _record(
                1, 100, source="milanuncios", photo_urls=("https://a.example/1.jpg",)
            )
        )
        cache.get(
            _record(2, 200, source="fotocasa", photo_urls=("https://a.example/2.jpg",))
        )
        assert cache.zero_success_sources() == {"milanuncios": 1}


class TestDedupRunResultPhotoHealth:
    """Issue #206 end-to-end through engine.run() against a real DB: a
    source whose photos never hash must show up on
    DedupRunResult.photo_hash_zero_success_sources, not just as per-photo
    log noise. `photo_hash.requests.get` is monkeypatched (no real network
    call), keyed on hostname so one source's CDN can fail while another's
    succeeds — mirroring the real production shape (Milanuncios photos
    404ing while Fotocasa's keep working fine).
    """

    _WORKING_HOST = "cdn.fotocasa.example"
    _BROKEN_HOST = "images.milanuncios.example"

    @staticmethod
    def _jpeg_bytes(url: str) -> bytes:
        """A distinct image per URL.

        Serving one identical image for every URL would make every listing's
        photos match every other listing's perfectly, so these tests would be
        running against an accidental auto-merge (issue #188) rather than the
        health rollup they're about. Derived from the URL so it's stable
        across runs — the store must return the same hash on a second pass.
        """
        seed = zlib.crc32(url.encode()) & 0xFFFF
        image = Image.new("L", (64, 64))
        image.putdata(
            [(seed + x * 7 + y * 13) % 256 for y in range(64) for x in range(64)]
        )
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, "JPEG")
        return buffer.getvalue()

    def _fake_get(self, url, **kwargs):
        from urllib.parse import urlsplit

        import requests

        class _FakeResponse:
            def __init__(self, ok: bool, body: bytes = b""):
                self._ok = ok
                self.raw = io.BytesIO(body)
                self.raw.decode_content = True

            def raise_for_status(self):
                if not self._ok:
                    raise requests.exceptions.HTTPError("404 simulated CDN failure")

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        host = urlsplit(url).hostname or ""
        if host == self._BROKEN_HOST or self._dead_hosts_only:
            return _FakeResponse(ok=False)
        return _FakeResponse(ok=True, body=self._jpeg_bytes(url))

    # Flipped to True by the "the CDN went dead after the store warmed up"
    # test below; every other test leaves the per-host behaviour above alone.
    _dead_hosts_only = False

    def test_a_fully_broken_source_is_flagged_and_a_healthy_one_is_not(
        self, dedup_db, monkeypatch, caplog
    ):
        monkeypatch.setattr(photo_hash_signal.requests, "get", self._fake_get)

        prop_broken = _insert_property(dedup_db, address="Calle Rota 1")
        _insert_listing(
            dedup_db,
            prop_broken,
            "milanuncios",
            "broken-1",
            photo_urls=[f"https://{self._BROKEN_HOST}/p{i}.jpg" for i in range(3)],
        )
        prop_healthy = _insert_property(dedup_db, address="Calle Sana 1")
        _insert_listing(
            dedup_db,
            prop_healthy,
            "fotocasa",
            "healthy-1",
            photo_urls=[f"https://{self._WORKING_HOST}/p{i}.jpg" for i in range(2)],
        )
        dedup_db.commit()

        with caplog.at_level("WARNING", logger="etl.dedup.engine"):
            result = engine.run(dedup_db)

        assert result.photo_hash_zero_success_sources == {"milanuncios": 3}
        health_warnings = [
            r.message
            for r in caplog.records
            if r.name == "etl.dedup.engine" and "milanuncios" in r.message
        ]
        assert health_warnings, "expected a WARNING naming the degraded source"
        assert "0/3" in health_warnings[0]

    def test_no_zero_success_sources_when_everything_hashes(
        self, dedup_db, monkeypatch
    ):
        monkeypatch.setattr(photo_hash_signal.requests, "get", self._fake_get)

        prop_a = _insert_property(dedup_db, address="Calle Ok 1")
        _insert_listing(
            dedup_db,
            prop_a,
            "fotocasa",
            "ok-1",
            photo_urls=[f"https://{self._WORKING_HOST}/p{i}.jpg" for i in range(2)],
        )
        prop_b = _insert_property(dedup_db, address="Calle Ok 2")
        _insert_listing(
            dedup_db,
            prop_b,
            "idealista",
            "ok-2",
            photo_urls=[f"https://{self._WORKING_HOST}/p{i}.jpg" for i in range(2)],
        )
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.photo_hash_zero_success_sources == {}

    def test_hashes_persist_even_though_the_run_itself_never_commits(
        self, dedup_db, monkeypatch
    ):
        """Issue #221 blocker: `engine.run()` has no commit of its own — the
        only commits are incidental ones inside `perform_merge`/
        `file_suggestion`, so a run where no pair fires (this one: distinct
        addresses, distinct photos) committed nothing at all. With the store
        riding that same transaction, a full ~46-minute cold pass killed
        before a merge happened discarded every hash it had paid for. The
        store's own connection is what makes the work survive; `rollback()`
        below is what a SIGINT does to the run's transaction.
        """
        monkeypatch.setattr(photo_hash_signal.requests, "get", self._fake_get)
        prop_a = _insert_property(dedup_db, address="Calle Persistente 1")
        _insert_listing(
            dedup_db,
            prop_a,
            "fotocasa",
            "persist-1",
            photo_urls=[
                f"https://{self._WORKING_HOST}/persist{i}.jpg" for i in range(2)
            ],
        )
        prop_b = _insert_property(dedup_db, address="Calle Persistente 2")
        _insert_listing(
            dedup_db,
            prop_b,
            "idealista",
            "persist-2",
            photo_urls=[f"https://{self._WORKING_HOST}/keep{i}.jpg" for i in range(2)],
        )
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.merged == 0 and result.suggested == 0, (
            "this test only means something if the run had no incidental commit"
        )
        dedup_db.rollback()

        with dedup_db.cursor() as cur:
            cur.execute("SELECT count(*) FROM photo_hashes WHERE ok")
            assert cur.fetchone()[0] == 4

    def test_a_source_whose_cdn_dies_after_the_store_warmed_up_is_still_flagged(
        self, dedup_db, monkeypatch
    ):
        """The regression PR #226 was opened on, end to end.

        Run 1 hashes Milanuncios' photos while its CDN is healthy, and the
        issue-#221 store persists them. The CDN then dies exactly as it did in
        #209/#213 — every request 404s — and a brand-new listing arrives whose
        four URLs have never worked. Run 2 must still report the source.

        With the store's hits counted as this run's successes, run 2 reported
        `{}`: eight hashes recorded a week ago outvoted four live 404s, and the
        detector built for this precise incident stayed silent through it. The
        rollup only ever looks at live traffic now, so the four failed fetches
        are the whole of the evidence and they all failed.
        """
        prop_mil = _insert_property(dedup_db, address="Calle Viva 1")
        _insert_listing(
            dedup_db,
            prop_mil,
            "milanuncios",
            "warm-1",
            photo_urls=[f"https://{self._WORKING_HOST}/warm{i}.jpg" for i in range(8)],
        )
        prop_other = _insert_property(dedup_db, address="Calle Viva 2")
        _insert_listing(
            dedup_db,
            prop_other,
            "fotocasa",
            "warm-2",
            photo_urls=[f"https://{self._WORKING_HOST}/other{i}.jpg" for i in range(2)],
        )
        dedup_db.commit()

        monkeypatch.setattr(photo_hash_signal.requests, "get", self._fake_get)
        assert engine.run(dedup_db).photo_hash_zero_success_sources == {}
        with dedup_db.cursor() as cur:
            cur.execute("SELECT count(*) FROM photo_hashes WHERE ok")
            assert cur.fetchone()[0] == 10, "run 1 must have warmed the store"

        # The CDN goes dead, and a new listing arrives that has never been
        # hashed — its four URLs are fetched live, and all four 404.
        self._dead_hosts_only = True
        prop_new = _insert_property(dedup_db, address="Calle Nueva 3")
        _insert_listing(
            dedup_db,
            prop_new,
            "milanuncios",
            "new-1",
            photo_urls=[f"https://{self._WORKING_HOST}/new{i}.jpg" for i in range(4)],
        )
        dedup_db.commit()

        result = engine.run(dedup_db)
        assert result.photo_hash_zero_success_sources == {"milanuncios": 4}

    def test_cli_run_prints_the_degraded_source(self, dedup_db, monkeypatch, capsys):
        """`ps dedup run` (etl.dedup.cli._cmd_run) must print the health
        warning too — same "the CLI stays the one place an operator looks"
        precedent as same_source_skipped's own print."""
        from etl.dedup.cli import _cmd_run

        monkeypatch.setattr(photo_hash_signal.requests, "get", self._fake_get)
        prop_broken = _insert_property(dedup_db, address="Calle Rota 2")
        _insert_listing(
            dedup_db,
            prop_broken,
            "milanuncios",
            "broken-2",
            photo_urls=[f"https://{self._BROKEN_HOST}/p0.jpg"],
        )
        # A second, different-source listing so at least one pair actually
        # reaches evaluate_pair (and therefore hash_cache.get()) — a
        # lone listing with nothing to compare against never touches the
        # photo-hash cache at all, by construction of the pairwise loop.
        prop_other = _insert_property(dedup_db, address="Calle Rota 3")
        _insert_listing(
            dedup_db,
            prop_other,
            "fotocasa",
            "other-2",
            photo_urls=[f"https://{self._WORKING_HOST}/p0.jpg"],
        )
        dedup_db.commit()

        exit_code = _cmd_run(dedup_db)
        assert exit_code == 0
        captured = capsys.readouterr()
        assert "milanuncios" in captured.out
        assert "0/1" in captured.out
