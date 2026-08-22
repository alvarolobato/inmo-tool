"""Processes browser-extension listing captures (issue #75).

See etl/schema/init.sql's extension_capture table comment for the full
"why a queue table, not a synchronous call" explanation: the dashboard
(Node/TypeScript) and this connector's parsing logic (Python, sharing
etl/connectors/extraction.py with the automated connectors) run in
separate containers with no shared filesystem or RPC channel.

`process_pending_captures` is polled on a short interval by
etl/main.py — separate from the hourly connector sweep
(etl.orchestrator.run_scheduler_loop), since a human waiting on the
extension's popup for a result shouldn't wait up to an hour for it.
"""

from __future__ import annotations

import logging
import time
from dataclasses import fields
from datetime import date, datetime
from decimal import Decimal
from urllib.parse import urljoin, urlparse

from etl.config import retain_capture_html_for
from etl.connectors.aliseda import AlisedaConnector
from etl.connectors.altamira import AltamiraConnector
from etl.connectors.base import (
    CanonicalListingVersion,
    ConnectorError,
    ListingUnavailableError,
    RawListing,
    RetiredNoticeFacts,
)
from etl.connectors.hipoges import HipogesConnector
from etl.connectors.idealista import IdealistaConnector
from etl.listing_detect import detail_portal_for_url, listing_portal_for_url
from etl.soft_block import challenge_page_signature

logger = logging.getLogger("etl.capture")

# At or below this many extracted fields, a capture is ANOMALOUS and its HTML
# is retained as evidence regardless of the retention config (issue #692).
#
# PER-PORTAL and MEASURED — never a global guess. The floor has to sit inside
# each portal's own gap between "non-advert page" and "thinnest real advert",
# and that gap is a property of the portal's markup, not of this pipeline.
# Claiming one portal's measured number for another would either miss its
# anomalies or start hoarding its thin-but-real adverts.
#
#   idealista: 3. Across 3.797 production captures `fields_extracted` is
#     cleanly bimodal — exactly 3 for every non-advert page (33 rows) and
#     9-15 for every real advert (3.764 rows), nothing in between. The 3 are
#     all structural, none extracted: `url` is handed in, `operation` is
#     hardcoded, and `property_type` is fabricated from the site-wide
#     <title>.
#
# Everything else defaults to 0 — a page that yielded literally nothing is
# anomalous on any portal, and that claim needs no per-portal measurement.
# Add a portal here only with the same kind of measurement behind it.
_ANOMALY_FIELD_FLOOR = {"idealista": 3}
_DEFAULT_ANOMALY_FIELD_FLOOR = 0

# hostname suffix -> (Connector instance, connector class). A capture-supported
# site adds ONE entry here, not a new processing mechanism (issue #75). Aliseda
# joined via issue #237 — capture-only for the same reason Idealista is: its
# real content only exists after a real browser hydrates the Angular app, and
# its data host is robots.txt Disallow: / (D-019). Altamira joined via issue
# #271 — capture-only because every direct HTTP request gets an Akamai WAF 403
# (D-027), yet the page renders normally for a human (2026-08-05 live test).
# Hipoges joined via issue #207 — capture-only because every sanctioned
# enumeration channel 403s an honest client (D-075), selectors are an
# unvalidated draft pending the owner's first real capture (D-111). Its key
# is the FULL subdomain `realestate.hipoges.com` — deliberately not a bare
# `hipoges.com` (the corporate/parent domain, unrelated to real-estate
# listings) — and the browser extension's manifest.json mirrors that as an
# exact-host `host_permissions`/`content_scripts` match
# (`*://realestate.hipoges.com/*`), not the `*://*.<domain>/*` wildcard
# subdomain pattern the other three portals use, for the same reason (Opus
# review, PR #548, N5).
#
# This dict is the source of truth for "which hosts can be captured". The
# dashboard mirrors these host suffixes in dashboard/lib/worklist.ts
# (CAPTURE_PORTALS, served to the extension via GET /api/extension/config) so
# the extension's supported-host badge tracks new portals with no extension
# redeploy — keep the two lists in step when adding a portal.
_idealista = IdealistaConnector()
_aliseda = AlisedaConnector()
_altamira = AltamiraConnector()
_hipoges = HipogesConnector()
_CAPTURE_CONNECTORS: dict[str, tuple[object, type]] = {
    "idealista.com": (_idealista, IdealistaConnector),
    "alisedainmobiliaria.com": (_aliseda, AlisedaConnector),
    "altamirainmuebles.com": (_altamira, AltamiraConnector),
    "realestate.hipoges.com": (_hipoges, HipogesConnector),
}

# The extension-capturable portal *names* — the Python mirror of
# dashboard/lib/worklist.ts's CAPTURE_PORTAL_NAMES. `capture_worklist` is the
# extension's queue, so only these portals may be seeded into it (issue #454).
# A connector fetched over HTTP by the ETL (e.g. cimenta2, via aura) is NOT
# here: the extension never drains its worklist, so seeding it just accrues
# vestigial "0/N pending forever" rows. Keep in step with _CAPTURE_CONNECTORS
# when adding a portal.
EXTENSION_CAPTURE_PORTALS: frozenset[str] = frozenset(
    {"idealista", "aliseda", "altamira", "hipoges"}
)

# portal name (== each connector's own `.name`, e.g. "idealista") -> connector
# class, derived from _CAPTURE_CONNECTORS so there's one list of "which
# portals can be capture-processed", not a second hand-maintained one. Used by
# `_sighting_id_from_url` (issue #639) to turn a harvested detail URL back
# into an external_id via each connector's own `external_id_from_url` — the
# same id extraction `_connector_for_url` uses for a single detail capture.
_CONNECTOR_CLASS_BY_PORTAL: dict[str, type] = {
    cls.name: cls for _, cls in _CAPTURE_CONNECTORS.values()
}

_BATCH_LIMIT = 10


def worklist_match_key(url: str) -> str:
    """Canonical correlation key linking a capture back to a capture_worklist
    row, tolerant of cosmetic URL differences (issue #237).

    key = hostname (lowercased, leading `www.` stripped) + path (trailing
    slash stripped). Scheme, query string and fragment are dropped. So
    `https://www.alisedainmobiliaria.com/inmueble/ANT1/` and
    `http://alisedainmobiliaria.com/inmueble/ANT1?utm=x` both map to
    `alisedainmobiliaria.com/inmueble/ANT1`. The path case is preserved
    (asset ids can be case-sensitive); only the host is lowercased.

    MUST stay identical to dashboard/lib/worklist.ts `worklistMatchKey`, which
    computes the same key at seed time — both are covered by a shared table of
    (input -> expected) cases asserted in the Python and TypeScript suites.
    Returns "" for an unparseable URL (it simply won't match any row).
    """
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = parsed.path.rstrip("/")
    if not host:
        return ""
    return f"{host}{path}"


