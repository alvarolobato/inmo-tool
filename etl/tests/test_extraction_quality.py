"""Unit tests for the per-listing extraction-quality score (issue #80).

Pure-function tests — no DB, no connectors. They pin the two properties the
feature exists for:

  1. A sparse extraction grades visibly lower than a rich one.
  2. The grade is *weighted*: two listings missing the same *number* of
     fields but a different *which* get different scores (acceptance
     criterion 2). A flat populated/total ratio could never satisfy this.
"""

from __future__ import annotations

from decimal import Decimal

from etl.connectors.base import CanonicalListingVersion
from etl.extraction_quality import (
    WEIGHTS_VERSION,
    compute_extraction_quality,
)


def _canonical(**overrides) -> CanonicalListingVersion:
    """A fully-populated canonical listing; override fields to `None`/`()` to
    simulate an under-extraction."""
    defaults: dict = {
        "external_id": "x1",
        "source": "test",
        "url": "https://example.test/x1",
        "listing_kind": "particular",
        "status": "active",
        "current_price": Decimal(200000),
        "description": "Piso reformado en el centro",
        "photo_urls": ("https://example.test/a.jpg", "https://example.test/b.jpg"),
        "contact_raw": None,
        "address": "Calle Falsa 123, Madrid",
        "lat": Decimal("40.4168"),
        "lon": Decimal("-3.7038"),
        "property_type": "piso",
        "m2_built": Decimal(70),
        "m2_useful": Decimal(60),
        "rooms": 3,
        "bathrooms": 2,
        "floor": "3",
        "has_elevator": True,
        "year_built": 1975,
        "energy_rating": "D",
    }
    defaults.update(overrides)
    return CanonicalListingVersion(**defaults)


def test_rich_listing_grades_a_and_all_fields_populated():
    q = compute_extraction_quality(_canonical())
    assert q["grade"] == "A"
    assert q["score"] == 1.0
    assert q["populated_fields"] == q["total_fields"]
    assert q["weights_version"] == WEIGHTS_VERSION


def test_sparse_listing_grades_lower_than_rich_one():
    rich = compute_extraction_quality(_canonical())
    # Only a price + a description survived extraction; size, rooms, type,
    # location and photos all failed — the "our parser missed everything"
    # case the signal exists to surface.
    sparse = compute_extraction_quality(
        _canonical(
            m2_built=None,
            m2_useful=None,
            rooms=None,
            bathrooms=None,
            property_type=None,
            energy_rating=None,
            lat=None,
            lon=None,
            address=None,
            photo_urls=(),
        )
    )
    assert sparse["score"] < rich["score"]
    assert sparse["grade"] in {"C", "F"}
    assert sparse["grade"] != rich["grade"]


def test_weighting_same_missing_count_different_fields_differ():
    """Acceptance criterion 2: equal number of missing fields, different
    *which*, must yield different scores — proving the grade is weighted,
    not a flat extracted/total ratio."""
    # Missing exactly one field: current_price (weight 3, a core field).
    missing_core = compute_extraction_quality(_canonical(current_price=None))
    # Missing exactly one field: energy_rating (weight 1, a secondary field).
    missing_secondary = compute_extraction_quality(_canonical(energy_rating=None))

    # Same populated *count* ...
    assert missing_core["populated_fields"] == missing_secondary["populated_fields"]
    # ... but the core-field miss costs more, so a strictly lower score.
    assert missing_core["score"] < missing_secondary["score"]


def test_location_counts_when_only_address_present():
    """A textual address alone (no lat/lon) still counts as location known."""
    with_coords = compute_extraction_quality(_canonical())
    address_only = compute_extraction_quality(_canonical(lat=None, lon=None))
    # Dropping coords but keeping the address must not lose the location field.
    assert address_only["populated_fields"] == with_coords["populated_fields"]
    assert address_only["score"] == with_coords["score"]

    no_location = compute_extraction_quality(
        _canonical(lat=None, lon=None, address=None)
    )
    assert no_location["score"] < address_only["score"]


def test_score_is_deterministic():
    c = _canonical(rooms=None)
    assert compute_extraction_quality(c) == compute_extraction_quality(c)


def test_empty_description_and_photos_do_not_count():
    """Whitespace-only description / empty photo tuple are 'not populated'."""
    q = compute_extraction_quality(_canonical(description="   ", photo_urls=()))
    full = compute_extraction_quality(_canonical())
    assert q["populated_fields"] == full["populated_fields"] - 2
