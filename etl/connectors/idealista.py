"""Idealista connector — capture-only, no live network fetch (issue #75).

Task 1.4's feasibility spike already established Idealista returns an
immediate CAPTCHA/bot-detection challenge to every direct HTTP request,
regardless of User-Agent — not a robots.txt restriction, a hard wall (see
fotocasa.py's module docstring for the full comparison; Fotocasa became the
default connector instead). Bypassing that would mean CAPTCHA-solving or a
JS-executing headless browser, both explicitly out of scope per issue #1
§15 (this is a personal tool, not a scraping operation).

The answer this project settled on (matching a working pattern
`RealEstateWebTools/property_web_scraper` already ships, see
browser-extension/NOTICE.md): a browser extension captures the *rendered*
HTML of a listing page the owner is already looking at in their own
browser, and submits it for parsing — no automated fetch to Idealista ever
happens anywhere in this path.

This connector therefore:
  - `scope_key()` always returns None — the orchestrator's normal
    profile-driven sweep (etl.orchestrator.run_all_connectors) treats every
    scope as "no coverage" and skips straight past this connector without
    ever calling discover()/fetch_detail() (see the etl.orchestrator
    scope_key docstring for why that's a skip, not a failure). Registering
    it in etl.connectors.register_all() anyway keeps CONNECTORS as the one
    place every known site lives, and self-documents that Idealista support
    exists, even though its real entry point is elsewhere.
  - `discover()`/`fetch_detail()` exist only because `Connector` requires
    them; both raise immediately if ever actually called, as a defensive
    invariant (they never should be, given scope_key() above) rather than
    silently doing nothing.
  - The real entry point is `normalize()`, called directly by
    etl/capture.py's pending-capture poll with a `RawListing` built from
    HTML a human's browser rendered and the extension in browser-extension/
    submitted via POST /api/extension/capture (dashboard) ->
    extension_capture table (etl/schema/init.sql) -> here.

Batch capture pacing (issue #262, D-043): the extension can now drive a
listing/search page's detail links through the worklist automatically (open ->
activate -> auto-capture -> close -> advance). That is still real browser
navigation of pages a human asked to batch — but it MUST stay paced: the
extension keeps a jittered delay between pages precisely because Idealista sits
behind a CAPTCHA/bot wall that a burst would trip. Don't remove that pacing.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    RetiredNoticeFacts,
    Throttle,
)
from etl.connectors.extraction import first_present
from etl.connectors.idealista_mapping import (
    map_property_type,
    parse_floor,
    parse_has_elevator,
    parse_year_built,
    split_address,
)

logger = logging.getLogger("etl.connectors.idealista")

# --- Retired-advert notice detection (issue #690, D-159) -------------------
#
# Idealista answers a request for a REMOVED listing with an HTTP 200 carrying
# its own notice page — the one the owner reads as "lo sentimos, este anuncio
# ya no está publicado". That page keeps the site's generic chrome (its
# <title> is Idealista's site-wide "Viviendas venta. Viviendas alquiler.
# Pisos. Chalets — idealista", NOT the listing's own title) and carries no
# listing markup whatsoever.
#
# This is the ONE positive signal in this module. It matches the notice
# SENTENCE the portal itself renders — never the absence of listing fields,
# which is also what a soft block (D-047), a CAPTCHA wall, a rate-throttle
# and a half-rendered page look like. Conflating those with "gone" would let
# a throttle wall withdraw live inventory, which is the exact failure D-157
# and milanuncios.py's "no signature, deliberately" comment exist to prevent.
#
# Matched against the page's VISIBLE TEXT with <script>/<style> stripped and
# accents folded, so neither an inline JS string nor an "está"/"esta"
# spelling difference decides the outcome.
_RETIRED_NOTICE_RE = re.compile(
    r"\b(?:este\s+|el\s+)?(?:anuncio|inmueble)\b[^.!?]{0,40}?"
    r"\bya\s+no\s+esta\b\s+(?:publicad[oa]|disponible|activ[oa])\b"
)

# Folding table for the five Spanish accented vowels plus ñ — enough to make
# the notice match spelling-insensitive without pulling in `unicodedata`
# normalization of the whole page (these pages are ~400 KB).
_ACCENT_FOLD = str.maketrans(
    "áàäâéèëêíìïîóòöôúùüûñÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑ",
    "aaaaeeeeiiiioooouuuunAAAAEEEEIIIIOOOOUUUUN",
)


def _strip_to_visible_text(soup: BeautifulSoup) -> str:
    """The page's visible text, accent-folded, lowercased and
    whitespace-collapsed — the surface `_RETIRED_NOTICE_RE` is matched on.

    **Mutates `soup`**, removing every <script>/<style>/<noscript>, so a JS
    string literal or a CSS content rule can never supply the notice
    sentence: only text the human in front of the browser could actually
    have read counts as the portal saying something.

    Mutating rather than working on a copy is deliberate. These captures are
    ~400 KB and re-parsing one costs more than everything else this
    connector does; the single caller
    (`IdealistaConnector.retired_page_signature`) owns a private soup, and
    the tags removed here are disjoint from `_LISTING_DETAIL_SELECTORS`, so
    the markup check that follows is unaffected by the removal.
    """
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text.translate(_ACCENT_FOLD).lower())


# The blocks a real Idealista advert page always renders — its own title, its
# price box, its seller-written description, and its features table. Used in
# TWO places, for two DIFFERENT jobs, and the distinction matters:
#
#  * `retired_page_signature` — as a GUARD on a positive notice match, to rule
#    out a live advert that merely quotes the phrase.
#  * `normalize` — as a REFUSAL-TO-PARSE check, so a page carrying none of
#    this is never persisted as a listing.
#
# Neither use ever treats absence as evidence of WITHDRAWAL. Absence here
# only ever means "this is not a listing page" — which resolves to no write
# at all, not to a status change.
_LISTING_DETAIL_SELECTORS = (
    ".main-info__title-main",
    ".info-data-price",
    ".adCommentsLanguage",
    ".details-property_features",
)


def _has_listing_detail_markup(soup: BeautifulSoup) -> bool:
    """Does this page render ANY of a real advert's own detail blocks?"""
    return any(soup.select_one(sel) is not None for sel in _LISTING_DETAIL_SELECTORS)


