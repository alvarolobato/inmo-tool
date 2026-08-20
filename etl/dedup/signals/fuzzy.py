"""Address-text normalization — issue #16 item 5's `evaluate()` signal was
retired by issue #601 (D-130): it was 96.8% of the pending suggested_merge
backlog (25,027 of 25,850 rows) at ~0.4-0.7% measured precision on a
stratified hand check, because fotocasa/idealista publish neighbourhood-
level address strings (no street number on 99.2% of pending fuzzy pairs),
so `token_sort_ratio >= 0.55` + size/price proximity percolates whole
districts into one connected component rather than ever discriminating
individual units. See `docs/decisions/D-130-retire-fuzzy-signal.md` for the
full rationale, `etl.dedup.engine.purge_pending_fuzzy` for the one-off
backlog purge (with a rescue set for the ~43 pairs that WERE corroborated),
and `etl.dedup.engine.evaluate_pair`, which no longer calls anything in
this module.

What survives: `normalize_address` — `address_coords.py`'s own
`addresses_close` reuses the same normalization (lowercase, strip accents/
punctuation, expand common Spanish abbreviations) for its stronger,
coordinate-gated match, which has nothing to do with fuzzy's retirement.
"""

from __future__ import annotations

import re
import unicodedata

_ABBREVIATIONS = {
    # Trailing `(?!\w)` rather than `\b`: a `\b` word-boundary assertion
    # requires an actual word/non-word transition, which "c/ trafalgar" or
    # "cl. mayor" never have at the point right after the `/`/`.` (both
    # that character and the following space are non-word — no transition,
    # so `\b` silently never matches). `(?!\w)` just asserts "not a word
    # character next", which the following space satisfies either way.
    # Found dead in review (PR #55): these three never matched their
    # real-world space-separated form, silently breaking the single most
    # common Spanish address abbreviation pattern.
    r"\bc/(?!\w)": "calle",
    r"\bcl\.?(?!\w)": "calle",
    r"\bavda\.?(?!\w)": "avenida",
    r"\bav\.?(?!\w)": "avenida",
    r"\bpza\.?(?!\w)": "plaza",
    r"\bpº(?!\w)": "paseo",
}


def normalize_address(address: str) -> str:
    """Lowercase, strip accents/punctuation, expand common abbreviations."""
    text = address.lower().strip()
    for pattern, replacement in _ABBREVIATIONS.items():
        text = re.sub(pattern, replacement, text)
    # Strip accents: decompose then drop combining marks.
    text = "".join(
        ch
        for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()
