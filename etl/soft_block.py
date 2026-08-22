"""Anti-bot challenge ("soft block") detection for captured pages — issue #692.

A challenge page is the portal saying **"come back later"**. It is not a
listing, and — the distinction this module exists to protect — it is *not* a
withdrawal. Both look identical to a field parser: zero substantive fields.
Conflating them destroys data, because one of the two outcomes writes
`status = 'withdrawn'` onto a live listing.

D-047 / D-157 already say a soft block is never "gone", and
``etl/connectors/milanuncios.py`` deliberately ships **no**
``retired_page_signature`` for exactly this reason: its only field-less page
is a bot wall, so any retirement signature there would have withdrawn live
inventory. Idealista now has both kinds of field-less page in circulation at
once, so the two must be told apart positively rather than by absence.

**Ranking.** This check runs BEFORE any retirement signature and before any
field extraction. It is the highest-priority outcome of the three:

    1. challenge detected        → `blocked`   — no write of any kind,
                                                 worklist row untouched
    2. retirement notice matched → `withdrawn` — listing marked withdrawn
                                                 (issue #690 / D-159)
    3. zero substantive fields   → `failed`    — no listing write; the
                                                 worklist row IS consumed

Ordering is load-bearing. Outcome 3 is *safe* for a challenge page (it writes
nothing to the listing) but *wrong*: it consumes the capture attempt and the
worklist row, telling the owner "this capture is broken" when the truth is
"this page was never served to us".

**No evasion.** Everything here is read-only string inspection of a page a
human's browser already fetched. Nothing in this module solves, bypasses,
retries, auto-clicks or disguises anything (issue #1 §15, D-026/D-027/D-033).
Detect, stop, hand control to the human — that is the whole intervention.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

# ── THE ONE PLACE TO EDIT when a portal rewords its challenge page ──────────
#
# Kept byte-comparable with `CHALLENGE_PHRASES` in
# browser-extension/detect.js — the browser halts the batch, this halts the
# ingest, and they must agree about what a challenge looks like. A test pins
# the two lists identical (tests/test_soft_block.py); if you edit one, edit
# both or that test fails.
#
# Every entry is an accent-FOLDED, lowercased fragment of the PORTAL'S OWN
# VOICE talking to the visitor about the visitor's request behaviour.
# Grounded in the page idealista served during the #683 re-capture drain
# (2026-08-22), which is served AT THE LISTING URL ITSELF.
#
# DELIBERATELY EXCLUDED: the visitor's IP address and the per-visit `ID:`
# UUID the page also renders. Both are per-visit (and personal data — public
# repo); neither may become a signature, a log line, a fixture or an issue.
CHALLENGE_PHRASES: tuple[str, ...] = (
    # "Vaya! parece que estamos recibiendo muchas peticiones tuyas en poco
    # tiempo" — two independent fragments, so a rewording that keeps either
    # half still lands one hit.
    "muchas peticiones",
    "en poco tiempo",
    # The slider widget's own instruction.
    "desliza hacia la derecha",
    # The explainer heading and its opening line.
    "por que esta verificacion",
    "comportamiento del navegador",
    # The three bulleted "varias posibilidades".
    "velocidad sobrehumana",
    "bloquea el funcionamiento de javascript",
    "un robot se encuentra en la misma red",
)

# Two DISTINCT phrases must co-occur. One alone is not enough: a
# seller-written description could plausibly contain "en poco tiempo" ("se
# vende en poco tiempo") and a portal help page could mention a CAPTCHA. Two
# fragments of the operator's anti-bot voice in one document is not something
# a property advert produces.
MIN_PHRASE_HITS = 2

# The same five-vowel + ñ fold `_ACCENT_FOLD` uses in the Idealista connector
# and `foldAccents` uses in detect.js — deliberately narrow, so a ~400 KB page
# costs one translate() rather than full Unicode normalization.
_ACCENT_FOLD = str.maketrans(
    "áàäâéèëêíìïîóòöôúùüûñÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑ",
    "aaaaeeeeiiiioooouuuunAAAAEEEEIIIIOOOOUUUUN",
)

_WS_RE = re.compile(r"\s+")


def _visible_text(html: str) -> str:
    """The page's visible text, accent-folded, lowercased, whitespace-collapsed.

    ``<script>``/``<style>``/``<noscript>`` are dropped first, for the same
    reason #691's ``_strip_to_visible_text`` drops them: a JS string literal
    is not the portal telling the human anything. Only text a human in front
    of the browser could actually have read counts as a challenge.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text(" ", strip=True)
    return _WS_RE.sub(" ", text.translate(_ACCENT_FOLD).lower())


def challenge_phrase_hits(html: str) -> list[str]:
    """Which distinct CHALLENGE_PHRASES appear in the page's visible text."""
    if not html:
        return []
    folded = _visible_text(html)
    return [phrase for phrase in CHALLENGE_PHRASES if phrase in folded]


def challenge_page_signature(html: str) -> str | None:
    """A Spanish citation of the challenge this page is, or ``None``.

    Returns a short human-readable description naming the phrases that
    matched — this becomes ``extension_capture.error_msg``, so the owner can
    see WHY a capture was classified as blocked. Never the IP, never the
    per-visit UUID.

    ``None`` for every page this does not positively recognise. Absence is
    never evidence here: an unrecognised field-less page falls through to the
    existing outcomes, which write nothing to the listing either.
    """
    hits = challenge_phrase_hits(html)
    if len(hits) < MIN_PHRASE_HITS:
        return None
    return (
        "El portal ha servido un reto anti-bot en lugar del anuncio "
        f"({len(hits)} señales: {', '.join(repr(h) for h in hits)}). "
        "La página no se ha ingerido y la fila del worklist sigue pendiente: "
        "resuelve el reto en el navegador y reanuda la captura."
    )
