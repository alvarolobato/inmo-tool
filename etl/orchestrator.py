"""Runs registered connectors, persists results, records observability.

Port of the source project's run_full_sync/_run_scheduler_loop shape
(issue #11), retargeted from "iterate table-sync functions" to "iterate
registered Connector instances". No real connector is registered yet —
that's task 1.4; `CONNECTORS` starts empty and `run_all_connectors` on an
empty registry is a supported, tested no-op (EC-4).
"""

from __future__ import annotations

import logging
import time

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
)
from etl.connectors.circuit_breaker import CircuitBreaker
from etl.connectors.rate_limit import RateLimiter

logger = logging.getLogger("etl.orchestrator")

# Registered connectors. Empty until task 1.4 adds the first real one —
# `python -m etl.main --once` must still run cleanly against this (EC-4),
# since Phase 1.3 ships before any connector exists.
CONNECTORS: list[Connector] = []

# Default scope used until Phase 2's search_profile exists to derive one
# (issue #11's "Additional Context" — profile-driven scoping is
# aspirational for this task).
_DEFAULT_SCOPE = ConnectorScope(geography="")


def _upsert_canonical_listing(conn, canonical: CanonicalListingVersion) -> None:
    """Persist one normalized listing: new property+listing, or update existing.

    First time we see (source, external_id): create a singleton `property`
    row and a `listing` row pointing to it (issue #10 — listing.property_id
    is NOT NULL by design, dedup reassigns it later, it never starts null).
    Seen before: update the existing listing/property in place and append
    price/status history rows when either actually changed.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, property_id, current_price, status FROM listing "
            "WHERE source = %s AND external_id = %s",
            (canonical.source, canonical.external_id),
        )
        existing = cur.fetchone()

        if existing is None:
            cur.execute(
                """
                INSERT INTO property
                    (address, lat, lon, property_type, m2_built, m2_useful,
                     rooms, bathrooms, floor, has_elevator, year_built, energy_rating)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    canonical.address,
                    canonical.lat,
                    canonical.lon,
                    canonical.property_type,
                    canonical.m2_built,
                    canonical.m2_useful,
                    canonical.rooms,
                    canonical.bathrooms,
                    canonical.floor,
                    canonical.has_elevator,
                    canonical.year_built,
                    canonical.energy_rating,
                ),
            )
            property_id = cur.fetchone()[0]

            cur.execute(
                """
                INSERT INTO listing
                    (property_id, source, external_id, url, listing_kind, status,
                     first_seen_at, last_seen_at, current_price, description,
                     photo_urls, contact_raw, raw_extra)
                VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW(), %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    property_id,
                    canonical.source,
                    canonical.external_id,
                    canonical.url,
                    canonical.listing_kind,
                    canonical.status,
                    canonical.current_price,
                    canonical.description,
                    list(canonical.photo_urls),
                    canonical.contact_raw,
                    _to_jsonb_param(canonical.raw_extra),
                ),
            )
            listing_id = cur.fetchone()[0]

            if canonical.current_price is not None:
                cur.execute(
                    "INSERT INTO listing_price_history (listing_id, observed_at, price) "
                    "VALUES (%s, NOW(), %s)",
                    (listing_id, canonical.current_price),
                )
            cur.execute(
                "INSERT INTO listing_status_event (listing_id, observed_at, status) "
                "VALUES (%s, NOW(), %s)",
                (listing_id, canonical.status),
            )
        else:
            listing_id, property_id, prev_price, prev_status = existing

            cur.execute(
                """
                UPDATE property
                   SET address = %s, lat = %s, lon = %s, property_type = %s,
                       m2_built = %s, m2_useful = %s, rooms = %s, bathrooms = %s,
                       floor = %s, has_elevator = %s, year_built = %s, energy_rating = %s
                 WHERE id = %s
                """,
                (
                    canonical.address,
                    canonical.lat,
                    canonical.lon,
                    canonical.property_type,
                    canonical.m2_built,
                    canonical.m2_useful,
                    canonical.rooms,
                    canonical.bathrooms,
                    canonical.floor,
                    canonical.has_elevator,
                    canonical.year_built,
                    canonical.energy_rating,
                    property_id,
                ),
            )
            cur.execute(
                """
                UPDATE listing
                   SET url = %s, listing_kind = %s, status = %s, last_seen_at = NOW(),
                       current_price = %s, description = %s, photo_urls = %s,
                       contact_raw = %s, raw_extra = %s
                 WHERE id = %s
                """,
                (
                    canonical.url,
                    canonical.listing_kind,
                    canonical.status,
                    canonical.current_price,
                    canonical.description,
                    list(canonical.photo_urls),
                    canonical.contact_raw,
                    _to_jsonb_param(canonical.raw_extra),
                    listing_id,
                ),
            )
            if (
                canonical.current_price is not None
                and canonical.current_price != prev_price
            ):
                cur.execute(
                    "INSERT INTO listing_price_history (listing_id, observed_at, price) "
                    "VALUES (%s, NOW(), %s)",
                    (listing_id, canonical.current_price),
                )
            if canonical.status != prev_status:
                cur.execute(
                    "INSERT INTO listing_status_event (listing_id, observed_at, status) "
                    "VALUES (%s, NOW(), %s)",
                    (listing_id, canonical.status),
                )
    conn.commit()


def _to_jsonb_param(value: dict) -> str:
    import json

    return json.dumps(value)


def _create_connector_run(conn, trigger: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO connector_runs (trigger, status) VALUES (%s, 'running') RETURNING id",
            (trigger,),
        )
        run_id: int = cur.fetchone()[0]
    conn.commit()
    return run_id


def _finish_connector_run(conn, run_id: int, ok: int, failed: int) -> None:
    status = "success" if failed == 0 else ("partial" if ok > 0 else "failed")
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE connector_runs
               SET finished_at = NOW(), status = %s, connectors_ok = %s,
                   connectors_failed = %s, total_connectors = %s,
                   duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
             WHERE id = %s
            """,
            (status, ok, failed, ok + failed, run_id),
        )
    conn.commit()