# --- What the notice page STATES about the advert it replaced --------------
#
# Issue #691's hardening of D-159. D-159 shipped on the notice SENTENCE
# alone, which was all the page shape measured from production
# (`fields_extracted = 3`, no photos, site-wide <title>) appeared to offer.
# Reading a real notice page by hand afterwards showed it offers far more.
# Rendered, the owner's sample reads:
#
#     Lo sentimos, este anuncio ya no está publicado
#     Piso en venta en <calle>, <barrio>, <ciudad>
#     123.000 € 80 m² 3 hab.
#
#     Referencia del anuncio: 900000001
#
#     El anunciante lo dio de baja el 03/08/2026
#
# Three of those lines change what this connector can honestly claim:
#
#  * The REFERENCE is the advert's own id — the very digits the URL carries
#    in `/inmueble/<digits>/`. Without it, the sentence only supports "SOME
#    Idealista advert is gone"; a generic notice shell served at the wrong
#    URL (a mis-typed capture, a redirect, a stale tab, a portal bug) would
#    withdraw a listing the notice was never about. Requiring the printed
#    reference to equal the captured `external_id` turns the claim into
#    "Idealista says THIS advert is gone", which is the only claim strong
#    enough to change a row. It is REQUIRED, not a bonus: no reference, no
#    withdrawal (see `IdealistaConnector.normalize`).
#  * The DATE is when the advertiser actually pulled it. In the owner's
#    sample the advert had already been down for twelve days when the
#    page was captured — twelve days that stamping the transition `NOW()`
#    would invent
#    out of nothing, and that every "how long do adverts survive?" question
#    downstream would then get wrong.
#  * The PRICE/SIZE/ROOMS line is the advert's headline summary. Size and
#    rooms are structural facts that do not change while an advert is
#    live, so they corroborate: if the notice describes a 40 m² studio and
#    we stored a 120 m² four-bed, this notice is not about our listing and
#    nothing may be withdrawn. Price deliberately does NOT corroborate — a
#    seller repricing before delisting is ordinary behaviour, and a price
#    that moved is no reason at all to doubt a reference that matched.
#
# None of these values is ever written onto the `listing` row. They come
# from a weaker parse (plain rendered text) of facts the row already holds
# from a proper structured capture; overwriting good data on a row being
# marked dead would be all risk and no gain. They are recorded as EVIDENCE
# and, for size/rooms, used as a veto. See D-159.

# Both distinctive enough to match anywhere in the page's visible text.
_NOTICE_REFERENCE_RE = re.compile(r"referencia\s+del\s+anuncio\s*:?\s*(\d{3,})")
_NOTICE_DELISTED_RE = re.compile(
    r"\bdio\s+de\s+baja\s+el\s+(\d{1,2})/(\d{1,2})/(\d{4})\b"
)

# A whole number as either locale renders it — "123.000" (es-ES) and
# "123,000" (en, which idealista.com does serve; see
# `_strip_thousands_separators`) both mean the same thing. Written as
# "groups of exactly three" precisely so it can never swallow a DECIMAL
# comma/dot: "83,5 m²" matches "83", not "835". Truncating a fraction is
# safe here (it can only make a corroboration check stricter); reading
# 83,5 as 835 would silently veto a genuine withdrawal.
_NOTICE_INT = r"\d{1,3}(?:[.,]\d{3})+|\d+"
# ...followed by an OPTIONAL fraction that is matched and then thrown away.
# Without it the patterns would skip past the whole number and latch onto
# the fraction alone — "79,6 m²" read as 6 m², which would veto a perfectly
# good withdrawal. Capped at two digits so it can never eat a thousands
# group (which is always exactly three).
_NOTICE_FRACTION = r"(?:[.,]\d{1,2})?"
_NOTICE_PRICE_RE = re.compile(rf"({_NOTICE_INT}){_NOTICE_FRACTION}\s*€")
# `m²`, `m2` and `m 2` all appear across renderings; the lookahead stops
# "m2" from matching the start of a longer token.
_NOTICE_M2_RE = re.compile(rf"({_NOTICE_INT}){_NOTICE_FRACTION}\s*m\s*[²2](?![\w])")
_NOTICE_ROOMS_RE = re.compile(r"(\d{1,2})\s*hab\b")

# How far past the notice sentence the advert's headline summary can sit.
# The summary window is bounded — rather than searching the whole page — so
# a price or an "m²" from an unrelated block (the "anuncios similares"
# strip, a footer, a cookie banner) can never be recorded as this advert's
# stated figures. In the owner's sample the summary is ~80 characters long.
_NOTICE_SUMMARY_WINDOW = 250

# A delisting date this far in the past is not believed. Idealista does not
# keep serving a notice for an advert taken down a decade ago, so a date
# that old means the parse went wrong (a birthday in a cookie banner, a
# copyright line, a reworded page) — and a wrong date written into
# `listing_status_event.observed_at` is worse than no date, because it is
# indistinguishable from a real one afterwards. Falls back to the capture
# time, which is at least honestly "when we saw this".
_NOTICE_MAX_DELISTING_AGE_DAYS = 3650


def _notice_int(pattern: re.Pattern[str], text: str) -> Decimal | None:
    """First `pattern` match in `text` as a whole number, or None.

    Discards every thousands separator rather than trying to detect the
    locale — the same call this module already makes in
    `_strip_thousands_separators`, and correct under both es-ES and en
    because `_NOTICE_INT` only ever captures whole numbers.
    """
    match = pattern.search(text)
    if match is None:
        return None
    digits = re.sub(r"[^\d]", "", match.group(1))
    if not digits:
        return None
    try:
        return Decimal(digits)
    except InvalidOperation:  # pragma: no cover - unreachable for pure digits
        return None


def _notice_delisting_date(text: str, today: date) -> tuple[date | None, str | None]:
    """The date the notice says the advertiser withdrew the advert.

    Returns `(date, None)` when a believable date was read, `(None, note)`
    when the page stated one this function refuses to believe (the note goes
    into the evidence so the refusal is auditable rather than invisible),
    and `(None, None)` when the page states no date at all.

    Rejected: a date that does not exist (31/02), one in the FUTURE — a page
    cannot report a withdrawal that has not happened, so this is a
    misparse or a differently-ordered locale (MM/DD) — and one older than
    `_NOTICE_MAX_DELISTING_AGE_DAYS`. Every rejection falls back to the
    capture time, never to a guess.
    """
    match = _NOTICE_DELISTED_RE.search(text)
    if match is None:
        return None, None
    day, month, year = (int(group) for group in match.groups())
    raw = f"{match.group(1)}/{match.group(2)}/{match.group(3)}"
    try:
        parsed = date(year, month, day)
    except ValueError:
        parsed = None
    if parsed is None or not (
        today - timedelta(days=_NOTICE_MAX_DELISTING_AGE_DAYS) <= parsed <= today
    ):
        logger.warning(
            "idealista: retired notice states an implausible delisting date "
            "%r (today %s) — ignoring it and stamping the withdrawal with "
            "the capture time instead (D-159)",
            raw,
            today.isoformat(),
        )
        return None, (
            f"la fecha de baja declarada ({raw}) no es verosímil y se "
            "descarta; la retirada se fecha en el momento de la captura"
        )
    return parsed, None


