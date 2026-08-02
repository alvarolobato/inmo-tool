"""Signal 1: cadastral reference exact match — opportunistic only.

No connector or lookup service in this project resolves `property.cadastral_ref`
(a dedicated Catastro lookup connector was scoped and then cancelled — see
issue #42, closed as not planned, and issue #16's Context note). This signal
exists purely for the case where `cadastral_ref` happens to be populated by
some other means later (a future connector, manual entry) — expect it to
fire rarely to never against this project's actual data. Signals 2-5 in the
sibling modules are the real workhorses.
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup.types import ListingRecord, PairEvaluation


def evaluate(a: ListingRecord, b: ListingRecord) -> PairEvaluation | None:
    if a.cadastral_ref and b.cadastral_ref and a.cadastral_ref == b.cadastral_ref:
        return PairEvaluation(
            basis="cadastral", confidence=Decimal("1.000"), decision="merge"
        )
    return None
