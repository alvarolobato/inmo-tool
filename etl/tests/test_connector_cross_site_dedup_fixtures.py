"""Cross-connector fixture pair proving Fotocasa + Milanuncios can describe
the same real-world property (issue #15 EC-2, Phase 2.1).

No real cross-site duplicate turned up during this task's live sweep
against both sites (see PR #54) — page-1-only discovery on each connector,
small sample, low overlap probability by chance, not a bug. This synthetic
pair stands in as the known-good reference: task 2.2's dedup engine can
point its signal-matching tests (address+size proximity, phone-in-
description) at these two fixtures with a known correct answer — they ARE
the same fictional property — rather than depending on whatever real data
happens to be in the DB on a given day.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

from etl import orchestrator
from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.milanuncios import MilanunciosConnector
from etl.dedup import engine

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

_FIXTURES = Path(__file__).parent / "fixtures"

# Embedded in both fixtures' free-text description — task 2.2's actual
# phone-in-description dedup signal (issue #1 §6) should find this in both.
_SHARED_PHONE = "622334455"

# Realistic small cross-site price difference — not an exact match, since
# sellers commonly list at slightly different prices across sites. A dedup
# engine keying on price proximity (not equality) needs a fixture that
# actually exercises that tolerance, not a trivially-equal pair.
_FOTOCASA_PRICE = Decimal(285000)
_MILANUNCIOS_PRICE = Decimal(279000)
_PRICE_TOLERANCE_RATIO = Decimal("0.05")  # generous; task 2.2 sets its own


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str) -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_dedup_pair_fixtures_normalize_to_matching_property_fields():
    fotocasa_html = _read_fixture("fotocasa_sample_detail_dedup_pair.html")
    with patch(
        "etl.connectors.fotocasa.requests.get",
        return_value=_mock_response(fotocasa_html, "https://www.fotocasa.es/x"),
    ):
        fotocasa_raw = FotocasaConnector().fetch_detail(
            "999000001", throttle=lambda: None
        )
    fotocasa_listing = FotocasaConnector().normalize(fotocasa_raw)

    milanuncios_html = _read_fixture("milanuncios_sample_detail_dedup_pair.html")
    with patch(
        "etl.connectors.milanuncios.requests.get",
        return_value=_mock_response(milanuncios_html, "https://www.milanuncios.com/x"),
    ):
        milanuncios_raw = MilanunciosConnector().fetch_detail(
            "700000123", throttle=lambda: None
        )
    milanuncios_listing = MilanunciosConnector().normalize(milanuncios_raw)

    # Same size — a dedup engine's m2_built proximity check should treat
    # these as matching (exact equality here; task 2.2 sets its own real
    # tolerance for genuinely differing values).
    assert fotocasa_listing.m2_built == milanuncios_listing.m2_built == Decimal(70)

    # Different but close prices — proves the pair exercises price
    # *proximity* matching, not accidental exact equality.
    assert fotocasa_listing.current_price == _FOTOCASA_PRICE
    assert milanuncios_listing.current_price == _MILANUNCIOS_PRICE
    price_diff_ratio = abs(_FOTOCASA_PRICE - _MILANUNCIOS_PRICE) / _FOTOCASA_PRICE
    assert price_diff_ratio <= _PRICE_TOLERANCE_RATIO

    # The actual phone-in-description dedup signal (issue #1 §6): the same
    # digits must appear in both connectors' full-text descriptions.
    assert _SHARED_PHONE in fotocasa_listing.description
    assert _SHARED_PHONE in milanuncios_listing.description

    # Same neighborhood, captured by both connectors' address string —
    # a supporting (not primary) signal alongside size/price/phone.
    assert "Trafalgar" in (fotocasa_listing.address or "")
    assert "Madrid" in (milanuncios_listing.address or "")


def test_dedup_pair_fixtures_end_to_end_through_real_dedup_engine(pg_conn):
    """Issue #16 EC-1: run the actual dedup engine against these two fixtures
    ingested through the real connector persistence path — not a synthetic
    ListingRecord pair, the genuine Fotocasa+Milanuncios round trip.

    Expected outcome, confirmed by running it rather than assumed: an
    auto-merge on `address_coords` (signal 2), not phone (signal 3). Both
    fixtures carry the identical lat/lon (40.4324, -3.7025) real Fotocasa
    and Milanuncios listings *can* publish (see `realEstate.coordinates` /
    `location.geolocation` in etl/connectors/fotocasa.py and milanuncios.py)
    — signal 2 fires before phone is ever evaluated, per the priority order
    in etl.dedup.engine.evaluate_pair. This is a meaningfully different (and
    arguably better) proof than "phone matched": it confirms the *earlier*,
    higher-confidence signal in the priority chain also works end-to-end
    against real connector output, not just the fallback.

    Note for whoever next samples real production data: a live sweep against
    both sites earlier in this task's development found zero listings with
    non-null lat/lon among real (non-fixture) results — this fixture's
    shared coordinates are realistic in *shape* (both sites can publish
    them) but the *overlap itself* was constructed for this test, not
    observed live. Fotocasa's listing_kind for this fixture is still
    genuinely None (not 'particular') — see the assert below — which is why
    a *second* fixture pair without matching coordinates would be needed to
    actually exercise the phone-corroboration-but-unconfirmed-kind tier
    end-to-end; the synthetic ListingRecord tests in test_dedup_engine.py
    cover that path directly instead.
    """
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with pg_conn.cursor() as cur:
        cur.execute(sql)
    pg_conn.commit()

    fotocasa_html = _read_fixture("fotocasa_sample_detail_dedup_pair.html")
    with patch(
        "etl.connectors.fotocasa.requests.get",
        return_value=_mock_response(fotocasa_html, "https://www.fotocasa.es/x"),
    ):
        fotocasa_raw = FotocasaConnector().fetch_detail(
            "999000001", throttle=lambda: None
        )
    fotocasa_listing = FotocasaConnector().normalize(fotocasa_raw)
    assert fotocasa_listing.listing_kind is None  # see docstring — not a bug

    milanuncios_html = _read_fixture("milanuncios_sample_detail_dedup_pair.html")
    with patch(
        "etl.connectors.milanuncios.requests.get",
        return_value=_mock_response(milanuncios_html, "https://www.milanuncios.com/x"),
    ):
        milanuncios_raw = MilanunciosConnector().fetch_detail(
            "700000123", throttle=lambda: None
        )
    milanuncios_listing = MilanunciosConnector().normalize(milanuncios_raw)
    assert milanuncios_listing.listing_kind == "particular"

    try:
        orchestrator._upsert_canonical_listing(pg_conn, fotocasa_listing)
        orchestrator._upsert_canonical_listing(pg_conn, milanuncios_listing)

        result = engine.run(pg_conn)
        assert result.merged == 1
        assert result.suggested == 0

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT property_id, match_basis, confidence FROM property_merge_log "
                "ORDER BY created_at DESC LIMIT 1"
            )
            survivor_property_id, basis, confidence = cur.fetchone()
        assert basis == "address_coords"
        assert confidence == Decimal("0.900")

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT property_id FROM listing "
                "WHERE source IN ('fotocasa', 'milanuncios') "
                "AND external_id IN ('999000001', '700000123')"
            )
            property_ids_after = {row[0] for row in cur.fetchall()}
        assert property_ids_after == {survivor_property_id}
    finally:
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT property_id FROM listing WHERE source IN ('fotocasa', 'milanuncios') "
                "AND external_id IN ('999000001', '700000123')"
            )
            property_ids = {row[0] for row in cur.fetchall()}
            # A merge may have happened: also clean up the losing side's now-
            # unreferenced property row and the merge_log row pointing at both.
            cur.execute(
                "SELECT property_id, losing_property_id FROM property_merge_log "
                "WHERE property_id = ANY(%s) OR losing_property_id = ANY(%s)",
                (list(property_ids), list(property_ids)),
            )
            for survivor, loser in cur.fetchall():
                property_ids.add(survivor)
                if loser is not None:
                    property_ids.add(loser)
            cur.execute(
                "DELETE FROM property_merge_log WHERE property_id = ANY(%s) OR losing_property_id = ANY(%s)",
                (list(property_ids), list(property_ids)),
            )
            cur.execute("DELETE FROM suggested_merge")
            cur.execute(
                "DELETE FROM listing WHERE source IN ('fotocasa', 'milanuncios') "
                "AND external_id IN ('999000001', '700000123')"
            )
            if property_ids:
                cur.execute(
                    "DELETE FROM property WHERE id = ANY(%s)", (list(property_ids),)
                )
        pg_conn.commit()