_REFERENCE_INPUT_RE = re.compile(
    r'<input[^>]+name=["\']adId["\'][^>]+value=["\'](\d+)["\']', re.IGNORECASE
)
_PROPERTY_ID_FALLBACK_RE = re.compile(r"propertyId:\s*(\d+)")
# Idealista embeds a Google Static Maps URL (config.multimediaCarrousel.map.src
# in the real page's inline <script>) carrying the listing's coordinates in
# its `center` query param — e.g. "center=40.42569080%2C-3.67632170". An
# earlier version of this connector was built against a fixture that had
# this region trimmed out, and incorrectly concluded no coordinates exist
# anywhere in Idealista's page structure (Opus review, PR #87). The URL
# itself sits inside a JS object literal, not a DOM attribute — matched
# directly against the raw HTML rather than via BeautifulSoup.
_STATICMAP_CENTER_RE = re.compile(
    r"staticmap\?[^\"'\s]*[?&]center=(-?\d+\.\d+)%2C(-?\d+\.\d+)"
)
# Idealista's full photo gallery is NOT in the initial DOM (only one <img> /
# the og:image thumbnail renders before the carousel hydrates — issue #282,
# where only 1 of ~95 photos was being stored). It lives in inline <script>
# JS object literals, of which the page carries TWO with photo URLs in them:
#
#   1. `config.multimediaCarrousel` — the above-the-fold carousel. Its
#      `multimedias` array holds a `{"type":"PICTURE","content":[...]}` group
#      (plus separate PLAN/MAP groups we skip), and that content array is
#      only ever a **3-item preview**, regardless of how many photos the
#      advert really has. The same object's `totalMultimedias` reports the
#      true per-type counts (e.g. `[{"type":"PICTURE","total":18},...]`).
#      This is pure JSON.
#   2. `fullScreenGalleryPics` — a flat array with one entry per multimedia
#      item in the full-screen ("ver todas las fotos") gallery, i.e. the
#      COMPLETE set, already in page order. Each entry carries
#      `imageDataService` (jpg), `imageDataServiceWebp` (webp), and an
#      `isPlan` boolean marking the floor plans. This one is a JS object
#      literal with UNQUOTED keys, so it needs key-quoting before json.loads
#      (see _js_object_literal_to_json).
#
# Issue #654: this connector read only (1), so every idealista listing stored
# exactly 3 photos while the page it was parsing already carried all of them.
# Verified against production extension_capture id 3627 (idealista detail
# page, 437 KB of retained HTML): 3 photos in the carousel preview,
# `totalMultimedias` PICTURE=18, and `fullScreenGalleryPics` holding all 20
# multimedia items (18 photos + 2 `isPlan` floor plans). (1) is retained as a
# fallback for pages that don't carry (2).
#
# Size variant: `fullScreenGalleryPics` hands out the unsuffixed `WEB_DETAIL`
# rendition (1500px on the sample) whereas the carousel preview hands out
# `WEB_DETAIL-M-L`. We store each URL exactly as the page gave it — never
# rewritten into a variant we haven't seen resolve — and prefer the `.jpg`
# (`imageDataService`) over the `.webp` sibling, matching what every other
# connector stores and what the photo-hash fetcher is exercised on.
#
# Deduplication is therefore keyed on the size-and-extension-independent
# `id.<x>.es.image.master/xx/xx/xx/NNNN` path (_PHOTO_MASTER_RE), not on the
# full URL: the same photo appears across both objects at different
# renditions, and a raw-URL key would store it twice.
_MULTIMEDIA_HOST = "https://img4.idealista.com/blur/"
# The rendition-independent identity of an Idealista photo: everything from
# the `id.*.image.master` bucket marker through the numeric multimedia id,
# with the size segment (WEB_DETAIL / WEB_DETAIL-M-L / WEB_DETAIL_TOP-L-L)
# and the .jpg/.webp extension excluded.
_PHOTO_MASTER_RE = re.compile(r"(id\.[a-z0-9.]+\.image\.master/(?:[0-9a-f]{2}/){3}\d+)")


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _strip_thousands_separators(text: str | None) -> str | None:
    """Locale-agnostic digit extraction for whole-number listing
    prices/areas — deliberately NOT etl.connectors.extraction's
    strip_price_punctuation, which is es-ES-specific (comma = decimal,
    dot = thousands), correct for Fotocasa/Milanuncios but wrong here: the
    only real Idealista sample available to verify against renders in
    English locale ("3,600,000", comma = thousands, per this fixture's
    provenance — see module docstring), and idealista.com can plausibly
    also render in Spanish locale for a Spain-based owner's browser
    ("3.600.000", dot = thousands) — this connector can't assume which.
    Real-estate listing prices/areas don't carry meaningful decimal cents
    either way, so simply discarding every `,`/`.` and keeping only
    digits is correct under BOTH locales, without needing to detect which
    one a given capture came from."""
    if not text:
        return None
    digits = re.sub(r"[^\d]", "", text)
    return digits or None