def _correlate_worklist(conn, url: str, status: str, capture_id: int | None) -> None:
    """Mark the capture_worklist row matching `url` (by worklist_match_key) as
    `status` ('captured' or 'failed'). No-op if the captured URL isn't on any
    worklist — the worklist is a guide, not a gate: the owner can free-browse
    and capture a listing that was never enqueued (issue #237 §1).

    Guard rails:
      - 'captured' overwrites a 'pending' OR 'failed' row (a retry that finally
        succeeds should flip a previously-failed row green) and records
        matched_capture_id.
      - 'failed' only touches a still-'pending' row — it must never downgrade a
        row already 'captured' by an earlier good capture.
    Never raises: worklist correlation is best-effort bookkeeping and must not
    fail the capture it is annotating.
    """
    key = worklist_match_key(url)
    if not key:
        return
    try:
        with conn.cursor() as cur:
            if status == "captured":
                cur.execute(
                    "UPDATE capture_worklist "
                    "SET status = 'captured', matched_capture_id = %s "
                    "WHERE match_key = %s AND status IN ('pending', 'failed')",
                    (capture_id, key),
                )
            elif status == "failed":
                cur.execute(
                    "UPDATE capture_worklist SET status = 'failed' "
                    "WHERE match_key = %s AND status = 'pending'",
                    (key,),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception(
            "capture_worklist correlation failed for url=%s (status=%s) — "
            "capture itself is unaffected",
            url,
            status,
        )


def _connector_for_url(url: str) -> tuple[object, str] | None:
    """Return (connector, external_id) for a captured URL, or None if no
    registered capture connector's hostname matches.

    Only http(s) is accepted. Defense in depth against a `javascript:`/
    `data:` URL with a legitimate-looking hostname (e.g.
    `javascript://idealista.com/inmueble/1/%0aalert(1)`) — the dashboard's
    capture route already rejects this at submission time, but this
    connector must not trust that it always will (Opus review, PR #87).
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    hostname = (parsed.hostname or "").removeprefix("www.")
    for suffix, (connector, connector_cls) in _CAPTURE_CONNECTORS.items():
        if hostname == suffix or hostname.endswith("." + suffix):
            external_id = connector_cls.external_id_from_url(url)
            if external_id is None:
                return None
            return connector, external_id
    return None


def _field_completeness(canonical: CanonicalListingVersion) -> tuple[int, int]:
    """(fields_extracted, fields_available) — a coarse per-listing quality
    signal for the extension popup, counting every dataclass field except
    the ones that are structurally always present (external_id/source/
    status/raw_extra) or an empty-tuple-by-default collection rather than
    a real "could this connector have found a value" field."""
    always_present = {"external_id", "source", "status", "raw_extra"}
    collection_fields = {"photo_urls", "features"}
    available = 0
    extracted = 0
    for f in fields(canonical):
        if f.name in always_present:
            continue
        available += 1
        value = getattr(canonical, f.name)
        if f.name in collection_fields:
            if len(value) > 0:
                extracted += 1
        elif value is not None:
            extracted += 1
    return extracted, available


def _connector_capture_enabled(conn, connector_name: str) -> bool:
    """Whether capture PROCESSING is enabled for `connector_name`.

    Issue #263: this reads `connector_config.capture_enabled`, NOT the crawl
    `enabled` flag. The two are deliberately independent. A capture-only
    portal (Idealista, Aliseda, Cimenta2) keeps `enabled = false` on purpose
    so its doomed, WAF-blocked automated crawl never runs (D-019) — but
    capture is its ONLY ingestion path, so gating processing on `enabled`
    (the pre-#263 behaviour) left every extension capture `pending` forever.
    `capture_enabled` is the knob the poller checks; it defaults TRUE so a
    capture-only connector processes captures out of the box, and stays
    operator-controllable so a misbehaving one can still be paused.

    A missing row means enabled, matching how `etl.orchestrator.
    _scopes_for_connector` treats an absent row for the crawl flag (issue
    #71's default). In practice `sync_connector_registry` seeds a row for
    every registered connector on first publish (issue #100 review), and the
    `capture_enabled` column defaults TRUE, so the missing-row case only
    arises for a connector that has never been through a registry sync at
    all.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT capture_enabled FROM connector_config WHERE connector_name = %s",
            (connector_name,),
        )
        row = cur.fetchone()
    return True if row is None else bool(row[0])


def process_pending_captures(conn) -> int:
    """Process every pending extension_capture row. Returns the count
    processed (done + failed). Each row is its own try/except — one bad
    capture (a connector bug, a genuinely malformed HTML blob) must not
    block the rest of the batch or wedge this poll loop.

    Captures whose connector has `capture_enabled = false` in
    `connector_config` are left `pending` and are NOT counted as processed
    (issue #100 review). Issue #263: this gates on `capture_enabled`, NOT the
    crawl `enabled` flag — a capture-only portal is deliberately
    `enabled = false` (so its doomed automated crawl never runs) but must
    still process its extension captures. Leaving the row pending rather than
    failing it means re-enabling capture processes the backlog instead of
    discarding it: the operator paused capture, they didn't reject these
    captures.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, url, html, created_at FROM extension_capture "
            "WHERE status = 'pending' ORDER BY created_at LIMIT %s",
            (_BATCH_LIMIT,),
        )
        pending = cur.fetchall()

    # Cached per batch: every capture in a batch typically resolves to the
    # same connector, and this is a poll loop running every few seconds.
    enabled_cache: dict[str, bool] = {}
    processed = 0
    skipped_disabled = 0
    ingested = 0
    for capture_id, url, html, created_at in pending:
        # Reset per-iteration — a raise from _connector_for_url(url) itself
        # (before this is reassigned) must never leak a PRIOR url's resolved
        # connector into this one's failure record (issue #638 review S1).
        resolved = None
        try:
            resolved = _connector_for_url(url)
            if resolved is not None:
                connector_name = resolved[0].name
                if connector_name not in enabled_cache:
                    enabled_cache[connector_name] = _connector_capture_enabled(
                        conn, connector_name
                    )
                if not enabled_cache[connector_name]:
                    skipped_disabled += 1
                    continue
            # An unresolvable URL falls through to _process_one, which
            # marks it failed with the "no capture-capable connector"
            # message — unchanged behaviour, and not something a disabled
            # connector should silently swallow.
            if _process_one(conn, capture_id, url, html, created_at):
                ingested += 1
        except Exception:
            logger.exception(
                "extension_capture id=%s: unexpected error, marking failed",
                capture_id,
            )
            # Best-effort attribution (issue #638 review S1): `resolved` is
            # whatever this SAME iteration successfully computed before the
            # exception, or None if it never got that far — never a stale
            # value from a previous url.
            _mark_failed(
                conn,
                capture_id,
                url,
                "Unexpected internal error",
                connector_name=resolved[0].name if resolved is not None else None,
            )
        processed += 1

    # Issue #269: a capture that actually landed a listing must trigger the
    # same dashboard re-materialize + scoring the connector orchestrator fires
    # after a sweep (issue #94). Without this, a browser-extension capture — the
    # ONLY ingestion path for capture-only portals (Idealista, Aliseda), and a
    # bulk one since the batch-capture-a-search-page feature (#262) — wrote new
    # listings that no active profile ever folded in, so a profile silently went
    # stale and under-reported (the live Estepona 0-matches incident) until a
    # human hit `POST /api/profiles/materialize-all` by hand. The connector
    # sweeps already notify; captures were the remaining gap.
    #
    # Fired ONCE per batch (not per listing) and only when something was
    # genuinely ingested — a batch of only failures/disabled rows re-materializes
    # nothing. Best-effort and fully swallowed, exactly like the orchestrator's
    # own call site: the captures are already committed by now, and materialize
    # is idempotent, so a dashboard that is down/misconfigured only means the
    # candidates stay unscored until the next sweep or manual trigger — never a
    # reason to fail the capture that already succeeded. Lazy import mirrors
    # `_process_one`'s: etl.orchestrator ↔ etl.connectors have an import cycle
    # that a top-level import here could trip.
    if ingested:
        try:
            from etl import orchestrator

            orchestrator.notify_materialize_all(trigger="capture")
        except Exception:
            logger.warning(
                "materialize-all notification after %d captured listing(s) raised "
                "unexpectedly — the captures are committed and unaffected; "
                "candidates will be scored on the next sweep or manual trigger",
                ingested,
                exc_info=True,
            )

    if skipped_disabled:
        # One line per batch, not per row: this poll loop runs every few
        # seconds and a disabled connector's backlog would otherwise flood
        # the log with identical warnings forever.
        logger.info(
            "%d pending capture(s) left unprocessed: their connector has "
            "capture_enabled=false in connector_config. They stay pending and "
            "will be processed if capture is re-enabled (this is independent "
            "of the crawl 'enabled' flag — issue #263).",
            skipped_disabled,
        )
    return processed


def _extract_detail_urls_from_html(
    html: str | None, base_url: str, portal: str
) -> list[str]:
    """Harvest the listing-DETAIL URLs from a captured SEARCH/results page's
    HTML (issue #292). Server-side mirror of detect.js `extractDetailUrls`:
    every anchor href is resolved to an absolute URL against `base_url`, kept
    only if it is a detail page for `portal`, and de-duplicated by the same
    canonical `worklist_match_key` used everywhere else (so the same listing
    linked twice — photo + title anchor — seeds one worklist row).

    Best-effort and total: a parse failure or missing HTML yields an empty
    list rather than raising — a listing page with zero harvestable links is
    still a clean 'listing page' outcome, just with N=0.
    """
    if not html:
        return []
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        logger.warning(
            "extension_capture: could not parse listing-page HTML for %s — "
            "treating as a listing page with 0 detail links",
            base_url,
            exc_info=True,
        )
        return []

    out: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        raw_href = anchor["href"]
        if not isinstance(raw_href, str):
            continue
        href = urljoin(base_url, raw_href.strip())
        if detail_portal_for_url(href) != portal:
            continue
        key = worklist_match_key(href)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(href)
    return out


# Path suffixes that mean "the portal ITSELF says this advert is gone" —
# harvesting a link shaped like this off a results page must NEVER count as
# a sighting (issue #639 review, C3). idealista/aliseda/altamira never emit
# a link to a withdrawn listing from a live results page at all (it simply
# isn't linked there any more); hipoges is the one portal whose detail route
# accepts a same-id suffix for exactly this state -- see listing_detect.py's
# own note on hipoges' route table (`.../detail/<id>/unavailable`,
# `.../detail/<id>/contact-received`). Extend per-portal if another
# capture-only portal turns out to share the shape.
_GONE_URL_SUFFIXES: dict[str, tuple[str, ...]] = {
    "hipoges": ("/unavailable", "/contact-received"),
}


def _normalize_detail_path(href: str) -> str:
    """The bare PATH of a harvested detail href -- query string and fragment
    stripped, trailing slash guaranteed (issue #639 review, C4).

    `detail_portal_for_url` (listing_detect.py) already classified this href
    as a detail page by matching its PATH ALONE (`urlparse(url).path`
    already excludes query/fragment) against a shape that, for idealista,
    tolerates a MISSING trailing slash (`^/inmueble/\\d+/?$`). Each
    connector's own `external_id_from_url` is stricter than that -- idealista's
    requires the literal trailing slash -- because that method's OTHER call
    site (`_connector_for_url`, a single real captured URL) can trust a
    browser's canonical `location.href` to carry it. A harvested `<a href>`
    cannot be trusted the same way: the same listing can be linked on one
    page as `/inmueble/123`, `/inmueble/123/`, `/inmueble/123?utm=x` or
    `/inmueble/123#foto`, and only the FIRST form seen for a given
    `worklist_match_key` survives `_extract_detail_urls_from_html`'s de-dupe
    -- so a badly-shaped first occurrence could never be rescued by a
    well-formed duplicate later on the same page.

    Deliberately does NOT touch or relax any connector's own
    `external_id_from_url` regex -- that method is used UNRELAXED by
    `_connector_for_url` on a real, full URL that may legitimately carry a
    query string after the id; loosening those regexes risks a spurious id
    match on a URL that never went through `detail_portal_for_url`'s own
    classification at all. Normalizing the ALREADY-classified href here,
    once, is the narrow fix."""
    path = urlparse(href).path
    if path and not path.endswith("/"):
        path += "/"
    return path


def _sighting_id_from_url(portal: str, url: str) -> str | None:
    """External id for ONE harvested detail URL under `portal`, or None when
    the portal is unknown, no id can be extracted, or the URL's normalized
    path matches the portal's own "this advert is gone" route
    (`_GONE_URL_SUFFIXES`, issue #639 review C3).

    Applies each connector's own `external_id_from_url` to the URL's
    NORMALIZED path (`_normalize_detail_path`) -- the same id-extraction
    `_connector_for_url` uses for a single detail capture, made tolerant of
    the query-string / fragment / missing-trailing-slash variance a scraped
    `<a href>` can carry that a browser's own `location.href` never does
    (issue #639 review, C4).

    This is the ONE function this codebase's Python side calls "the sighting
    id-extraction rule" -- it MUST stay in lockstep with
    `dashboard/lib/capture-sightings.ts`'s `sightingIdFromUrl`, the
    TypeScript mirror the real production write
    (`dashboard/lib/db/worklist.ts` `addWorklistUrls`) actually calls (issue
    #639 review, C1). Both are asserted against the SAME shared fixture,
    `etl/tests/fixtures/sighting_ids.json` (`TestSightingIdExtraction` /
    `capture-sightings.test.ts`), so a divergence between the two languages
    fails a test instead of aging into a wrong expiry months later once
    #643/#645 key off this signal -- see D-143 for why a two-language mirror
    was unavoidable here rather than one shared implementation."""
    connector_cls = _CONNECTOR_CLASS_BY_PORTAL.get(portal)
    if connector_cls is None:
        return None
    path = _normalize_detail_path(url)
    gone_suffixes = _GONE_URL_SUFFIXES.get(portal, ())
    if gone_suffixes and path.rstrip("/").endswith(gone_suffixes):
        return None
    return connector_cls.external_id_from_url(path)


def _sighting_ids_from_detail_urls(portal: str, urls: list[str]) -> list[str]:
    """External ids for `portal`'s own `_update_last_seen_for_discovered`
    call (issue #639), extracted from a results page's harvested detail
    URLs via `_sighting_id_from_url` (one per URL) -- de-duped,
    order-preserving. Unknown portal contributes nothing. Any URL
    `_sighting_id_from_url` returns None for (unextractable shape, or a
    portal 'gone' route) is silently dropped from the RETURN value;
    `_record_sightings` logs the drop count so a systematic extraction gap
    is visible rather than a quietly wrong "N sighted"."""
    ids: list[str] = []
    seen: set[str] = set()
    for url in urls:
        external_id = _sighting_id_from_url(portal, url)
        if external_id is None or external_id in seen:
            continue
        seen.add(external_id)
        ids.append(external_id)
    return ids


def _record_sightings(
    conn, portal: str, urls: list[str], seen_at: datetime | None = None
) -> int:
    """Bump `listing.last_seen_at` for every already-known listing this
    captured results page just enumerated (issue #639).

    A results page enumerating a listing is weaker evidence than a detail
    fetch: it proves the advert is STILL LISTED, not that its fields were
    re-read. So this only ever touches `last_seen_at` — never `status`
    (only a real fetch_detail()/normalize() may change that) and never
    `last_fetched_at` (the signal skip-if-seen gates on, per
    etl.orchestrator._update_existing_listing's own docstring — a sighting
    must not make a stale listing look freshly re-fetched and get skipped).

    `seen_at` (issue #639 review, C2) should be the capture's OWN
    observation instant (`extension_capture.created_at`), not the moment
    this function happens to run — a captured page can sit `pending` for
    hours (paused connector, outage) before being processed, and stamping
    NOW() at processing time would record a sighting that never happened
    at that moment, in the exact column #643/#645 will trust. `None`
    (the default) falls through to `_update_last_seen_for_discovered`'s own
    NOW() — used by tests that don't care about the distinction.

    Delegates the actual UPDATE to etl.orchestrator._update_last_seen_for_discovered
    — the exact mechanism the crawl path already uses to bump presence for
    listings a discover() sweep re-confirmed without fetching their detail
    page, GREATEST-based so it can only move `last_seen_at` forward — rather
    than reimplementing the same SQL a second time. Lazy import for the same
    import-cycle reason `_process_one` already uses for
    `_upsert_canonical_listing`.

    A page with zero matches against known listings (nothing recognised, or
    every harvested id belongs to a listing not yet ingested) is a no-op,
    not an error — this is presence bookkeeping layered on an already-clean
    'listing page' outcome, so a failure here must never turn that outcome
    into a failed capture. Returns the number of rows ACTUALLY updated
    (issue #639 review, M1 — not `len(external_ids)`, which only says how
    many ids were targeted, not how many matched an ingested listing)."""
    external_ids = _sighting_ids_from_detail_urls(portal, urls)
    dropped = len(urls) - len(external_ids)
    if dropped:
        logger.info(
            "capture sighting: %d of %d harvested %s detail link(s) did not "
            "resolve to a sightable id this pass (unextractable URL shape, "
            "a duplicate id, or a portal 'gone' route) — not counted as "
            "sightings",
            dropped,
            len(urls),
            portal,
        )
    if not external_ids:
        return 0
    try:
        from etl.orchestrator import _update_last_seen_for_discovered

        return _update_last_seen_for_discovered(conn, portal, external_ids, seen_at)
    except Exception:
        conn.rollback()
        logger.exception(
            "last_seen_at sighting update failed for portal=%s (%d id(s)) — "
            "the listing-page capture itself is unaffected",
            portal,
            len(external_ids),
        )
        return 0


def _seed_derived_worklist(conn, portal: str, urls: list[str]) -> int:
    """Upsert harvested detail URLs into `capture_worklist` as `added_via =
    'derived'` (issue #262/#292) — the same batch-capture / mine-results path
    the extension's client-side harvest feeds, so a listing page captured as a
    single page is routed there too. Idempotent via ON CONFLICT (match_key).
    Returns the number of NEW rows added (already-known listings are skipped).

    Best-effort: never raises — worklist seeding is downstream bookkeeping and
    must not turn a clean listing-page outcome back into a failure."""
    if not urls:
        return 0
    added = 0
    try:
        with conn.cursor() as cur:
            for url in urls:
                key = worklist_match_key(url)
                if not key:
                    continue
                cur.execute(
                    """
                    INSERT INTO capture_worklist
                        (url, match_key, source_portal, added_via, status)
                    VALUES (%s, %s, %s, 'derived', 'pending')
                    ON CONFLICT (match_key) DO NOTHING
                    RETURNING id
                    """,
                    (url, key, portal),
                )
                if cur.fetchone() is not None:
                    added += 1
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception(
            "capture_worklist derived-seed failed for portal=%s (%d url(s)) — "
            "the listing-page capture itself is unaffected",
            portal,
            len(urls),
        )
        return 0
    return added


def _mark_listing(
    conn, capture_id: int, url: str, portal: str, detail_links: int, sighted: int = 0
) -> None:
    """Record a captured SEARCH/results page as a clean 'listing' outcome
    (issue #292) — NOT a failure. `status = 'listing'` is neutral end-to-end:
    the data-health portal view counts it separately (never in failed_7d), and
    the popup renders it as an informational result. The HTML is dropped like a
    'done' row (we've already harvested the detail links from it).

    `sighted` (issue #639) is purely a log annotation — how many of the
    harvested detail links matched an already-known listing and got their
    `last_seen_at` bumped by `_record_sightings`. It is NOT persisted on this
    row (no schema change): `extension_capture` already records the harvest
    count via `fields_extracted`/`title`, and a sighting is downstream
    bookkeeping on the `listing` table, not a property of this capture row."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE extension_capture
               SET status = 'listing', connector_name = %s,
                   title = %s, error_msg = NULL, fields_extracted = %s,
                   processed_at = NOW(), html = NULL
             WHERE id = %s
            """,
            (
                portal,
                f"Página de resultados — {detail_links} enlaces de detalle",
                detail_links,
                capture_id,
            ),
        )
    conn.commit()
    logger.info(
        "extension_capture id=%s: %s listing/search page — %d detail link(s) "
        "harvested into the batch worklist, %d already-known listing(s) "
        "sighted (not a failure)",
        capture_id,
        portal,
        detail_links,
        sighted,
    )


# How far the size a notice PRINTS may sit from the size we STORED before
# the two are treated as describing different properties. Rooms are compared
# exactly: nobody rounds a bedroom.
#
# Two benign sources of disagreement have to be absorbed, and they have
# different shapes:
#
#   1. ROUNDING. The notice renders a whole number ("80 m²") while
#      `property.m2_built` holds NUMERIC(8,2) straight from the structured
#      capture (79,60). One square metre covers it, whatever the flat's size.
#   2. DEDUPLICATION. `property.m2_built` is a PROPERTY-level field, shared by
#      every listing merged onto that property, so it is not necessarily
#      Idealista's own figure at all. Dedup merges on `sizes_close` — a 5%
#      band (`etl/dedup/signals/address_coords.py:_MAX_SIZE_RATIO`), exact
#      equality being reserved for the photo-hash auto-merge path
#      (`etl/dedup/engine.py`, D-137). A legitimately merged property can
#      therefore sit several m² from what Idealista printed, and a flat ±1 m²
#      rule would VETO those withdrawals silently, precisely on the merged
#      properties (Opus review, PR #691).
#
# So the tolerance is the wider of the two: a 1 m² floor for small flats, and
# otherwise dedup's own band, which is by construction as wide as the
# disagreement dedup itself was willing to merge across. The veto still
# catches what it exists for — a notice about someone else's flat differs by
# far more than 5% in any realistic case.
_NOTICE_M2_TOLERANCE_FLOOR = Decimal(1)
_NOTICE_M2_TOLERANCE_RATIO = Decimal("0.05")


def _notice_m2_tolerance(stated: Decimal, stored: Decimal) -> Decimal:
    """The m² gap tolerated between a notice and the stored property row.

    See the constants above. `max(stated, stored)` is the same denominator
    `address_coords.sizes_close` uses, so the band is the identical shape to
    the one dedup merged on.
    """
    return max(
        _NOTICE_M2_TOLERANCE_FLOOR,
        max(stated, stored) * _NOTICE_M2_TOLERANCE_RATIO,
    )


def _notice_contradicts_stored(
    facts: RetiredNoticeFacts | None,
    stored_m2: Decimal | None,
    stored_rooms: int | None,
) -> str | None:
    """Does the retired notice describe a DIFFERENT property than the one we
    stored? Returns a Spanish description of the disagreement, or None
    (issue #691, D-159).

    The second half of the corroboration chain. The first half —
    "«Referencia del anuncio» equals the captured external_id" — is enforced
    inside `IdealistaConnector.normalize`, because it needs only the page and
    the id the connector was already handed. This half needs the stored
    listing, so it lives here, where there is a database connection; the
    connector stays a pure function of HTML and hands over parsed facts
    instead (`RetiredNoticeFacts`).

    Only fields present on BOTH sides are compared. A notice that prints no
    size, or a listing stored without one, yields no disagreement — absence
    is not a mismatch, and treating it as one would let a reworded notice
    quietly disable the only evidence channel a capture-only portal has. In
    that case the reference match stands alone, which is what the previous
    behaviour already relied on.

    PRICE IS DELIBERATELY NOT COMPARED, and this is not an oversight.
    Repricing before delisting is ordinary seller behaviour — cutting the
    asking price, failing to sell, and pulling the advert is close to the
    typical story of a dead listing. A price that moved says nothing about
    whether the notice is about our advert, and vetoing on it would reject
    exactly the withdrawals we most want to record. The stated price is
    still captured into the evidence, where it is the first time this
    project has ever recorded an advert's FINAL asking price.
    """
    if facts is None:
        return None
    if (
        facts.stated_m2 is not None
        and stored_m2 is not None
        and abs(Decimal(stored_m2) - facts.stated_m2)
        > _notice_m2_tolerance(facts.stated_m2, Decimal(stored_m2))
    ):
        return (
            f"el aviso describe {facts.stated_m2} m² y el anuncio "
            f"almacenado tiene {stored_m2} m²"
        )
    if (
        facts.stated_rooms is not None
        and stored_rooms is not None
        and int(stored_rooms) != facts.stated_rooms
    ):
        return (
            f"el aviso describe {facts.stated_rooms} habitaciones y el "
            f"anuncio almacenado tiene {stored_rooms}"
        )
    return None


def _mark_withdrawn(
    conn,
    capture_id: int,
    url: str,
    connector_name: str,
    external_id: str,
    evidence: str,
    facts: RetiredNoticeFacts | None = None,
) -> None:
    """Record a capture that positively identified the portal's own
    "anuncio retirado" notice (issue #690, D-159).

    Three writes, in one transaction, in this order:

    1. `listing.status = 'withdrawn'` for the listing this URL names — if we
       know it. MARK, NEVER DELETE (D-157): the row, its
       `listing_price_history`, its feedback and its dedup identity all
       survive, so a property whose adverts all vanish keeps its history and
       a resurrection stays representable.
    2. An append-only `listing_status_event` citing the notice in
       `evidence`. This is what makes the transition auditable a year later
       under D-157's "only evidence changes state" rule — the row can answer
       "evidence of what?" on its own.
    3. The capture row itself as `status = 'withdrawn'`.

    `facts` (issue #691) is what the notice STATED, when the connector could
    parse it — `None` for a connector that does not implement
    `retired_notice_facts`, which reproduces the pre-#691 behaviour exactly.
    It does three things here, and NOT a fourth:

    * **it can veto the withdrawal.** If the notice describes a different
      size or room count than the stored listing, this is not our advert's
      notice: nothing is withdrawn, and the capture is recorded `failed`
      exactly as an unreadable page would be. See
      `_notice_contradicts_stored`.
    * **it dates the transition.** `listing_status_event.observed_at` is
      stamped with the date the notice says the ADVERTISER took the advert
      down, not with the moment we happened to read the page. In the sample
      that prompted this, the advert had already been down for twelve days
      when the page was captured — twelve days of drift that `NOW()` would
      have invented. A
      missing or disbelieved date falls back to `NOW()`; the connector
      never hands over a date it does not believe (see
      `_notice_delisting_date`), and the evidence says so when it discarded
      one.
    * **it enriches the evidence**, which already quotes the notice
      sentence and now also carries the reference, the stated delisting
      date and the advert's final stated price/size/rooms. The price in
      particular is a fact this project has never recorded before: what the
      advert was actually asking when it died.

    The fourth thing it deliberately does NOT do is touch the `listing` row's
    own fields. Those hold values from a healthy structured capture; the
    notice's are a weaker parse of the same facts off plain rendered text.
    Overwriting good data on a row being marked dead is all risk and no gain.

    Deliberately does NOT touch `last_seen_at` / `last_fetched_at`. Those
    mean "last confirmed PRESENT", and this observation is the exact
    opposite; bumping them would make a listing we just proved gone look
    freshly confirmed alive — the very corruption this issue fixes (the
    pre-fix path bumped both).

    Deliberately does NOT create a listing when none exists. A withdrawn
    notice for a URL we never successfully captured tells us about a
    listing we have no data for; inventing a row for it would recreate the
    18 empty phantom listings D-159 documents. The capture is still recorded
    (with `listing_id` NULL) so the evidence is not lost.

    Idempotent: re-capturing the same retired page appends no second event
    and changes nothing, because the status guard already sees 'withdrawn'.

    The guard is `status != 'withdrawn'`, NOT a whitelist of `active`, so a
    listing already marked `sold`/`reserved`/`expired` is flipped to
    `withdrawn` too. That is deliberate: the notice is first-hand, dated,
    present-tense evidence from the portal itself, and every other status a
    listing can hold today is inferred rather than observed. Nothing is lost
    by the flip — `listing_status_event` is append-only, so the earlier claim
    and this one both stay on the record with their own evidence, and a
    reader can see which came from where. (In practice nothing in the ETL
    writes `sold` yet; the rule is stated here so a connector that starts to
    does not silently change what a withdrawal means.)
    """
    listing_id: int | None = None
    property_id: int | None = None
    stored_m2: Decimal | None = None
    stored_rooms: int | None = None
    stored_last_seen_at: datetime | None = None
    already_withdrawn = False

    # Read first, in its own statement, so the corroboration decision below
    # is made BEFORE anything is written and a veto needs nothing rolled
    # back. `property` carries m2_built/rooms; `listing.property_id` is NOT
    # NULL by schema, so an inner join can never drop a row.
    # `last_seen_at` is read for the date clamp below, NOT to be written.
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT l.id, l.property_id, l.status, p.m2_built, p.rooms, "
                "l.last_seen_at "
                "FROM listing l JOIN property p ON p.id = l.property_id "
                "WHERE l.source = %s AND l.external_id = %s",
                (connector_name, external_id),
            )
            row = cur.fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception(
            "extension_capture id=%s: could not read the stored listing for "
            "%s while recording a retired-advert notice — recording the "
            "capture as failed rather than withdrawing on an uncorroborated "
            "notice",
            capture_id,
            url,
        )
        _mark_failed(conn, capture_id, url, evidence, connector_name=connector_name)
        return

    if row is not None:
        (
            listing_id,
            property_id,
            prev_status,
            stored_m2,
            stored_rooms,
            stored_last_seen_at,
        ) = row
        already_withdrawn = prev_status == "withdrawn"

    contradiction = _notice_contradicts_stored(facts, stored_m2, stored_rooms)
    if contradiction is not None:
        # The reference matched but the property does not. Something is
        # wrong with one side or the other and we cannot tell which, so this
        # resolves the same way every other "I cannot read this page" does
        # (D-157): capture recorded `failed` for the operator to look at,
        # not one listing row touched, worklist row left `pending`.
        refusal = (
            f"{connector_name} {external_id}: the captured page is the "
            "portal's 'anuncio retirado' notice and its reference matches "
            "this listing, but the property it describes does not — "
            f"{contradiction}. Refusing to withdraw a listing on a notice "
            "about a different property (issue #691, D-159); nothing about "
            f"any listing has been changed. Notice read as: {evidence}"
        )
        _mark_failed(conn, capture_id, url, refusal, connector_name=connector_name)
        return

    evidence = _corroborated_evidence(evidence, facts, stored_m2, stored_rooms)
    # NULL means "the notice gave us no date we believe" and the SQL below
    # falls back to NOW() — the capture time, which is at least honestly
    # "when we saw this" rather than a date we made up.
    delisted_on = facts.delisted_on if facts is not None else None
    delisted_on, clamp_note = _clamped_delisting_date(delisted_on, stored_last_seen_at)
    if clamp_note is not None:
        evidence = f"{evidence}; {clamp_note}"

    try:
        with conn.cursor() as cur:
            if row is not None and not already_withdrawn:
                cur.execute(
                    "UPDATE listing SET status = 'withdrawn' WHERE id = %s",
                    (listing_id,),
                )
                cur.execute(
                    "INSERT INTO listing_status_event "
                    "(listing_id, observed_at, status, evidence) "
                    "VALUES (%s, COALESCE(%s::timestamptz, NOW()), "
                    "'withdrawn', %s)",
                    (listing_id, delisted_on, evidence),
                )
            cur.execute(
                """
                UPDATE extension_capture
                   SET status = 'withdrawn', connector_name = %s,
                       listing_id = %s, property_id = %s,
                       title = %s, error_msg = %s, fields_extracted = 0,
                       processed_at = NOW(), html = NULL
                 WHERE id = %s
                """,
                (
                    connector_name,
                    listing_id,
                    property_id,
                    "Anuncio retirado del portal"
                    + (
                        f" (baja {delisted_on.strftime('%d/%m/%Y')})"
                        if delisted_on is not None
                        else ""
                    ),
                    evidence,
                    capture_id,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception(
            "extension_capture id=%s: could not record the retired-advert "
            "outcome for %s — falling back to 'failed' so the capture is not "
            "left pending forever",
            capture_id,
            url,
        )
        _mark_failed(conn, capture_id, url, evidence, connector_name=connector_name)
        return

    # Retire the guided-worklist row too (issue #690). 'stale' is the status
    # this table already defines as "vanished from the portal" (issue #273)
    # and it is excluded from the "Abrir siguiente pendiente" pool — so the
    # owner is never handed a URL we have just proven is gone. Best-effort
    # and after the commit above, same posture as _correlate_worklist.
    _retire_worklist_row(conn, url)

    logger.info(
        "extension_capture id=%s: %s %s is RETIRED at the portal (baja %s) "
        "— %s (listing_id=%s) | %s",
        capture_id,
        connector_name,
        external_id,
        delisted_on.isoformat() if delisted_on is not None else "sin fecha",
        "listing marked withdrawn"
        if listing_id is not None and not already_withdrawn
        else (
            "listing was already withdrawn"
            if already_withdrawn
            else "no stored listing for this URL, nothing to withdraw"
        ),
        listing_id,
        evidence,
    )


def _clamped_delisting_date(
    delisted_on: date | None,
    last_seen_at: datetime | None,
) -> tuple[date | None, str | None]:
    """Refuse a delisting date that precedes our own last sighting of the
    advert alive (Opus review of PR #691).

    Returns `(date_to_stamp, note_or_None)`; the note goes into the evidence
    so the refusal is auditable, exactly as `_notice_delisting_date`'s own
    rejections already are.

    `_notice_delisting_date` in the connector already refuses dates that are
    impossible, in the future, or older than ten years. It cannot make this
    check: believability is relative to what WE observed, and the connector
    is a pure function of the page. So the last gate lives here.

    A notice dated before `last_seen_at` is a contradiction of the same class
    D-157 exists to prevent — it asserts the advert was already dead on a day
    we have a record of confirming it alive. One of the two observations is
    wrong and nothing here can say which, so this falls back to the safe
    default the rest of the function already uses for a disbelieved date:
    `NOW()`, the capture time. Note the asymmetry with the veto above — a
    contradicted SIZE kills the whole withdrawal (it means the notice is
    about someone else's flat), whereas a contradicted DATE costs the
    transition only its precision. The portal still positively said this
    advert is gone; only "since when" is in doubt.

    Compared at DAY granularity: the notice prints a date, not a timestamp,
    so a notice dated the same calendar day as our last sighting is not a
    contradiction. A listing with no `last_seen_at` at all (nullable by
    schema) has nothing to contradict, so the stated date stands.
    """
    if delisted_on is None or last_seen_at is None:
        return delisted_on, None
    last_seen_day = last_seen_at.date()
    if delisted_on >= last_seen_day:
        return delisted_on, None
    return None, (
        f"la fecha de baja declarada ({delisted_on.strftime('%d/%m/%Y')}) es "
        f"anterior a la última vez que vimos el anuncio activo "
        f"({last_seen_day.strftime('%d/%m/%Y')}), así que se descarta; la "
        "retirada se fecha en el momento de la captura"
    )


def _corroborated_evidence(
    evidence: str,
    facts: RetiredNoticeFacts | None,
    stored_m2: Decimal | None,
    stored_rooms: int | None,
) -> str:
    """Append to the connector's citation what THIS side of the check could
    verify (issue #691).

    The connector's citation says what the page stated; only the caller
    knows what that was checked against. Recording the difference matters
    because "reference matched, and so did size and rooms" and "reference
    matched, and the notice stated nothing else" are very different amounts
    of evidence, and a year later `listing_status_event.evidence` is the
    only place anyone can tell them apart.
    """
    if facts is None:
        return evidence
    corroborated = [
        label
        for label, stated, stored in (
            ("superficie", facts.stated_m2, stored_m2),
            ("habitaciones", facts.stated_rooms, stored_rooms),
        )
        if stated is not None and stored is not None
    ]
    if corroborated:
        return (
            f"{evidence}; corroborado contra el anuncio almacenado: "
            f"{' y '.join(corroborated)} coinciden"
        )
    return (
        f"{evidence}; sin datos comparables con el anuncio almacenado más "
        "allá de la referencia"
    )


def _retire_worklist_row(conn, url: str) -> None:
    """Flip this URL's `capture_worklist` row to 'stale' — "vanished from the
    portal" (issue #273's own definition of that status) — after a capture
    positively proved the advert is retired (issue #690).

    Only ever touches a row that is still 'pending'. That single-status
    guard is doing three separate jobs:

    * it never resurrects or overwrites a 'skipped' row — that status is the
      OWNER'S choice about his own queue, and no automated inference gets to
      overrule it;
    * it never downgrades a 'captured' row, which already records a real
      successful capture and its `matched_capture_id`;
    * it never touches an already-'stale' row, keeping this idempotent.

    Leaving the row 'pending' instead was the alternative, and it is wrong
    on this evidence: 'pending' means "still to visit", and re-serving a URL
    the portal has told us is gone spends the owner's attention — the single
    scarcest resource in a capture-only pipeline — on a page that can never
    produce data. 'failed' would be wrong too: nothing failed. The capture
    worked perfectly and returned an answer.

    Never raises: worklist bookkeeping must not fail the withdrawal it
    annotates.
    """
    key = worklist_match_key(url)
    if not key:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE capture_worklist SET status = 'stale', updated_at = NOW() "
                "WHERE match_key = %s AND status = 'pending'",
                (key,),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception(
            "capture_worklist retirement failed for url=%s — the withdrawal "
            "itself is already committed and unaffected",
            url,
        )


def _process_one(
    conn, capture_id: int, url: str, html: str, created_at: datetime | None = None
) -> bool:
    """Process one capture. Returns True if a listing was actually ingested
    (upserted into `property`/`listing`), False otherwise (a listing/search
    page routed to the batch worklist, or a genuinely failed detail capture).
    The caller uses the True count to decide whether the batch should fire a
    dashboard re-materialize (issue #269).

    `created_at` (issue #639 review, C2) is this row's own `extension_capture.
    created_at` — the moment the capture actually arrived, which can predate
    processing by hours (a paused connector, an outage keep rows `pending`).
    Passed through to `_record_sightings` as the sighting's true observation
    instant rather than letting it default to "now"."""
    resolved = _connector_for_url(url)
    if resolved is None:
        # Issue #292: a captured SEARCH/results page is not a broken detail
        # capture — it's a listing page. Recognise it, harvest its detail
        # links into the batch-capture / mine-results worklist (#262/#290),
        # and record a clean 'listing' outcome. `failed` is reserved for
        # genuinely broken DETAIL captures.
        portal = listing_portal_for_url(url)
        if portal is not None:
            detail_urls = _extract_detail_urls_from_html(html, url, portal)
            _seed_derived_worklist(conn, portal, detail_urls)
            # Issue #639: the crawl path already bumps last_seen_at for every
            # id its discover() sweep re-confirms, even without fetching its
            # detail page (etl.orchestrator._update_last_seen_for_discovered).
            # A captured results page is the same kind of evidence — it too
            # proves an already-known listing is still there — so it must
            # feed the same presence ledger, not just the batch worklist.
            #
            # NOTE (issue #639 review, C1): this is the manually-captured /
            # single-page-capture path only. The production D-088 walk that
            # actually enumerates idealista's results pages never reaches
            # here — it POSTs harvested URLs straight to
            # POST /api/etl/worklist (dashboard/lib/db/worklist.ts
            # addWorklistUrls), which records the SAME sighting server-side
            # in TypeScript against the shared Postgres `listing` table. Kept
            # here too because it's correct and covers this path for real.
            sighted = _record_sightings(conn, portal, detail_urls, created_at)
            _mark_listing(conn, capture_id, url, portal, len(detail_urls), sighted)
            return False
        _mark_failed(
            conn,
            capture_id,
            url,
            "No capture-capable connector recognizes this URL "
            "(supported: Idealista, issue #75; Aliseda, issue #237; "
            "Altamira, issue #271; Hipoges, issue #207)",
        )
        return False

    connector, external_id = resolved

    # ── Outcome 1 of 3: the portal served an anti-bot CHALLENGE (issue #692)
    #
    # Ranked ABOVE both the retirement check and the zero-fields check, and
    # evaluated before `normalize()` is even called, because a challenge page
    # is indistinguishable from a retired-advert page BY FIELD COUNT — both
    # carry nothing a parser recognises — and the two outcomes could not be
    # further apart:
    #
    #   challenge  → "come back later"  → change NOTHING, keep the queue slot
    #   retirement → "this advert is gone" → mark the listing `withdrawn`
    #
    # Getting that backwards writes `withdrawn` onto a live listing on the
    # strength of a rate-limit wall. D-047/D-157 already forbid it, and
    # `milanuncios.py` ships no retirement signature at all precisely to
    # avoid this trap; idealista now has both page kinds in circulation, so
    # the challenge has to be excluded POSITIVELY and FIRST rather than
    # hoped away.
    #
    # Deliberately NOT `_mark_failed`. `failed` writes nothing to the listing
    # (so it is safe) but it is still the wrong answer: it consumes the
    # attempt, and `_correlate_worklist(..., "failed", ...)` flips the
    # `capture_worklist` row out of `pending`, which drops it from the drain
    # pool entirely — the extension filters `status === 'pending'` client-side
    # (see the requeue-metadata note in init.sql, issue #683). A page the
    # portal refused to serve us was never seen; it must keep its place in
    # the queue, `requeue_rank` and all.
    challenge = challenge_page_signature(html)
    if challenge is not None:
        _mark_blocked(conn, capture_id, url, challenge, connector.name)
        return False

    raw = RawListing(
        external_id=external_id, source=connector.name, raw={"url": url, "html": html}
    )

    try:
        canonical = connector.normalize(raw)
    except ListingUnavailableError as exc:
        # Issue #690 / D-159. The connector POSITIVELY identified the
        # portal's own "this advert is retired" notice, and (issue #691) the
        # reference printed on it matches the advert we captured. Caught
        # BEFORE the generic ConnectorError branch below (it is a subclass,
        # so order is load-bearing): this is not a failed capture, it is the
        # single most valuable capture a WAF-walled, capture-only portal can
        # produce — first-hand evidence of absence, obtained with zero
        # automated requests because the owner was already on the page.
        #
        # Re-parsing the page for its facts rather than smuggling them out
        # through the exception: the connector stays a pure function of
        # HTML, `ListingUnavailableError` keeps the shape every other
        # connector raises it with, and the cost lands only on the rare
        # notice-page path — never on the real-advert path this runs
        # thousands of times against. Returns None for a connector that does
        # not implement it, which is the pre-#691 behaviour exactly.
        _mark_withdrawn(
            conn,
            capture_id,
            url,
            connector.name,
            external_id,
            str(exc),
            connector.retired_notice_facts(html, url),
        )
        return False
    except ConnectorError as exc:
        # Issue #692: retain the HTML of an ANOMALOUS capture. This branch is
        # the "I cannot tell what this page is" outcome, and it is exactly
        # the case where, months later, nobody can say whether the page was a
        # withdrawal notice, a reworded challenge or a half-rendered capture
        # — which is precisely what happened to the 33 field-less idealista
        # rows this work started from: HTML retention was off, so the
        # decisive artefact was thrown away and the rows are now
        # unclassifiable from stored data.
        #
        # `_mark_failed` leaves `html` alone (only the success path nulls
        # it), so a capture that raised already keeps its page. The
        # field-count floor below covers the other half: a page that parses
        # "successfully" into almost nothing.
        _mark_failed(conn, capture_id, url, str(exc), connector_name=connector.name)
        return False

    # Reuses the exact same persistence path the automated orchestrator
    # sweep uses (etl.orchestrator._upsert_canonical_listing) — a captured
    # listing goes through dedup/hard-filtering identically to one that
    # arrived via a live connector fetch, per issue #75's explicit
    # acceptance criterion. Imported lazily: etl.orchestrator imports
    # etl.connectors (for CONNECTORS), and etl.connectors.__init__ imports
    # etl.orchestrator back inside register_all() for the same reason —
    # see that module's docstring. A top-level import here would risk the
    # same cycle if this module is ever imported before both are fully
    # loaded.
    from etl.orchestrator import _upsert_canonical_listing

    _upsert_canonical_listing(conn, canonical)

    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, property_id FROM listing WHERE source = %s AND external_id = %s",
            (canonical.source, canonical.external_id),
        )
        listing_id, property_id = cur.fetchone()

    fields_extracted, fields_available = _field_completeness(canonical)
    price_display = (
        f"{canonical.current_price:,.0f} €" if canonical.current_price else None
    )
    title = (
        canonical.raw_extra.get("title") or canonical.description or canonical.address
    )

    # Issue #547 / Opus review (PR #548, C3): a connector whose selectors are
    # not yet calibrated (raw_extra.selectors_calibrated is False) writes an
    # honest near-empty row, but normalize() never raises, so every one of
    # its captures would otherwise reach 'done' with `html` discarded —
    # making it IMPOSSIBLE to later pull the real captured DOM back out of
    # the DB to build real fixtures against. Retain the HTML for exactly
    # that case; every OTHER (calibrated) connector keeps the pre-existing
    # behaviour of dropping it once processed, since there is no reason to
    # hold onto a full page capture once its fields have actually been
    # trusted and extracted. Hipoges used this mechanism to bootstrap its
    # own real fixture (issue #547, D-146) and is now calibrated — HTML
    # retention for it turns off automatically the moment its
    # `_SELECTORS_CALIBRATED` flag flips `raw_extra["selectors_calibrated"]`
    # to True, no code change needed here.
    #
    # Issue #654 / D-150: a SECOND, independent, config-driven retention
    # path — `etl.retain_capture_html_for` — lets an operator name a
    # CALIBRATED connector (e.g. Idealista, under live investigation for a
    # truncated photo gallery, D-145) whose HTML should still be kept, on
    # purpose, without lying about or flipping its calibration state. Off by
    # default; read fresh on every capture so flipping the config takes
    # effect on the operator's next processed capture, no code change either
    # direction. See D-150 for exactly how to turn it on/off.
    #
    # Issue #692: a THIRD retention path — retain the pages the system COULD
    # NOT ACCOUNT FOR, and only those.
    #
    # Not "retain whatever parsed to nothing": a *classified* field-less page
    # is not an anomaly. A recognised retirement notice (#691) and a
    # recognised challenge both take their own outcome paths above and both
    # drop their HTML, because we already know what they were and the
    # evidence is recorded. The retained set should read as "pages we cannot
    # explain" — if it ever fills up with pages we DO have a classifier for,
    # that means the classifier should be handling them, not that storage
    # should grow. Blanket retention is unaffordable (D-150: ~290 MB of pages
    # against a 204 MB database), which is why it is off for idealista. But
    # that is exactly why the 33 field-less idealista rows this work started
    # from are now permanently unclassifiable: a confirmed withdrawal notice
    # and a suspected anti-bot challenge left byte-identical database
    # footprints (`fields_extracted = 3`, zero photos, the site-wide homepage
    # <title>), and the one artefact that could have separated them was
    # thrown away.
    #
    # Retaining only the anomalies inverts the cost: at the ~1 % observed
    # anomaly rate a full 2.586-page drain keeps ~26 pages, single-digit MB,
    # and every future ambiguous page arrives with its own evidence.
    #
    # The floor is MEASURED and PER-PORTAL (see _ANOMALY_FIELD_FLOOR), so it
    # cannot encroach on a thin-but-real advert on any portal. It is a
    # RETENTION trigger only: it never decides an outcome, never withdraws
    # anything, and a page it fires on is still persisted exactly as it was
    # before.
    retain_html = (
        canonical.raw_extra.get("selectors_calibrated") is False
        or connector.name in retain_capture_html_for()
        or fields_extracted
        <= _ANOMALY_FIELD_FLOOR.get(connector.name, _DEFAULT_ANOMALY_FIELD_FLOOR)
    )
    retained_html = html if retain_html else None

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE extension_capture
            SET status = 'done', connector_name = %s, property_id = %s,
                listing_id = %s, fields_extracted = %s, fields_available = %s,
                title = %s, price_display = %s, processed_at = NOW(),
                html = %s
            WHERE id = %s
            """,
            (
                connector.name,
                property_id,
                listing_id,
                fields_extracted,
                fields_available,
                title[:200] if title else None,
                price_display,
                retained_html,
                capture_id,
            ),
        )
    conn.commit()
    # Guided-worklist correlation (issue #237): if this URL was on a
    # capture_worklist, flip that row to 'captured'. Best-effort, after the
    # capture itself is safely committed — see _correlate_worklist.
    _correlate_worklist(conn, url, "captured", capture_id)
    logger.info(
        "extension_capture id=%s: processed via %s -> property_id=%s",
        capture_id,
        connector.name,
        property_id,
    )
    return True


def run_capture_poll_loop(conn_factory, interval_seconds: int = 10) -> None:
    """Poll extension_capture on a short interval, forever.

    A human waiting on the extension's popup for a result shouldn't wait
    up to an hour for the next connector sweep (etl.orchestrator.
    run_scheduler_loop) — this runs on its own much shorter interval, in
    its own thread (see etl/main.py), with the same "one bad iteration
    shouldn't kill the loop" isolation as run_scheduler_loop.
    """
    while True:
        conn = conn_factory()
        try:
            count = process_pending_captures(conn)
            if count:
                logger.info("Processed %d pending extension capture(s)", count)
        except Exception:
            logger.exception(
                "process_pending_captures failed for this poll iteration — "
                "will retry next interval rather than exit"
            )
        finally:
            conn.close()
        time.sleep(interval_seconds)


def _mark_blocked(
    conn, capture_id: int, url: str, signature: str, connector_name: str
) -> None:
    """Record a capture that was an anti-bot CHALLENGE, not a listing (#692).

    This is the "nothing happened" outcome, and the list of things it
    deliberately does NOT do is the whole point:

    * **No listing write of any kind.** Not `photo_urls`, not `last_seen_at`,
      not `status`, not `current_price`. The portal never showed us the
      advert, so we learned nothing about it — including whether it is still
      alive. Bumping `last_seen_at` off a challenge page would be the exact
      inversion D-157 exists to prevent.
    * **No `_correlate_worklist` call.** The `capture_worklist` row keeps
      `status = 'pending'` and its `requeue_rank`, so the page stays in the
      drain pool in its original position and gets served again once the
      owner has cleared the wall. This is the single most important line of
      this function — and it is the line that is *absent*, so a reviewer
      should check for it deliberately: `_mark_failed` DOES correlate, and
      inheriting that behaviour here would silently consume the queue.
    * **No `listing_status_event`.** Nothing about the advert's status was
      observed.

    The HTML is **dropped**, like any other classified outcome. Retention is
    reserved for pages the system could not account for, and this one is
    accounted for: `error_msg` records exactly which phrases matched. Keeping
    the page would add nothing we do not already know.

    This is self-correcting in the direction that matters. If the portal ever
    REWORDS its wall, the phrase table stops matching, the page stops being
    classified — and it lands in the unexplained bucket, which *is* retained.
    The sample needed to repair the phrase table therefore appears exactly
    when the phrase table is broken, and never while it is working.
    """
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE extension_capture "
            "SET status = 'blocked', error_msg = %s, connector_name = %s, "
            "    fields_extracted = 0, processed_at = NOW(), html = NULL "
            "WHERE id = %s",
            (signature, connector_name, capture_id),
        )
    conn.commit()
    logger.warning(
        "extension_capture id=%s: %s served an anti-bot CHALLENGE for %s — "
        "nothing written to any listing, worklist row left pending. %s",
        capture_id,
        connector_name,
        url,
        signature,
    )


def _mark_failed(
    conn, capture_id: int, url: str, error_msg: str, connector_name: str | None = None
) -> None:
    """Record a failed capture. `connector_name` is set whenever the caller
    already knows which portal this URL resolved to (e.g. `normalize()`
    raised) — issue #638 review finding S1: before this, EVERY failed row
    left `connector_name` NULL regardless of whether a connector had been
    resolved, which made the Estado board's per-source capture-failure-rate
    signal (`lib/source-health.ts`) permanently unreachable in production —
    11/11 real failed rows (including the hipoges 2026-08-19 pair the owner
    cited in #636's addendum) were unattributed. `None` stays correct for a
    genuinely unresolvable URL (no connector recognises it at all)."""
    with conn.cursor() as cur:
        cur.execute(
            # `html` is deliberately NOT touched: the row was inserted with
            # the captured page and only the SUCCESS path nulls it, so a
            # failed capture already keeps its evidence (issue #692 checked
            # this before adding a redundant write — pinned by
            # test_failed_capture_keeps_html_for_debugging).
            "UPDATE extension_capture SET status = 'failed', error_msg = %s, "
            "connector_name = %s, processed_at = NOW() WHERE id = %s",
            (error_msg, connector_name, capture_id),
        )
    conn.commit()
    # If a still-pending worklist row matches this URL, mark it 'failed' too so
    # the worklist page shows the owner the capture didn't take (e.g. they
    # captured too early, before the Angular page hydrated). Best-effort.
    _correlate_worklist(conn, url, "failed", None)
    logger.warning("extension_capture id=%s: failed — %s", capture_id, error_msg)
