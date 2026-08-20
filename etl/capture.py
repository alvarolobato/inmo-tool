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
from urllib.parse import urljoin, urlparse

from etl.connectors.aliseda import AlisedaConnector
from etl.connectors.altamira import AltamiraConnector
from etl.connectors.base import CanonicalListingVersion, ConnectorError, RawListing
from etl.connectors.hipoges import HipogesConnector
from etl.connectors.idealista import IdealistaConnector
from etl.listing_detect import detail_portal_for_url, listing_portal_for_url

logger = logging.getLogger("etl.capture")

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
# `_sighting_ids_from_detail_urls` (issue #639) to turn a results-page's
# harvested detail URLs back into external_ids via each connector's own
# `external_id_from_url` — the same id extraction `_connector_for_url` uses
# for a single detail capture.
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
            "SELECT id, url, html FROM extension_capture "
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
    for capture_id, url, html in pending:
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
            if _process_one(conn, capture_id, url, html):
                ingested += 1
        except Exception:
            logger.exception(
                "extension_capture id=%s: unexpected error, marking failed",
                capture_id,
            )
            _mark_failed(conn, capture_id, url, "Unexpected internal error")
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


def _sighting_ids_from_detail_urls(portal: str, urls: list[str]) -> list[str]:
    """External ids for `portal`'s own `_update_last_seen_for_discovered` call
    (issue #639), extracted from a results page's harvested detail URLs via
    each connector's own `external_id_from_url` — the exact id-extraction
    `_connector_for_url` already uses for a single detail capture. De-duped,
    order-preserving. Unknown portal or an unparseable URL contributes
    nothing (defensive; `_extract_detail_urls_from_html` already filtered
    `urls` to `portal`'s own detail shape)."""
    connector_cls = _CONNECTOR_CLASS_BY_PORTAL.get(portal)
    if connector_cls is None:
        return []
    ids: list[str] = []
    seen: set[str] = set()
    for url in urls:
        external_id = connector_cls.external_id_from_url(url)
        if external_id is None or external_id in seen:
            continue
        seen.add(external_id)
        ids.append(external_id)
    return ids


def _record_sightings(conn, portal: str, urls: list[str]) -> int:
    """Bump `listing.last_seen_at` for every already-known listing this
    captured results page just enumerated (issue #639).

    A results page enumerating a listing is weaker evidence than a detail
    fetch: it proves the advert is STILL LISTED, not that its fields were
    re-read. So this only ever touches `last_seen_at` — never `status`
    (only a real fetch_detail()/normalize() may change that) and never
    `last_fetched_at` (the signal skip-if-seen gates on, per
    etl.orchestrator._update_existing_listing's own docstring — a sighting
    must not make a stale listing look freshly re-fetched and get skipped).

    Delegates the actual UPDATE to etl.orchestrator._update_last_seen_for_discovered
    — the exact mechanism the crawl path already uses to bump presence for
    listings a discover() sweep re-confirmed without fetching their detail
    page — rather than reimplementing the same SQL a second time. Lazy
    import for the same import-cycle reason `_process_one` already uses for
    `_upsert_canonical_listing`.

    A page with zero matches against known listings (nothing recognised, or
    every harvested id belongs to a listing not yet ingested) is a no-op,
    not an error — this is presence bookkeeping layered on an already-clean
    'listing page' outcome, so a failure here must never turn that outcome
    into a failed capture. Returns the number of ids the update targeted (0
    if nothing to do or the update itself failed)."""
    external_ids = _sighting_ids_from_detail_urls(portal, urls)
    if not external_ids:
        return 0
    try:
        from etl.orchestrator import _update_last_seen_for_discovered

        _update_last_seen_for_discovered(conn, portal, external_ids)
    except Exception:
        conn.rollback()
        logger.exception(
            "last_seen_at sighting update failed for portal=%s (%d id(s)) — "
            "the listing-page capture itself is unaffected",
            portal,
            len(external_ids),
        )
        return 0
    return len(external_ids)


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


def _process_one(conn, capture_id: int, url: str, html: str) -> bool:
    """Process one capture. Returns True if a listing was actually ingested
    (upserted into `property`/`listing`), False otherwise (a listing/search
    page routed to the batch worklist, or a genuinely failed detail capture).
    The caller uses the True count to decide whether the batch should fire a
    dashboard re-materialize (issue #269)."""
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
            sighted = _record_sightings(conn, portal, detail_urls)
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
    raw = RawListing(
        external_id=external_id, source=connector.name, raw={"url": url, "html": html}
    )

    try:
        canonical = connector.normalize(raw)
    except ConnectorError as exc:
        _mark_failed(conn, capture_id, url, str(exc))
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
    # not yet calibrated (raw_extra.selectors_calibrated is False — Hipoges
    # today) writes an honest near-empty row, but normalize() never raises,
    # so every one of its captures would otherwise reach 'done' with `html`
    # discarded — making it IMPOSSIBLE to later pull the real captured DOM
    # back out of the DB to build the real fixtures #547 needs. Retain the
    # HTML for exactly that case; every OTHER (calibrated) connector keeps
    # the pre-existing behaviour of dropping it once processed, since there
    # is no reason to hold onto a full page capture once its fields have
    # actually been trusted and extracted.
    retain_html = canonical.raw_extra.get("selectors_calibrated") is False
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


def _mark_failed(conn, capture_id: int, url: str, error_msg: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE extension_capture SET status = 'failed', error_msg = %s, "
            "processed_at = NOW() WHERE id = %s",
            (error_msg, capture_id),
        )
    conn.commit()
    # If a still-pending worklist row matches this URL, mark it 'failed' too so
    # the worklist page shows the owner the capture didn't take (e.g. they
    # captured too early, before the Angular page hydrated). Best-effort.
    _correlate_worklist(conn, url, "failed", None)
    logger.warning("extension_capture id=%s: failed — %s", capture_id, error_msg)