class IdealistaConnector(Connector):
    name = "idealista"
    # Never actually crawls (see module docstring) — the rate limiter/
    # circuit breaker the base Connector class configures are inert for
    # this connector in practice, since scope_key() always returns None
    # before either would ever be exercised. Left at the class defaults
    # rather than removed: a future genuinely-automated Idealista path
    # (unlikely, but not this connector's call to foreclose) would need
    # them, and there's no harm in configuring something that's never used.
    # Issue #100: capture-only. scope_key() always returns None, so the
    # orchestrator skips every scope for this connector by design — there
    # is no live discover() to schedule, scope, or filter. The connector
    # management UI reads this to render an explicit "capture-only" state
    # rather than geography/filter controls that could never take effect.
    supports_discovery = False
    discovers_full_inventory = False  # No discover() sweep ever runs at all
    # (not even a partial one) — see EC-relevant note in
    # docs/architecture/connectors.md: withdrawal auto-transition
    # (etl.orchestrator._reconcile_missed_discoveries) never applies to a
    # capture-only source; a captured listing's status only ever changes
    # if the owner captures the same URL again later and it shows
    # different content. That second path now EXISTS (issue #690, D-159):
    # re-capturing a URL that Idealista answers with its "anuncio retirado"
    # notice raises ListingUnavailableError from normalize(), and
    # etl/capture.py marks the listing `withdrawn` with the notice cited as
    # evidence. It is the only evidence channel a capture-only, WAF-walled
    # portal has (D-081), and it costs zero automated requests: the owner
    # was already looking at the page.

    def scope_key(self, scope: ConnectorScope) -> str | None:
        return None

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise ConnectorError(
            "idealista discover: not supported — this connector is "
            "capture-only (see module docstring). scope_key() returning "
            "None should have stopped the orchestrator from ever calling "
            "this; if you're seeing this error, that invariant broke."
        )

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise ConnectorError(
            "idealista fetch_detail: not supported — this connector never "
            "makes a live network request (see module docstring). Listings "
            "arrive via POST /api/extension/capture, processed by "
            "etl/capture.py, which calls normalize() directly."
        )

    @staticmethod
    def external_id_from_url(url: str) -> str | None:
        """Idealista listing URLs are `.../inmueble/<digits>/` — the
        canonical id also appears as `adId`/`propertyId` inside the page,
        but the URL is available before any HTML parsing, and is what
        etl/capture.py uses to build the RawListing this connector's
        normalize() then processes."""
        match = re.search(r"/inmueble/(\d+)/", url)
        return match.group(1) if match else None

    def retired_page_signature(
        self, html: str, final_url: str | None = None
    ) -> str | None:
        """Idealista's own "this advert is gone" notice, positively
        identified — or None (issue #690, D-159).

        Returns a short Spanish citation of what the portal rendered, which
        becomes `listing_status_event.evidence`. The base class contract is
        deliberately strict about what may return non-None here (see
        `Connector.retired_page_signature`): only a marker the SITE ITSELF
        put on the page. This override honours that by matching the notice
        sentence and nothing else.

        Thin wrapper over `retired_notice_facts`, which does the actual
        recognition — so the two can never disagree about whether a page is
        a notice. Everything about how the page is identified is documented
        there.

        **This answers "is this page a retired-advert notice?", NOT "is
        THIS listing retired?"** It cannot answer the second: nothing here
        knows which listing the caller has in mind. The corroboration that
        ties a notice to one specific listing (a printed reference equal to
        the captured `external_id`) lives in `normalize`, which does know —
        and `normalize` is the only path by which an Idealista capture can
        ever withdraw anything. A future caller that withdraws on this
        method's return value alone would be skipping that check.

        `final_url` is accepted for contract compatibility and unused:
        Idealista serves the notice at the listing's own URL with a 200 and
        does not redirect, so there is no URL-shaped signal to read (unlike
        fotocasa's `?propertyNotFound`).
        """
        facts = self.retired_notice_facts(html, final_url)
        return facts.citation if facts is not None else None

    def retired_notice_facts(
        self, html: str, final_url: str | None = None
    ) -> RetiredNoticeFacts | None:
        """Recognise Idealista's "anuncio retirado" notice and read
        everything it states (issue #690, D-159; facts added by #691).

        Two independent conditions must BOTH hold before this returns
        anything at all, and they are not redundant:

        1. The notice sentence is present in the page's visible text. This
           is the positive evidence — the only thing that can ever make this
           method return non-None.
        2. The page carries none of the listing's own detail markup. This is
           NOT evidence and is never sufficient on its own; it is a guard
           against the one false-positive route condition 1 leaves open — a
           LIVE advert whose seller-written description happens to quote the
           phrase (an agency writing "si ve que el anuncio ya no está
           publicado, llámenos", say). A live advert always renders its own
           price/title/description block, so requiring its absence closes
           that route without ever letting absence alone withdraw anything.

        What the notice STATES (reference, delisting date, headline
        price/size/rooms) is then parsed out of the same visible text. A
        field the page does not state comes back None, and callers must
        read that as "no information" — see `RetiredNoticeFacts`. Parsing
        none of them does not un-identify the page: a reworded notice that
        still says the sentence is still a notice, it just carries less
        evidence, and it is the CALLER that decides whether the evidence it
        does carry is enough to change a row.
        """
        if not html:
            return None
        # One parse, and the cheap positive gate first: on the overwhelming
        # majority of captures (real adverts) the regex misses and this
        # returns immediately without the markup check.
        soup = BeautifulSoup(html, "html.parser")
        text = _strip_to_visible_text(soup)
        match = _RETIRED_NOTICE_RE.search(text)
        if match is None:
            return None
        if _has_listing_detail_markup(soup):
            # Condition 2 failed: the page IS a real advert that merely
            # mentions the phrase. Not retired — say nothing.
            logger.info(
                "idealista: retired-notice phrase %r found on a page that "
                "still renders real listing markup — treating as a LIVE "
                "advert quoting the phrase, not a retired page (D-159)",
                match.group(0),
            )
            return None

        phrase = match.group(0)
        reference_match = _NOTICE_REFERENCE_RE.search(text)
        reference = reference_match.group(1) if reference_match is not None else None

        # The advert's headline summary sits between the notice sentence and
        # the reference line. Bounded on BOTH ends (see
        # _NOTICE_SUMMARY_WINDOW) so no unrelated number on the page can be
        # recorded as this advert's stated price/size/rooms.
        summary_end = match.end() + _NOTICE_SUMMARY_WINDOW
        if reference_match is not None:
            summary_end = min(summary_end, reference_match.start())
        summary = text[match.end() : max(summary_end, match.end())]

        stated_m2 = _notice_int(_NOTICE_M2_RE, summary)
        stated_rooms = _notice_int(_NOTICE_ROOMS_RE, summary)
        # Read AFTER the m² figure has been taken out of the running: on a
        # page rendered without the € sign the price pattern could otherwise
        # latch onto the area. (It cannot as written — the pattern requires
        # the € — but the ordering keeps that assumption cheap to revisit.)
        stated_price = _notice_int(_NOTICE_PRICE_RE, summary)

        delisted_on, date_note = _notice_delisting_date(
            text, datetime.now(timezone.utc).date()
        )

        parts = [
            (
                "Página de anuncio retirado de Idealista: la propia web "
                f"muestra «{phrase}» y la ficha no existe (sin precio, sin "
                "descripción, sin galería)"
            )
        ]
        parts.append(
            f"referencia del anuncio en el aviso: {reference}"
            if reference is not None
            else "el aviso no imprime «Referencia del anuncio»"
        )
        if delisted_on is not None:
            parts.append(
                f"el anunciante lo dio de baja el {delisted_on.strftime('%d/%m/%Y')}"
            )
        elif date_note is not None:
            parts.append(date_note)
        else:
            parts.append("el aviso no declara fecha de baja")
        stated = [
            f"{value}{unit}"
            for value, unit in (
                (stated_price, " €"),
                (stated_m2, " m²"),
                (stated_rooms, " hab."),
            )
            if value is not None
        ]
        parts.append(
            "datos declarados en el aviso: " + ", ".join(stated)
            if stated
            else "el aviso no declara precio, superficie ni habitaciones"
        )

        return RetiredNoticeFacts(
            citation="; ".join(parts),
            reference=reference,
            delisted_on=delisted_on,
            stated_price=stated_price,
            stated_m2=stated_m2,
            stated_rooms=int(stated_rooms) if stated_rooms is not None else None,
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        html = raw.raw.get("html", "")
        soup = BeautifulSoup(html, "html.parser")

        # Issue #690 / D-159. Before parsing anything: is this the portal's
        # own "anuncio retirado" notice rather than a listing? Checked FIRST,
        # because every field below degrades to None on such a page and the
        # result would otherwise be a plausible-looking-but-empty listing —
        # which is precisely what production was persisting (26 non-advert
        # rows, see D-159). `ListingUnavailableError` is the codebase's
        # established "the source says this listing is gone" signal (D-049).
        #
        # Issue #691 adds the corroboration the sentence alone cannot give.
        # A notice page is generic chrome: the same shell for every dead
        # advert. On its own the sentence supports "SOME Idealista advert is
        # gone", and acting on that would let a notice shell served at the
        # wrong URL withdraw a listing it was never about. The printed
        # reference is the advert's OWN id — the same digits the URL carries
        # in /inmueble/<digits>/, which is exactly what `raw.external_id`
        # holds — so requiring the two to be equal upgrades the claim to
        # "Idealista says THIS advert is gone".
        #
        # Required, not preferred. A notice with no reference, or with
        # someone else's, withdraws NOTHING: it falls out to the same
        # `ConnectorError` a bot wall gets — capture recorded `failed`, not
        # one row touched. Raised right here rather than by falling through
        # to the zero-substantive-fields guard below, which would reach the
        # identical outcome for today's notice pages but is not guaranteed
        # to: the guard counts `og:image` as substantive, and a notice page
        # rendering the site logo there would sail through it and be
        # persisted as a listing. Same exception class, same handling in
        # etl/capture.py, message that names what actually happened.
        facts = self.retired_notice_facts(html, raw.raw.get("url"))
        if facts is not None:
            captured_id = str(raw.external_id).strip()
            if facts.reference is None:
                raise ConnectorError(
                    f"idealista {captured_id}: the captured page IS the "
                    "portal's 'anuncio retirado' notice, but it prints no "
                    "«Referencia del anuncio», so there is nothing tying it "
                    "to this listing rather than to any other dead advert. "
                    "Refusing to withdraw on an uncorroborated notice "
                    "(issue #691, D-159); nothing about any listing has been "
                    f"changed. Notice read as: {facts.citation}"
                )
            if facts.reference != captured_id:
                raise ConnectorError(
                    f"idealista {captured_id}: the captured page is a "
                    "'anuncio retirado' notice for a DIFFERENT advert — it "
                    f"prints «Referencia del anuncio: {facts.reference}» "
                    f"while this capture is of /inmueble/{captured_id}/. "
                    "That mismatch means the page and the URL disagree "
                    "about which listing this is, so nothing may be "
                    "withdrawn (issue #691, D-159). Nothing about any "
                    "listing has been changed."
                )
            # Corroborated. Size/rooms are checked too, but not here: that
            # comparison needs the STORED listing, which this method has no
            # access to and must not acquire — see etl/capture.py's
            # `_notice_contradicts_stored`.
            raise ListingUnavailableError(facts.citation)

        title_el = soup.select_one(".main-info__title-main")
        title = (
            title_el.get_text(strip=True)
            if title_el is not None
            else first_present(
                lambda: _og_meta(soup, "og:title"),
                lambda: soup.title.get_text(strip=True) if soup.title else None,
                field="title",
            )
        )

        address_el = soup.select_one(".main-info__title-minor")
        address_string = (
            address_el.get_text(strip=True) if address_el is not None else None
        )
        address, city = split_address(address_string)

        reference_code = first_present(
            lambda: _reference_from_input(html),
            lambda: _reference_from_script(html),
            field="reference_code",
        )

        price_el = soup.select_one(".info-data-price .txt-bold")
        current_price = (
            _to_decimal(_strip_thousands_separators(price_el.get_text(strip=True)))
            if price_el is not None
            else None
        )

        description_el = soup.select_one(".adCommentsLanguage")
        description = first_present(
            lambda: (
                description_el.get_text(strip=True)
                if description_el is not None
                else None
            ),
            lambda: _og_meta(soup, "og:description"),
            field="description",
        )

        basic_features_text = _basic_features_text(soup)

        rooms = first_present(
            lambda: _count_from_features_li(soup, "bedroom"),
            field="rooms",
        )
        bathrooms = first_present(
            lambda: _count_from_features_li(soup, "bathroom"),
            field="bathrooms",
        )
        m2_built = first_present(
            lambda: _area_from_features_li(soup),
            field="m2_built",
        )

        # Full gallery from the embedded fullScreenGalleryPics array,
        # falling back to the carousel's 3-item preview (issue #282, #654 —
        # see the _MULTIMEDIA_HOST comment block); the og:image is only the
        # single hydration thumbnail and is used solely as a fallback when
        # neither inline object is present or parseable.
        gallery = _photo_gallery(html)
        if gallery:
            photo_urls: tuple[str, ...] = gallery
        else:
            main_image = _og_meta(soup, "og:image")
            photo_urls = (main_image,) if main_image else ()

        # Did we get everything the page says it has? Every way the
        # full-gallery parse can break degrades to the carousel's 3-item
        # preview — which is exactly the bug this connector just fixed, and
        # it would come back silently the next time Idealista renames a key
        # (Opus review, PR #678). _declared_photo_total is parsed
        # independently of the gallery itself, so it survives that.
        declared_photo_total = _declared_photo_total(html)
        gallery_health: dict[str, Any] = {}
        if declared_photo_total is None:
            # No expected count to compare against — the check is blind on
            # this page, which is itself worth knowing (both sources gone
            # would mean a page shape this connector has never seen).
            logger.warning(
                "idealista %s: page declares no photo total "
                "(neither multimediaCarrousel.totalMultimedias nor "
                "picturesWithoutPlans is readable) — parsed %d photo(s), "
                "cannot verify the gallery is complete",
                raw.external_id,
                len(photo_urls),
            )
        else:
            gallery_health["photo_gallery_declared_total"] = declared_photo_total
            truncated = len(photo_urls) < declared_photo_total
            gallery_health["photo_gallery_truncated"] = truncated
            if truncated:
                logger.warning(
                    "idealista %s: parsed %d photo(s) but the page declares "
                    "%d — the full-gallery parse has degraded (see D-155); "
                    "flagged raw_extra.photo_gallery_truncated",
                    raw.external_id,
                    len(photo_urls),
                    declared_photo_total,
                )

        coordinates = _coordinates_from_staticmap(html)
        lat, lon = coordinates if coordinates is not None else (None, None)

        # Issue #690 / D-159 — the refusal-to-parse check.
        #
        # `retired_page_signature` above catches the notice page we can NAME.
        # This catches every OTHER non-advert page served at a listing URL
        # with a 200: a CAPTCHA/bot wall (which Idealista is known to serve —
        # see this module's docstring), a login interstitial, a redesigned
        # notice whose wording this connector has not learned yet, a
        # half-rendered capture.
        #
        # Until this landed, every one of those parsed "successfully" into a
        # listing whose every real field was None, and etl/capture.py
        # persisted it. Measured in production before the fix: 26 idealista
        # rows whose last capture was a NON-ADVERT page of some kind (the
        # stored footprint cannot say which kind — see D-159), of which 18
        # were listings CREATED from such a page (no price,
        # no description, no photos, property_type 'piso' fabricated from the
        # site-wide <title> "Viviendas venta. Viviendas alquiler. Pisos.
        # Chalets — idealista") and 8 were real adverts whose stored photo
        # gallery was ERASED — `_update_existing_listing` COALESCEs scalars
        # but assigns `photo_urls` unconditionally, so an empty parse wipes
        # it. All 26 also had `last_seen_at` pushed to now, making a gone
        # listing look freshly confirmed alive.
        #
        # Raising `ConnectorError` (NOT `ListingUnavailableError`) is the
        # whole point: this is "I cannot tell what this page is", which under
        # D-157 is no evidence at all. The capture is recorded as `failed`
        # for the operator to see, and nothing about the listing changes.
        #
        # The threshold is "not one substantive field", chosen against the
        # measured production distribution: real adverts extract 9-15 fields,
        # non-adverts extract exactly 3 — and all 3 are structural (`url` is
        # handed in, `operation` is hardcoded, `property_type` is derived
        # from that site-wide title), so ZERO substantive fields separates the
        # two populations with the whole 9-field gap to spare.
        substantive = {
            "current_price": current_price,
            "description": description,
            "address": address,
            "reference_code": reference_code,
            "m2_built": m2_built,
            "rooms": rooms,
            "bathrooms": bathrooms,
            "coordinates": coordinates,
            "photos": photo_urls or None,
            "features_block": basic_features_text,
            "listing_title": title_el,
        }
        if not any(v is not None for v in substantive.values()):
            raise ConnectorError(
                f"idealista {raw.external_id}: the captured page carries no "
                "listing data at all — not a price, title, description, "
                "address, reference, area, room count, coordinates, photo or "
                "features block, and it is not the recognised 'anuncio "
                "retirado' notice either. This is a bot wall, a login "
                "interstitial, a half-rendered capture or a page shape this "
                "connector has not learned; refusing to persist it as a "
                "listing (issue #690, D-159). Nothing about any existing "
                "listing has been changed."
            )

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind=None,  # No reliable particular/agency signal found
            # in the sample page (unlike Fotocasa's clientUrl/-Name pattern,
            # see fotocasa_mapping.infer_listing_kind) — left undetermined
            # rather than guessed.
            status="active",  # A captured listing is, by construction,
            # a page the owner was just looking at right now — "active" is
            # the only status this connector can honestly assert. Reaching
            # this line already proves the page is a real advert: the
            # retired-notice check and the refusal-to-parse guard above both
            # ran first (issue #690, D-159), so "active" is now an assertion
            # about a page with real listing content on it, not a default.
            current_price=current_price,
            description=description,
            photo_urls=photo_urls,
            contact_raw=_advertiser_name(soup),  # Issue #628: the primary
            # contact box's `.advertiser-info .advertiser-name` — None if
            # this capture's page lacks the block (a future markup change,
            # or the owner captured a page where it never rendered).
            reference_code=reference_code,
            address=address,
            lat=lat,  # From the embedded Google Static Maps `center` param
            # (see _coordinates_from_staticmap) — real per-listing
            # coordinates, contrary to an earlier version of this
            # connector's incorrect "no coordinates anywhere" conclusion
            # (Opus review, PR #87). None only if a given capture's page
            # genuinely lacks the map block (e.g. the owner hid the map, or
            # a future Idealista redesign moves it) — the dedup engine's
            # address_coords signal degrades gracefully to skipping this
            # property when that happens, same as any other connector.
            lon=lon,
            property_type=map_property_type(title),
            m2_built=m2_built,
            m2_useful=None,  # No separate built-vs-useful distinction found.
            rooms=rooms,
            bathrooms=bathrooms,
            floor=parse_floor(basic_features_text),
            has_elevator=parse_has_elevator(basic_features_text),
            year_built=parse_year_built(basic_features_text),
            energy_rating=None,  # Investigated: the sample page's energy
            # certificate block has numeric kWh/CO2 values and a "b" class
            # suffix on the certificate image markup (icon-energy-c-b,
            # left-b/right-b) that might encode a letter grade, but a
            # single sample isn't enough to confirm which class actually
            # varies by grade vs. which is static styling — left None
            # rather than guess. Revisit once a second real capture is
            # available to compare against.
            city=city,
            province=None,  # No structured province field found; the
            # compound address string (split_address) doesn't reliably
            # separate one out either.
            postal_code=None,
            m2_plot=None,  # No plot-size field found (expected: this
            # sample is a flat, not a plot-having property type).
            features=(),
            operation="sale",  # es_idealista.json's own mapping derives
            # this from an `operation: 'sale'|'rent'` key in the page's
            # embedded JS object (see property_web_scraper's booleanFields
            # section) — not implemented here since the trimmed fixture
            # this connector was built against only has 'sale' to verify
            # against; the JSON key itself (`operation:`) is straightforward
            # to extract via regex if/when a real 'rent' sample is
            # available to confirm the value format against.
            raw_extra={
                "capture_source": "browser-extension",
                # No `title` column exists on `property`/`listing` (this
                # schema uses `address`/`description` instead) — kept here
                # purely so etl/capture.py can show something readable in
                # the extension popup's result card without inventing a
                # new canonical field just for that one UI need.
                "title": title,
                # Gallery-completeness check (#654 / D-155): present as a
                # {declared_total, truncated} pair whenever the page states
                # a photo total, absent when it states none. Absence and
                # `truncated: true` are both queryable health signals.
                **gallery_health,
            },
        )


