"""Seeds the guided-capture worklist from a portal's public sitemap (issue #260).

Cimenta2 is the one portal whose full inventory is enumerable from a public,
robots-allowed sitemap (D-034/D-035), so its worklist can be seeded
automatically instead of by manual paste. This module does exactly that and
nothing more:

  * **Discovery-only.** ONE static GET of the sitemap index and ONE of the
    `ga-activo` child sitemap — the same two requests `cimenta2.discover()`
    makes. It NEVER fetches a listing/detail page and NEVER touches the
    Salesforce guest `getRecord` endpoint (D-033 forbids it). No third-party
    PII is read: a sitemap `<loc>` carries only a record id and a reference
    code.
  * **Idempotent.** Each detail URL is upserted `ON CONFLICT (match_key) DO
    NOTHING`, so re-running adds only genuinely-new listings and never
    duplicates or resurrects a row the operator has since skipped/captured
    (those keep their status; the insert is simply ignored).

Transport: the worklist page can't run this in-process (it's Python, in a
separate container), so it signals a run by writing a
`capture_worklist_seed_trigger` row; `run_worklist_seed_poll_loop` (a thread in
etl/main.py, same idiom as etl/capture.py and etl/manual_trigger.py) claims it
and runs `seed_cimenta2_worklist`. The match-key canonicalisation is reused
verbatim from etl.capture so a later capture correlates to the seeded row.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

import requests

from etl.capture import worklist_match_key
from etl.connectors.cimenta2_mapping import (
    asset_sitemap_url,
    iter_locs,
    parse_asset_url,
)

logger = logging.getLogger("etl.worklist_seed")

CIMENTA2_PORTAL = "cimenta2"

# Public, robots-allowed sitemap (see etl/connectors/cimenta2.py for the live
# robots.txt evidence). Re-declared here rather than imported from the
# connector's private module-level names so this discovery-only seeding path
# does not reach into the connector's internals.
_BASE_URL = "https://inmuebles.cimenta2.com"
_SITEMAP_INDEX_URL = f"{_BASE_URL}/inmuebles/s/sitemap.xml"
_ASSET_SITEMAP_DEFAULT_URL = f"{_BASE_URL}/inmuebles/s/sitemap-ga_activo__c-1.xml"
_REQUEST_TIMEOUT_SECONDS = 25
_USER_AGENT = (
    "inmo-tool/0.1 (personal real-estate research; "
    "contact: github.com/alvarolobato/inmo-tool)"
)

# A fetcher is injectable so the seeding logic is testable against fixture XML
# with no network — the real one is `_http_get`.
Fetcher = Callable[[str], str]


def _http_get(url: str) -> str:
    """One honest, read-only GET of a public sitemap document."""
    response = requests.get(
        url,
        headers={"User-Agent": _USER_AGENT},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.text


def parse_worklist_rows(child_sitemap_xml: str) -> list[dict[str, str]]:
    """Pure: turn a `ga-activo` child-sitemap document into worklist rows.

    Each returned dict is `{url, match_key, external_id}` for one asset
    detail URL. Non-asset `<loc>` entries (a mixed sitemap, an error page's
    stray links) are skipped by `parse_asset_url` returning None. `external_id`
    is the Salesforce record id from the slug; `match_key` is the same
    canonical form etl.capture correlates on.

    No network, no DB — the unit test drives this with a fixture so the parse
    is pinned independently of the HTTP and upsert layers.
    """
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for loc in iter_locs(child_sitemap_xml):
        parsed = parse_asset_url(loc)
        if parsed is None:
            continue
        record_id, _reference = parsed
        key = worklist_match_key(loc)
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append({"url": loc, "match_key": key, "external_id": record_id})
    return rows


def seed_cimenta2_worklist(conn, *, fetch: Fetcher = _http_get) -> int:
    """Fetch Cimenta2's public sitemap and upsert `pending` worklist rows.

    Returns the number of NEW rows inserted (re-seeding an unchanged catalogue
    returns 0). Discovery-only: two GETs (index, then child sitemap), nothing
    else. Raises `ValueError` if the sitemap yields no recognisable asset URLs
    — that is the shape of an error/interstitial page served with a 200, and
    (mirroring `cimenta2.discover()`'s guards) it must be a loud failure, not a
    silent "0 added", so the trigger is marked failed rather than done.
    """
    index_xml = fetch(_SITEMAP_INDEX_URL)
    child_url = asset_sitemap_url(
        index_xml,
        base_url=_BASE_URL,
        default_url=_ASSET_SITEMAP_DEFAULT_URL,
    )
    if child_url is None:
        raise ValueError(
            "cimenta2 worklist seed: could not determine the asset sitemap URL "
            "from the sitemap index — the index response was not usable"
        )

    child_xml = fetch(child_url)
    rows = parse_worklist_rows(child_xml)
    if not rows:
        raise ValueError(
            f"cimenta2 worklist seed: {child_url} yielded no recognisable "
            "ga-activo asset URLs — likely an error or interstitial page "
            "rather than the real sitemap; refusing to treat it as an empty "
            "catalogue"
        )

    added = 0
    with conn.cursor() as cur:
        for row in rows:
            cur.execute(
                """
                INSERT INTO capture_worklist
                    (url, match_key, source_portal, added_via, external_id, status)
                VALUES (%s, %s, %s, 'sitemap', %s, 'pending')
                ON CONFLICT (match_key) DO NOTHING
                RETURNING id
                """,
                (row["url"], row["match_key"], CIMENTA2_PORTAL, row["external_id"]),
            )
            if cur.fetchone() is not None:
                added += 1
    conn.commit()
    logger.info(
        "cimenta2 worklist seed: %d new row(s) from %d sitemap asset(s) at %s",
        added,
        len(rows),
        child_url,
    )
    return added


# Portal -> seeding function. A portal that later gains a sitemap adds ONE entry
# here (issue #260 §2), not a new mechanism.
_SEEDERS: dict[str, Callable[..., int]] = {
    CIMENTA2_PORTAL: seed_cimenta2_worklist,
}


def _claim_pending_seed(conn) -> tuple[int, str] | None:
    """Claim the oldest pending seed request, flipping it to 'running'.

    `FOR UPDATE SKIP LOCKED` so two pollers never claim the same row. Returns
    `(trigger_id, source_portal)` or None when nothing is pending.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE capture_worklist_seed_trigger
                SET status = 'running', picked_up_at = NOW()
                WHERE id = (
                    SELECT id FROM capture_worklist_seed_trigger
                    WHERE status = 'pending'
                    ORDER BY requested_at, id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id, source_portal
                """
            )
            row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
        return int(row[0]), str(row[1])
    except Exception:
        conn.rollback()
        raise


def _mark_done(conn, trigger_id: int, added_count: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE capture_worklist_seed_trigger "
            "SET status = 'done', added_count = %s, finished_at = NOW(), "
            "    error_msg = NULL "
            "WHERE id = %s",
            (added_count, trigger_id),
        )
    conn.commit()


def _mark_failed(conn, trigger_id: int, error_msg: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE capture_worklist_seed_trigger "
            "SET status = 'failed', error_msg = %s, finished_at = NOW() "
            "WHERE id = %s",
            (error_msg, trigger_id),
        )
    conn.commit()
    logger.warning(
        "capture_worklist_seed_trigger id=%s: failed — %s", trigger_id, error_msg
    )


def process_pending_seed_trigger(conn, *, fetch: Fetcher = _http_get) -> int | None:
    """Claim and run one pending seed request, if any. Returns its id (done or
    failed), or None when nothing was pending.

    Each request is isolated: a portal with no seeder, or a sitemap that comes
    back unusable, marks that one request failed with a human-readable message
    (surfaced by the dashboard) and never wedges the poll loop.
    """
    claimed = _claim_pending_seed(conn)
    if claimed is None:
        return None
    trigger_id, portal = claimed

    seeder = _SEEDERS.get(portal)
    if seeder is None:
        conn.rollback()
        _mark_failed(
            conn,
            trigger_id,
            f"No hay siembra por sitemap para el portal '{portal}'.",
        )
        return trigger_id

    try:
        added = seeder(conn, fetch=fetch)
    except ValueError as exc:
        # Expected, human-readable (unusable sitemap). Recorded, not logged
        # with a traceback.
        conn.rollback()
        _mark_failed(conn, trigger_id, str(exc))
        return trigger_id
    except Exception as exc:
        conn.rollback()
        logger.exception(
            "capture_worklist_seed_trigger id=%s: unexpected error during seed",
            trigger_id,
        )
        _mark_failed(conn, trigger_id, f"Error interno inesperado: {exc}")
        return trigger_id

    _mark_done(conn, trigger_id, added)
    logger.info(
        "capture_worklist_seed_trigger id=%s: seeded %s -> %d new row(s)",
        trigger_id,
        portal,
        added,
    )
    return trigger_id


def run_worklist_seed_poll_loop(conn_factory, interval_seconds: int = 10) -> None:
    """Poll `capture_worklist_seed_trigger` on a short interval, forever.

    Its own thread (see etl/main.py), on a much shorter interval than the
    hourly scheduler, with the same "one bad iteration shouldn't kill the loop"
    isolation as etl.capture.run_capture_poll_loop.
    """
    while True:
        conn = conn_factory()
        try:
            trigger_id = process_pending_seed_trigger(conn)
            if trigger_id is not None:
                logger.info("Processed worklist seed trigger id=%s", trigger_id)
        except Exception:
            logger.exception(
                "process_pending_seed_trigger failed for this poll iteration — "
                "will retry next interval rather than exit"
            )
        finally:
            conn.close()
        time.sleep(interval_seconds)
