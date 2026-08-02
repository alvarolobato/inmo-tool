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
from datetime import datetime, timezone

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
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

# Consecutive discover() sweeps a listing must be absent from before it's
# marked withdrawn (issue #12 EC-5). Picked to tolerate one-off pagination
# noise or a transient per-item failure without over-tolerating a listing
# that's genuinely gone — not empirically tuned yet, revisit once real
# sweep-to-sweep variance is observed in practice.
_WITHDRAWAL_THRESHOLD = 3


def _update_existing_listing(
    cur,
    canonical: CanonicalListingVersion,
    listing_id: int,
    property_id: int,
    prev_price,
    prev_status: str,
) -> None:
    """Update an existing listing/property in place; append history on real changes.

    Every column update is COALESCE-guarded (new value, else keep the old
    one) rather than a blind overwrite. Two reasons this matters, not just
    for `property`: (1) once Phase 2's dedup engine (#16) reassigns a
    listing's property_id onto a property shared with another listing,
    every re-visit of *either* listing must not erase what the other
    contributed just because this particular fetch happened not to surface
    a field; (2) even before dedup, a single listing's own detail page can
    temporarily fail to render a field (rate limiting, a partial page load)
    — a None from `normalize()` should never be trusted as "this field is
    now empty", only as "we don't know this time". `status`/`current_price`
    still update normally on a real change because a real change is a
    non-None value, which COALESCE always prefers over the old one.
    """
    cur.execute(
        """
        UPDATE property
           SET address = COALESCE(%s, address), lat = COALESCE(%s, lat),
               lon = COALESCE(%s, lon), property_type = COALESCE(%s, property_type),
               m2_built = COALESCE(%s, m2_built), m2_useful = COALESCE(%s, m2_useful),
               rooms = COALESCE(%s, rooms), bathrooms = COALESCE(%s, bathrooms),
               floor = COALESCE(%s, floor), has_elevator = COALESCE(%s, has_elevator),
               year_built = COALESCE(%s, year_built),
               energy_rating = COALESCE(%s, energy_rating)
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
           SET url = COALESCE(%s, url), listing_kind = COALESCE(%s, listing_kind),
               status = COALESCE(%s, status), last_seen_at = NOW(),
               current_price = COALESCE(%s, current_price),
               description = COALESCE(%s, description),
               photo_urls = %s, contact_raw = COALESCE(%s, contact_raw),
               raw_extra = %s, missed_discovery_count = 0
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
    if canonical.current_price is not None and canonical.current_price != prev_price:
        cur.execute(
            "INSERT INTO listing_price_history (listing_id, observed_at, price) "
            "VALUES (%s, NOW(), %s)",
            (listing_id, canonical.current_price),
        )
    if canonical.status is not None and canonical.status != prev_status:
        cur.execute(
            "INSERT INTO listing_status_event (listing_id, observed_at, status) "
            "VALUES (%s, NOW(), %s)",
            (listing_id, canonical.status),
        )


def _upsert_canonical_listing(conn, canonical: CanonicalListingVersion) -> None:
    """Persist one normalized listing: new property+listing, or update existing.

    First time we see (source, external_id): create a singleton `property`
    row and a `listing` row pointing to it (issue #10 — listing.property_id
    is NOT NULL by design, dedup reassigns it later, it never starts null).
    Seen before: update the existing listing/property in place via
    _update_existing_listing.

    The SELECT-then-INSERT-if-absent shape has an inherent TOCTOU race: an
    overlapping manual `--once` run and the scheduled hourly loop (or any
    other concurrent double-run) can both see "not found" for the same
    (source, external_id) and both attempt the INSERT. `listing` has a
    UNIQUE (source, external_id) constraint, so the loser gets a
    UniqueViolation instead of silently duplicating data — caught below and
    turned into the same update path a normal re-visit would take, rather
    than surfacing as a connector fetch error.
    """
    from psycopg2.errors import (
        UniqueViolation,
    )  # lazy: optional dep, see etl/db/postgres.py

    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, property_id, current_price, status FROM listing "
            "WHERE source = %s AND external_id = %s",
            (canonical.source, canonical.external_id),
        )
        existing = cur.fetchone()

        if existing is not None:
            listing_id, property_id, prev_price, prev_status = existing
            _update_existing_listing(
                cur, canonical, listing_id, property_id, prev_price, prev_status
            )
            conn.commit()
            return

        try:
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
        except UniqueViolation:
            # Rolls back the whole uncommitted transaction, including the
            # `property` row this attempt just created — it was never
            # committed, so there's nothing orphaned to clean up. Re-fetch
            # the row the winning concurrent run created and update it
            # instead, on a fresh cursor (the old one's transaction aborted).
            conn.rollback()
            with conn.cursor() as retry_cur:
                retry_cur.execute(
                    "SELECT id, property_id, current_price, status FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (canonical.source, canonical.external_id),
                )
                listing_id, property_id, prev_price, prev_status = retry_cur.fetchone()
                _update_existing_listing(
                    retry_cur,
                    canonical,
                    listing_id,
                    property_id,
                    prev_price,
                    prev_status,
                )
            conn.commit()
            return

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
    conn.commit()


def _reconcile_missed_discoveries(
    conn, source: str, discovered_external_ids: set[str]
) -> None:
    """Track discover()-sweep absences; mark withdrawn after N consecutive misses.

    Called once per connector run, right after discover() returns, before
    any fetch_detail happens — this only needs the *set* of external_ids
    discover() found, not their detail data. A listing missing from one
    sweep isn't necessarily gone (pagination noise, falling off page 1 as
    newer listings push it down, a transient site hiccup on that one
    query) — see issue #12 EC-5 and _WITHDRAWAL_THRESHOLD's docstring.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, external_id, missed_discovery_count FROM listing "
            "WHERE source = %s AND status = 'active'",
            (source,),
        )
        active_listings = cur.fetchall()

        for listing_id, external_id, missed_count in active_listings:
            if external_id in discovered_external_ids:
                if missed_count != 0:
                    cur.execute(
                        "UPDATE listing SET missed_discovery_count = 0 WHERE id = %s",
                        (listing_id,),
                    )
                continue

            new_count = missed_count + 1
            if new_count >= _WITHDRAWAL_THRESHOLD:
                cur.execute(
                    "UPDATE listing SET status = 'withdrawn', missed_discovery_count = %s "
                    "WHERE id = %s",
                    (new_count, listing_id),
                )
                cur.execute(
                    "INSERT INTO listing_status_event (listing_id, observed_at, status) "
                    "VALUES (%s, NOW(), 'withdrawn')",
                    (listing_id,),
                )
                logger.info(
                    "Connector %s: listing external_id=%s marked withdrawn after "
                    "%d consecutive missed discoveries",
                    source,
                    external_id,
                    new_count,
                )
            else:
                cur.execute(
                    "UPDATE listing SET missed_discovery_count = %s WHERE id = %s",
                    (new_count, listing_id),
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
    started_at: datetime,
    finished_at: datetime,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_run_results
                (run_id, connector_name, started_at, finished_at, status,
                 discovered_count, fetched_count, error_count, error_msg)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                run_id,
                connector_name,
                started_at,
                finished_at,
                status,
                discovered_count,
                fetched_count,
                error_count,
                error_msg,
            ),
        )
    conn.commit()


