"""Shared dataclasses for the dedup engine and its signal modules.

Split out from etl.dedup.engine so signal modules can import ListingRecord
without a circular import (engine imports every signal module).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class ListingRecord:
    """One listing joined with its (currently singleton-or-merged) property.

    Fetched fresh from the DB by etl.dedup.engine for every dedup run — not
    the same object as etl.connectors.base.CanonicalListingVersion, which is
    a connector's *pre-persistence* shape. This is the *post-persistence*
    shape the dedup engine reasons about, keyed by real DB ids.
    """

    listing_id: int
    property_id: int
    source: str
    external_id: str
    listing_kind: str | None  # 'particular' | 'agency' | None (unconfirmed)
    description: str | None
    photo_urls: tuple[str, ...]
    cadastral_ref: str | None
    address: str | None
    lat: Decimal | None
    lon: Decimal | None
    m2_built: Decimal | None
    current_price: Decimal | None
    contact_raw: str | None  # seller/agency display name, used by
    # reference_code.py's agency-match corroboration (issue #72)
    reference_code: str | None  # seller/agency reference code (issue #72)
    # Free-text floor as published by the source portal (e.g. "3º",
    # "3ª planta", "Bajo", "A partir de la 15ª planta") — see
    # etl.dedup.signals.floor for the normalizer. Defaulted so existing
    # call sites/tests that predate issue #186 don't need updating just to
    # construct a record; engine.fetch_listing_records always populates it
    # from property.floor for real runs.
    floor: str | None = None
    # `property.property_type` — already canonicalized at connector
    # ingestion time onto the schema's fixed CHECK vocabulary ('piso',
    # 'chalet', 'atico', 'local', 'nave', 'garaje', 'terreno', 'edificio'),
    # never raw portal text. See etl.dedup.signals.structured_fields for
    # the issue #566 conflict check. Defaulted for the same
    # backward-compatible-construction reason as `floor` above.
    property_type: str | None = None
    # `property.rooms` — issue #566. Defaulted for the same reason as
    # `floor`/`property_type` above.
    rooms: int | None = None


@dataclass(frozen=True)
class PairEvaluation:
    """The result of comparing two ListingRecords — what to do about the pair."""

    basis: str  # matches suggested_merge/property_merge_log match_basis CHECK
    confidence: Decimal
    decision: str  # 'merge' | 'suggest' | 'reject'
    # 'reject' (issue #627, D-138): a rule-based rejection, never written
    # to `suggested_merge`/`property_merge_log` at all for a brand-new
    # pair — see etl.dedup.engine._run and price_gap.py. `basis` for this
    # decision is NOT one of suggested_merge.match_basis's CHECK values
    # (it's never persisted there for a new pair); the one place it IS
    # persisted is inside an existing pending row's `detail` JSON during
    # reevaluation, which has no CHECK constraint on its contents.
    detail: dict | None = None