def _record_connector_result(
    conn,
    run_id: int,
    connector_name: str,
    *,
    status: str,
    discovered_count: int,
    fetched_count: int,
    error_count: int,
    error_msg: str | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_run_results
                (run_id, connector_name, started_at, finished_at, status,
                 discovered_count, fetched_count, error_count, error_msg)
            VALUES (%s, %s, NOW(), NOW(), %s, %s, %s, %s, %s)
            """,
            (
                run_id,
                connector_name,
                status,
                discovered_count,
                fetched_count,
                error_count,
                error_msg,
            ),
        )
    conn.commit()


def run_connector(conn, connector: Connector, scope: ConnectorScope) -> dict:
    """Run one connector's discover -> fetch_detail -> normalize -> store cycle.

    Returns a summary dict; never raises for per-listing failures (those
    count toward the circuit breaker and get logged) — only raises if
    discover() itself fails, since without a target list there's nothing
    to run.
    """
    limiter = RateLimiter(connector.rate_limit_per_minute)
    breaker = CircuitBreaker(
        connector.circuit_breaker_error_rate, connector.circuit_breaker_min_attempts
    )

    limiter.acquire()
    external_ids = connector.discover(scope)

    fetched = 0
    errors = 0
    circuit_open = False

    for external_id in external_ids:
        if breaker.tripped:
            circuit_open = True
            logger.error(
                "Connector %s: circuit breaker open after %d/%d errors — "
                "aborting remaining %d of %d discovered listings",
                connector.name,
                breaker.errors,
                breaker.attempts,
                len(external_ids) - fetched - errors,
                len(external_ids),
            )
            break

        limiter.acquire()
        try:
            raw = connector.fetch_detail(external_id)
            canonical = connector.normalize(raw)
            _upsert_canonical_listing(conn, canonical)
        except (ConnectorError, Exception) as exc:  # noqa: BLE001 — any failure (fetch, normalize, or persist) counts toward the breaker
            conn.rollback()  # reset connection state in case the failure was a DB error mid-transaction
            errors += 1
            breaker.record_error()
            logger.warning(
                "Connector %s: failed on external_id=%s: %s",
                connector.name,
                external_id,
                exc,
            )
            continue

        fetched += 1
        breaker.record_success()

    return {
        "discovered_count": len(external_ids),
        "fetched_count": fetched,
        "error_count": errors,
        "circuit_open": circuit_open,
    }


def run_all_connectors(conn, trigger: str = "scheduler") -> int:
    """Run every registered connector once, recording a connector_runs row.

    Safe to call with an empty CONNECTORS registry (EC-4) — records a run
    with total_connectors=0 and returns immediately.
    """
    run_id = _create_connector_run(conn, trigger)
    ok = 0
    failed = 0

    for connector in CONNECTORS:
        try:
            result = run_connector(conn, connector, _DEFAULT_SCOPE)
        except Exception as exc:  # one connector's discover() failing shouldn't kill the run
            failed += 1
            logger.exception("Connector %s: discover() failed", connector.name)
            _record_connector_result(
                conn,
                run_id,
                connector.name,
                status="failed",
                discovered_count=0,
                fetched_count=0,
                error_count=0,
                error_msg=str(exc),
            )
            continue

        status = "circuit_open" if result["circuit_open"] else "ok"
        if status == "ok":
            ok += 1
        else:
            failed += 1
        _record_connector_result(
            conn,
            run_id,
            connector.name,
            status=status,
            discovered_count=result["discovered_count"],
            fetched_count=result["fetched_count"],
            error_count=result["error_count"],
            error_msg=None,
        )

    _finish_connector_run(conn, run_id, ok, failed)
    return run_id


def run_scheduler_loop(conn_factory, interval_seconds: int = 3600) -> None:
    """Run all connectors on a fixed interval, forever. Long-running-container mode."""
    while True:
        conn = conn_factory()
        try:
            run_all_connectors(conn, trigger="scheduler")
        finally:
            conn.close()
        time.sleep(interval_seconds)