def _reconcile_stale_runs(conn) -> None:
    """Mark any `connector_runs` row stuck at status='running' as interrupted.

    A crashed process (killed container, OOM, host reboot) leaves its run
    row at 'running' forever — nothing else would ever transition it, and a
    permanently-'running' row is indistinguishable from "still in
    progress" to anything monitoring this table. Run this before starting a
    new run so staleness never has a chance to accumulate silently.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE connector_runs
               SET status = 'failed', finished_at = NOW(),
                   duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
             WHERE status = 'running'
            """
        )
        reconciled = cur.rowcount
    conn.commit()
    if reconciled:
        logger.warning(
            "Reconciled %d stale connector_runs row(s) stuck at status='running' "
            "(likely from a crashed prior process)",
            reconciled,
        )


def run_connector(conn, connector: Connector, scope: ConnectorScope) -> dict:
    """Run one connector's discover -> fetch_detail -> normalize -> store cycle.

    Returns a summary dict; never raises for per-listing failures (those
    count toward the circuit breaker and get logged) — only raises if
    discover() itself fails, since without a target list there's nothing
    to run.
    """
    limiter = RateLimiter(connector.rate_limit_per_minute)
    breaker = CircuitBreaker(
        connector.circuit_breaker_error_rate,
        connector.circuit_breaker_min_attempts,
        window=connector.circuit_breaker_window,
    )

    limiter.acquire()
    external_ids = connector.discover(scope, throttle=limiter.acquire)
    if external_ids:
        _reconcile_missed_discoveries(conn, connector.name, set(external_ids))
    else:
        # An empty discover() result is never trusted enough to bump every
        # active listing's miss-counter — a well-behaved connector should
        # already raise ConnectorError on a soft-block/interruption page
        # rather than return an empty list (see fotocasa.py's
        # _INITIAL_PROPS_MARKER check), but this is a second line of
        # defense: even a connector bug that returns [] instead of raising
        # must not be able to mass-withdraw a source's entire inventory.
        logger.warning(
            "Connector %s: discover() returned zero external_ids — skipping "
            "withdrawal reconciliation this run (see run_connector docstring)",
            connector.name,
        )

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
            raw = connector.fetch_detail(external_id, throttle=limiter.acquire)
            canonical = connector.normalize(raw)
            _upsert_canonical_listing(conn, canonical)
        except Exception as exc:  # noqa: BLE001 — any failure (fetch, normalize, or persist) counts toward the breaker
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