def _advertiser_name(soup: BeautifulSoup) -> str | None:
    """The agency/advertiser name from the primary contact box (issue #628).

    Real markup (verified against a full real Idealista listing page fetched
    from the MIT-licensed `RealEstateWebTools/property_web_scraper` fixture
    repo this connector's original fixture was itself trimmed from — see
    `idealista_sample_detail.html`'s header comment; only the class-name
    shape below is taken from that page, the fixture's own test value is
    synthetic):

        <div id="module-contact-container">
          <section class="module-contact">
            <div class="advertiser-info">
              <p class="advertiser-name">Inmobiliaria Ejemplo</p>

    Scoped to `.advertiser-info .advertiser-name` (the primary per-listing
    contact box), not the page's OTHER `.advertiser-name`-shaped elements —
    a real captured page also carries an "about the professional" widget
    (`.about-advertiser-name`, a *different* class) that can name a
    different office/branch of the same firm; that one is deliberately not
    read here.
    """
    el = soup.select_one(".advertiser-info .advertiser-name")
    if el is None:
        return None
    text = el.get_text(" ", strip=True)
    return text or None


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _extract_js_object(text: str, key: str) -> str | None:
    """Return the raw `{...}` object literal assigned to `key:` in an inline
    <script>, or None. String-aware brace matcher so a `{`/`}` inside a
    quoted value (a URL's query string, a photo description) can't unbalance
    the scan. The matched substring is valid JSON (Idealista emits these
    objects as JSON, e.g. `multimediaCarrousel: {"map":{...}}`)."""
    match = re.search(re.escape(key) + r"\s*:\s*\{", text)
    if not match:
        return None
    start = text.index("{", match.end() - 1)
    depth = 0
    in_str = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _extract_js_array(text: str, key: str) -> str | None:
    """Return the raw `[...]` array literal assigned to `key:` in an inline
    <script>, or None. Same string-aware balanced scan as
    _extract_js_object, but anchored on `[` and counting both bracket
    kinds, so a `]`/`}` inside a quoted value (a photo caption, a URL query
    string) can't unbalance it. The result is a JS array literal, which is
    not necessarily valid JSON — see _js_object_literal_to_json."""
    match = re.search(re.escape(key) + r"\s*:\s*\[", text)
    if not match:
        return None
    start = text.index("[", match.end() - 1)
    depth = 0
    in_str = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


