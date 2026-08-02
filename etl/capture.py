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
from urllib.parse import urlparse

from etl.connectors.base import CanonicalListingVersion, ConnectorError, RawListing
from etl.connectors.idealista import IdealistaConnector

logger = logging.getLogger("etl.capture")

# hostname suffix -> (Connector instance, external_id extractor). Only
# Idealista exists today (issue #75); a future capture-supported site adds
# one entry here, not a new processing mechanism.
_idealista = IdealistaConnector()
_CAPTURE_CONNECTORS: dict[str, tuple[object, type[IdealistaConnector]]] = {
    "idealista.com": (_idealista, IdealistaConnector),
}

_BATCH_LIMIT = 10


def _connector_for_url(url: str) -> tuple[object, str] | None:
    """Return (connector, external_id) for a captured URL, or None if no
    registered capture connector's hostname matches."""
    try:
        hostname = (urlparse(url).hostname or "").removeprefix("www.")
    except ValueError:
        return None
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


def process_pending_captures(conn) -> int:
    """Process every pending extension_capture row. Returns the count
    processed (done + failed). Each row is its own try/except — one bad
    capture (a connector bug, a genuinely malformed HTML blob) must not
    block the rest of the batch or wedge this poll loop."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, url, html FROM extension_capture "
            "WHERE status = 'pending' ORDER BY created_at LIMIT %s",
            (_BATCH_LIMIT,),
        )
        pending = cur.fetchall()

    processed = 0
    for capture_id, url, html in pending:
        try:
            _process_one(conn, capture_id, url, html)
        except Exception:
            logger.exception(
                "extension_capture id=%s: unexpected error, marking failed",
                capture_id,
            )
            _mark_failed(conn, capture_id, "Unexpected internal error")
        processed += 1
    return processed


def _process_one(conn, capture_id: int, url: str, html: str) -> None:
    resolved = _connector_for_url(url)
    if resolved is None:
        _mark_failed(
            conn,
            capture_id,
            "No capture-capable connector recognizes this URL "
            "(only Idealista is supported today, issue #75)",
        )
        return

    connector, external_id = resolved
    raw = RawListing(
        external_id=external_id, source=connector.name, raw={"url": url, "html": html}
    )

    try:
        canonical = connector.normalize(raw)
    except ConnectorError as exc:
        _mark_failed(conn, capture_id, str(exc))
        return

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

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE extension_capture
            SET status = 'done', connector_name = %s, property_id = %s,
                listing_id = %s, fields_extracted = %s, fields_available = %s,
                title = %s, price_display = %s, processed_at = NOW()
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
                capture_id,
            ),
        )
    conn.commit()
    logger.info(
        "extension_capture id=%s: processed via %s -> property_id=%s",
        capture_id,
        connector.name,
        property_id,
    )


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


def _mark_failed(conn, capture_id: int, error_msg: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE extension_capture SET status = 'failed', error_msg = %s, "
            "processed_at = NOW() WHERE id = %s",
            (error_msg, capture_id),
        )
    conn.commit()
    logger.warning("extension_capture id=%s: failed — %s", capture_id, error_msg)
