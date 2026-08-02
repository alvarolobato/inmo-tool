"""One module per dedup signal, run in priority order by etl.dedup.engine.

Each signal module is a pure function over two ListingRecord instances
(etl.dedup.engine.ListingRecord) — no DB access, no network calls except
etl.dedup.signals.photo_hash's explicit fetch-and-hash helper, which the
engine calls separately from the pure comparison function so tests can
exercise the comparison logic without a network dependency.
"""