_UNQUOTED_KEY_RE = re.compile(r"(?<=[{,])(\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)")


def _js_object_literal_to_json(literal: str) -> str:
    """Quote the bare identifier keys of a JS object literal so json.loads
    can read it.

    `fullScreenGalleryPics` mixes quoted and unquoted keys in the same
    object (`{"isPlan":false,hoverText:"Salón",...}`), which is legal
    JavaScript but not JSON. The rewrite is applied only to the regions of
    the literal that are OUTSIDE double-quoted strings — a caption or a URL
    containing something that looks like `foo:` (e.g. `https:`) must never
    be rewritten. Values are left untouched, so a genuinely malformed
    literal still fails at json.loads rather than being silently coerced.
    """
    out: list[str] = []
    buf: list[str] = []
    in_str = False
    escaped = False
    for ch in literal:
        if in_str:
            buf.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
                out.append("".join(buf))
                buf = []
        elif ch == '"':
            out.append(_UNQUOTED_KEY_RE.sub(r'\1"\2"\3', "".join(buf)))
            buf = [ch]
            in_str = True
        else:
            buf.append(ch)
    tail = "".join(buf)
    out.append(tail if in_str else _UNQUOTED_KEY_RE.sub(r'\1"\2"\3', tail))
    return "".join(out)


