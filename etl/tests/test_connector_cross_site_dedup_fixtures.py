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

from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.milanuncios import MilanunciosConnector

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