def run_all_connectors(
    conn, trigger: str = "scheduler", connector_name: str | None = None
) -> int:
    """Run every registered connector once, recording a connector_runs row.

    Safe to call with an empty CONNECTORS registry (EC-4) — records a run
    with total_connectors=0 and returns immediately.

    `connector_name`, when given, restricts the run to that one connector
    (task 1.5, #13 — backs `ps connector run <name>`). Unknown names raise
    ValueError immediately, before creating a connector_runs row — an
    operator typo shouldn't leave a phantom "ran zero connectors" record
    behind.
    """
    if connector_name is not None:
        matching = [c for c in CONNECTORS if c.name == connector_name]
        if not matching:
            known = ", ".join(c.name for c in CONNECTORS) or "(none registered)"
            raise ValueError(f"Unknown connector {connector_name!r} — known: {known}")
        connectors_to_run = matching
    else:
        connectors_to_run = CONNECTORS

    _reconcile_stale_runs(conn)
    run_id = _create_connector_run(conn, trigger)
    ok = 0
    failed = 0

    for connector in connectors_to_run:
        started_at = datetime.now(timezone.utc)
        try:
            result = run_connector(conn, connector, _DEFAULT_SCOPE)
        except (
            Exception
        ) as exc:  # one connector's discover() failing shouldn't kill the run
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
                started_at=started_at,
                finished_at=datetime.now(timezone.utc),
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
            started_at=started_at,
            finished_at=datetime.now(timezone.utc),
        )

    _finish_connector_run(conn, run_id, ok, failed)
    return run_id


def run_scheduler_loop(conn_factory, interval_seconds: int = 3600) -> None:
    """Run all connectors on a fixed interval, forever. Long-running-container mode.

    Each iteration is isolated: a transient failure (DB connection drop,
    deadlock, an unexpected exception anywhere in run_all_connectors) is
    logged and the loop continues to the next scheduled iteration, rather
    than propagating and killing the long-running container process. The
    alternative — letting the process die — turns one bad hour into total
    ingestion downtime until something notices the container exited.
    """
    while True:
        conn = conn_factory()
        try:
            run_all_connectors(conn, trigger="scheduler")
        except Exception:
            logger.exception(
                "run_all_connectors failed for this scheduler iteration — "
                "will retry at the next interval rather than exit"
            )
        finally:
            conn.close()
        time.sleep(interval_seconds)