def _photo_identity(url: str) -> str:
    """Rendition-independent dedup key for a photo URL: the
    `id.*.image.master/xx/xx/xx/NNNN` path if the URL is an Idealista image
    CDN URL (so `WEB_DETAIL/....jpg` and `WEB_DETAIL-M-L/....webp` of the
    same photo collapse to one), otherwise the URL itself (an unrecognised
    shape dedups exactly, as before — never more loosely)."""
    match = _PHOTO_MASTER_RE.search(url)
    return match.group(1) if match else url


def _absolutise(src: str) -> str:
    return src if src.startswith("http") else _MULTIMEDIA_HOST + src.lstrip("/")


def _photo_gallery(html: str) -> tuple[str, ...]:
    """Every real photo on the page, in the page's own gallery order,
    deduplicated across renditions (see _photo_identity).

    `fullScreenGalleryPics` is the complete set and is read first, so its
    order — which is the gallery order, and therefore puts the cover shot
    first — is the order stored. `config.multimediaCarrousel` is then read
    for anything the full-screen array didn't already cover, which on a
    normal page is nothing (its 3-item preview is the first three gallery
    entries) but keeps this working on a page that carries only the
    carousel. Empty tuple if neither object is present or parseable (the
    caller then falls back to the og:image thumbnail).
    """
    urls: list[str] = []
    seen: set[str] = set()
    for url in _gallery_from_fullscreen(html) + _gallery_from_carousel(html):
        identity = _photo_identity(url)
        if identity not in seen:
            seen.add(identity)
            urls.append(url)
    return tuple(urls)


def _declared_photo_total(html: str) -> int | None:
    """How many real (non-plan) photos the page says it has, or None if it
    doesn't say.

    This is the page's own answer to "did we parse everything?", and it is
    what makes a silent parser degradation loud (issue #654, Opus review of
    PR #678). Every one of `_gallery_from_fullscreen`'s failure modes —
    `fullScreenGalleryPics` renamed, a trailing comma or a single-quoted
    value making `json.loads` reject the literal, `isPlan: undefined`,
    `imageDataService` renamed — returns an empty tuple, and the carousel
    fallback then quietly yields exactly the 3-item preview that was the
    original bug. Nothing about that is distinguishable from a genuine
    3-photo advert without an independently-parsed expected count.

    Two independent sources, both observed on capture 3627, so a rename of
    either one alone still leaves the check armed:

      * `config.multimediaCarrousel.totalMultimedias` — pure JSON,
        `[{"type":"PICTURE","total":18},{"type":"PLAN","total":2},...]`.
        PICTURE is photos; PLAN/MAP/VIDEO/VIRTUAL_TOUR_360/HOME_STAGING are
        not and are excluded, matching what `photo_urls` stores.
      * `picturesWithoutPlans` — the sibling of `fullScreenGalleryPics`
        holding exactly the entries whose `isPlan` is false (18 on capture
        3627, corroborating the PICTURE total). Its LENGTH is used; its URLs
        are deliberately not read, so this stays a check and not a third
        extraction path.

    The larger of whatever is readable is returned: an expected count that
    is too low would mask a shortfall, which is the whole thing being
    guarded against.
    """
    totals: list[int] = []

    raw_carousel = _extract_js_object(html, "multimediaCarrousel")
    if raw_carousel:
        try:
            data = json.loads(raw_carousel)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict):
            for entry in data.get("totalMultimedias") or []:
                if not isinstance(entry, dict) or entry.get("type") != "PICTURE":
                    continue
                total = entry.get("total")
                if isinstance(total, int) and not isinstance(total, bool):
                    totals.append(total)

    raw_pictures = _extract_js_array(html, "picturesWithoutPlans")
    if raw_pictures:
        try:
            pictures = json.loads(_js_object_literal_to_json(raw_pictures))
        except (ValueError, TypeError):
            pictures = None
        if isinstance(pictures, list):
            totals.append(len(pictures))

    return max(totals) if totals else None


