"""Signal 1: cadastral reference exact match — definitive, and now live.

A cadastral reference identifies exactly one real property, so a match here
is conclusive rather than probabilistic like signals 2-5 — hence confidence
1.000 and an unconditional merge.

This signal was dormant by construction until issue #140. No connector
populated `property.cadastral_ref` (issue #42, a dedicated Catastro lookup
connector, was cancelled on the correct reasoning that deriving a reference
needs street-number-precise addresses consumer portals withhold), *and*
the column carried a UNIQUE constraint that made two property rows sharing
a reference — the exact state this signal detects — impossible to represent.

Both are resolved. Servicer/REO portals publish the reference directly,
because they hold the asset and therefore the registry data: Solvia does on
every listing. Consumer portals still generally don't, and Vivantial and
Servihabitat were both checked and don't either, so expect this to fire on
servicer-sourced pairs and stay quiet elsewhere. Signals 2-5 remain the
workhorses by volume; this one is the tiebreaker that is never wrong.
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