def _gallery_from_fullscreen(html: str) -> tuple[str, ...]:
    """Every non-plan photo from the `fullScreenGalleryPics` array, in page
    order, as its `imageDataService` (.jpg) URL.

    Entries with `isPlan: true` are floor plans, not photos, and are
    skipped — the same exclusion the carousel path makes by only reading
    its PICTURE group. `isPlan` is the only reliable discriminator here:
    on the real sample the plans sit on the same `id.pro.es.image.master`
    bucket as the photos, so a URL-shape check would not catch them.

    Array order is used deliberately in preference to the entries' own
    `absolutePosition` field, because on the real sample (capture 3627)
    that field IS NOT A POSITION for 2 of the 20 entries: the two most
    recently added items carry their own 10-digit `multimediaId` there,
    where a 1-18 index belongs. Sorting ascending on it happens to produce
    the same order on this one sample — the objection is not that the
    result would differ here, it is that the field does not mean what its
    name says and the next page with a differently-numbered late item
    would reorder the gallery. Array order needs no such assumption.
    """
    raw = _extract_js_array(html, "fullScreenGalleryPics")
    if not raw:
        return ()
    try:
        data = json.loads(_js_object_literal_to_json(raw))
    except (ValueError, TypeError):
        return ()
    if not isinstance(data, list):
        return ()
    urls: list[str] = []
    for item in data:
        if not isinstance(item, dict) or item.get("isPlan"):
            continue
        src = item.get("imageDataService")
        if not isinstance(src, str) or not src:
            continue
        urls.append(_absolutise(src))
    return tuple(urls)


def _gallery_from_carousel(html: str) -> tuple[str, ...]:
    """Every PICTURE `src` from `config.multimediaCarrousel.multimedias`, in
    page order, deduplicated, prefixed with the img host for partial paths
    (see _MULTIMEDIA_HOST). PLAN/MAP groups are skipped — only real photos
    become photo_urls. Empty tuple if the object is absent or unparseable.

    This is the FALLBACK path (#654): on a real detail page this array is
    only ever a 3-item preview of the full gallery, so _photo_gallery reads
    `fullScreenGalleryPics` first and only falls back here. Kept because a
    page that carries the carousel and not the full-screen array still
    yields those three rather than dropping to the og:image thumbnail.

    `multimediaCarrousel` (singular) is the detail page's own object; the
    plural `listingMultimediaCarrousels` (a search page's per-listing map,
    capital-M and trailing 's') is deliberately NOT matched by the key
    regex, which anchors on the lowercase singular form ending in a colon."""
    raw = _extract_js_object(html, "multimediaCarrousel")
    if not raw:
        return ()
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return ()
    if not isinstance(data, dict):
        return ()
    urls: list[str] = []
    seen: set[str] = set()
    for group in data.get("multimedias") or []:
        if not isinstance(group, dict) or group.get("type") != "PICTURE":
            continue
        for item in group.get("content") or []:
            if not isinstance(item, dict):
                continue
            src = item.get("src")
            if not isinstance(src, str) or not src:
                continue
            url = _absolutise(src)
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return tuple(urls)


def _coordinates_from_staticmap(html: str) -> tuple[Decimal, Decimal] | None:
    """(lat, lon) from the embedded Google Static Maps `center` param, or
    None if the page doesn't carry one (see _STATICMAP_CENTER_RE)."""
    match = _STATICMAP_CENTER_RE.search(html)
    if not match:
        return None
    lat, lon = _to_decimal(match.group(1)), _to_decimal(match.group(2))
    if lat is None or lon is None:
        return None
    return lat, lon


def _area_with_decimal(text: str) -> Decimal | None:
    """Parse a listing area figure, preserving a genuine decimal separator.

    Unlike price (`_strip_thousands_separators` — real-estate prices don't
    carry meaningful cents either way), area figures do carry meaningful
    decimals (e.g. "114,6 m²"), and this connector can't assume which
    locale a capture renders in (see _strip_thousands_separators'
    docstring). Naively stripping every `.`/`,` would turn "114,6" into
    1146 — a real 10x error (Opus review, PR #87), the same bug class
    already fixed for Fotocasa/Milanuncios in etl/connectors/extraction.py,
    but that helper is es-ES-specific and wrong for Idealista's ambiguous
    locale. Heuristic: exactly one separator, followed by 1-2 digits at the
    end of the number, is treated as a decimal point; anything else
    (multiple separators, or 3+ trailing digits) is a thousands separator
    and stripped entirely — real areas never have 3-digit decimal
    fractions, so this can't misfire on a genuine "3.600.000"-style
    thousands-separated whole number.
    """
    positions = [i for i, ch in enumerate(text) if ch in ".,"]
    if len(positions) == 1:
        sep = positions[0]
        decimals = text[sep + 1 :]
        if 1 <= len(decimals) <= 2 and decimals.isdigit():
            integer_part = re.sub(r"[^\d]", "", text[:sep])
            if integer_part:
                return _to_decimal(f"{integer_part}.{decimals}")
    digits = re.sub(r"[^\d]", "", text)
    return _to_decimal(digits) if digits else None


def _reference_from_input(html: str) -> str | None:
    match = _REFERENCE_INPUT_RE.search(html)
    return match.group(1) if match else None


def _reference_from_script(html: str) -> str | None:
    match = _PROPERTY_ID_FALLBACK_RE.search(html)
    return match.group(1) if match else None


def _basic_features_text(soup: BeautifulSoup) -> str | None:
    """Join every `.details-property_features` block's text — rooms,
    bathrooms, area, floor, elevator, and year-built all live somewhere in
    these blocks as plain `<li>` text (see idealista_mapping.py's parsers),
    not one single reliably-labelled element each."""
    blocks = soup.select(".details-property_features")
    if not blocks:
        return None
    return "\n".join(block.get_text(separator="\n") for block in blocks)


def _count_from_features_li(soup: BeautifulSoup, keyword: str) -> int | None:
    """`.details-property_features li` items like "4 bedrooms"/"5 bathrooms" —
    property_web_scraper's own mapping locates these by fixed list index
    (cssCountId "1"/"2"), which is fragile to a block gaining/losing an
    item above it. Matching on the keyword text itself instead is
    positionally robust, at the cost of depending on the English label
    wording holding (or a Spanish "habitaciones"/"baños" equivalent if a
    listing renders in Spanish — not yet handled, since the only sample
    available to verify against renders in English)."""
    for li in soup.select(".details-property_features li"):
        text = li.get_text(strip=True)
        if keyword in text.lower():
            match = re.match(r"\d+", text)
            if match:
                return _to_int(match.group(0))
    return None


def _area_from_features_li(soup: BeautifulSoup) -> Decimal | None:
    for li in soup.select(".details-property_features li"):
        text = li.get_text(strip=True)
        if "m²" in text or "m2" in text.lower():
            match = re.match(r"[\d.,]+", text)
            if match:
                return _area_with_decimal(match.group(0))
    return None
