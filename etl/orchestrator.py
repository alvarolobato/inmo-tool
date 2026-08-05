"""Runs registered connectors, persists results, records observability.

Port of the source project's run_full_sync/_run_scheduler_loop shape
(issue #11), retargeted from "iterate table-sync functions" to "iterate
registered Connector instances". No real connector is registered yet —
that's task 1.4; `CONNECTORS` starts empty and `run_all_connectors` on an
empty registry is a supported, tested no-op (EC-4).
"""

from __future__ import annotations

import dataclasses
import json
import logging
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal, NamedTuple

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorScope,
    ListingUnavailableError,
    SoftBlockError,
)
from etl.connectors.circuit_breaker import CircuitBreaker
from etl.connectors.geography import (
    UnresolvableGeographyError,
    is_unresolvable_scope_key,
    resolve_place,
)
from etl.connectors.rate_limit import RateLimiter
from etl.db import postgres
from etl.dedup import engine as dedup_engine

# Default bounded lifetime for a single dedup pass (D-036). A run currently
# takes ~84 min (dropping once issue #226's photo-hash persistence deploys);
# 2h leaves comfortable headroom over that while still being far below the
# 9-19h orphaned rows observed on the live instance. A dedup_runs row still
# 'running' past this age with no active run is treated as a dead orphan and
# reconciled to 'failed'. Overridable via ETL_DEDUP_MAX_RUNTIME_SECONDS /
# etl.dedup_max_runtime_seconds (config/schema.yaml).
_DEFAULT_DEDUP_MAX_RUNTIME_SECONDS = 7200

# Issue #295 (D-050): freshness cadence defaults, used when no operator config
# is threaded in (manual/CLI paths, direct test callers). The scheduler path
# passes the operator-configured values (etl.default_freshness_interval_hours /
# etl.freshness_cycle_stuck_after_hours, config/schema.yaml) instead. 24h
# matches the dashboard's FRESHNESS_STALE_THRESHOLD_HOURS (#241); 168h (7d) is a
# pure visibility threshold that never force-completes a cycle.
_DEFAULT_FRESHNESS_INTERVAL_HOURS = 24
_DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS = 168

logger = logging.getLogger("etl.orchestrator")


class UnknownConnectorError(ValueError):
    """Raised by run_all_connectors(connector_name=...) for an unrecognized name.

    A dedicated type (task 1.5, #13 review) rather than a bare ValueError —
    main.py's CLI error handling catches this specifically to print a clean
    operator-facing message and exit 1, without also silently swallowing
    some unrelated ValueError as if it were a connector-name typo.
    """


# Registered connectors. Empty until task 1.4 adds the first real one —
# `python -m etl.main --once` must still run cleanly against this (EC-4),
# since Phase 1.3 ships before any connector exists.
CONNECTORS: list[Connector] = []

# How closely two profiles' geography must agree to count as "the same
# scope" for dedup purposes (issue #71) — rounding to this many decimal
# places on lat/lon (~11m at 4dp) and 1dp on radius_km collapses
# floating-point noise from JSON round-tripping without merging two
# genuinely different search areas.
_SCOPE_DEDUP_DECIMALS = 4

# Consecutive discover() sweeps a listing must be absent from before it's
# marked withdrawn (issue #12 EC-5). Picked to tolerate one-off pagination
# noise or a transient per-item failure without over-tolerating a listing
# that's genuinely gone — not empirically tuned yet, revisit once real
# sweep-to-sweep variance is observed in practice.
_WITHDRAWAL_THRESHOLD = 3

# Issue #291: a fetch_detail() that returns HTTP 404/410 for a discovered
# listing is expected inventory churn (the listing was removed at the source
# between discovery and fetch) and is counted as a clean skip, not an error.
# But if a LARGE fraction of a scope's fetch attempts come back "gone", that
# is not churn — it's the detail-URL shape (or the whole detail path) having
# broken, so every real listing 404s. Above this fraction of attempted
# fetches, and with at least `_GONE_ALARM_MIN_ATTEMPTS` attempts to have a
# meaningful sample, that's logged as a structural alarm (the shared circuit
# breaker also trips on a total break, since "gone" still records a breaker
# error — this alarm is the specific diagnosis that a bare circuit_open
# status can't give). Deliberately high: real churn between a fresh
# discover() and an immediate fetch is a small single-digit percent (the
# live evidence in issue #291 is ~5%: 7 gone of ~143 attempted).
_GONE_ALARM_RATIO = 0.5
_GONE_ALARM_MIN_ATTEMPTS = 10

# Postgres' auto-generated name for listing's UNIQUE (source, external_id)
# — the one unique violation `_upsert_canonical_listing` knows how to
# recover from (a concurrent run won the insert race). See the narrowed
# handler there for why any other violation must propagate instead.
_LISTING_SOURCE_EXTERNAL_ID_CONSTRAINT = "listing_source_external_id_key"

# Issue #217 (D-030): sort key stand-in for "this scope has never reached a
# real attempt for this connector" — deliberately timezone-aware so it can
# be compared directly against `connector_scope_state.last_attempted_at`
# (a TIMESTAMPTZ, always returned tz-aware by psycopg2) without a
# naive/aware comparison crashing `sorted()`. Anything actually recorded in
# `connector_scope_state` sorts after this by construction (real attempts
# happen well after `datetime.min`), which is what gives a never-attempted
# scope top priority — see `_order_scopes_by_fairness`.
_NEVER_ATTEMPTED = datetime.min.replace(tzinfo=timezone.utc)


def _constraint_name(exc: Exception) -> str | None:
    """Constraint name from a psycopg2 IntegrityError, or None if unavailable.

    `exc.diag.constraint_name` is populated by the server for constraint
    violations, but `diag` itself can be absent on a synthesised/wrapped
    exception (notably in tests that raise UniqueViolation directly), so
    this degrades to None rather than raising a second error while handling
    the first.
    """
    diag = getattr(exc, "diag", None)
    return getattr(diag, "constraint_name", None) if diag is not None else None


def _update_existing_listing(
    cur,
    canonical: CanonicalListingVersion,
    listing_id: int,
    property_id: int,
    prev_price,
    prev_status: str,
) -> None:
    """Update an existing listing/property in place; append history on real changes.

    Every column update preserves the old value when the new fetch doesn't
    supply one, rather than blindly overwriting — most via plain
    COALESCE(new, old), `features` via a CASE WHEN (COALESCE doesn't
    distinguish "no features published" from "an empty array", so an empty
    tuple needs its own explicit "did this fetch even try" flag rather than
    relying on NULL-ness). Two reasons this matters, not just for
    `property`: (1) once Phase 2's dedup engine (#16) reassigns a listing's
    property_id onto a property shared with another listing, every re-visit
    of *either* listing must not erase what the other contributed just
    because this particular fetch happened not to surface a field; (2) even
    before dedup, a single listing's own detail page can temporarily fail to
    render a field (rate limiting, a partial page load) — a None from
    `normalize()` should never be trusted as "this field is now empty", only
    as "we don't know this time". `status`/`current_price` still update
    normally on a real change because a real change is a non-None value,
    which COALESCE always prefers over the old one.

    `last_fetched_at` (issue #143) is set unconditionally to NOW() here,
    unlike `last_seen_at` — this function only ever runs after a REAL
    fetch_detail()+normalize() succeeded, so "last fetched" and "this
    call happened" are the same moment by construction. It is the
    staleness signal skip-if-seen actually gates on; `last_seen_at` means
    something weaker now ("last confirmed present in a discover() sweep",
    see `etl.orchestrator._update_last_seen_for_discovered`) and is
    updated even when this function is never called for a given run.
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
               energy_rating = COALESCE(%s, energy_rating),
               city = COALESCE(%s, city), province = COALESCE(%s, province),
               postal_code = COALESCE(%s, postal_code), m2_plot = COALESCE(%s, m2_plot),
               cadastral_ref = COALESCE(%s, cadastral_ref),
               features = CASE WHEN %s THEN %s ELSE features END
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
            canonical.city,
            canonical.province,
            canonical.postal_code,
            canonical.m2_plot,
            canonical.cadastral_ref,
            bool(canonical.features),
            list(canonical.features),
            property_id,
        ),
    )
    cur.execute(
        """
        UPDATE listing
           SET url = COALESCE(%s, url), listing_kind = COALESCE(%s, listing_kind),
               status = COALESCE(%s, status), last_seen_at = NOW(),
               last_fetched_at = NOW(),
               current_price = COALESCE(%s, current_price),
               description = COALESCE(%s, description),
               photo_urls = %s, contact_raw = COALESCE(%s, contact_raw),
               reference_code = COALESCE(%s, reference_code),
               raw_extra = %s, missed_discovery_count = 0,
               operation = COALESCE(%s, operation)
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
            canonical.reference_code,
            _to_jsonb_param(canonical.raw_extra),
            canonical.operation,
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
                     rooms, bathrooms, floor, has_elevator, year_built, energy_rating,
                     city, province, postal_code, m2_plot, features, cadastral_ref)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s)
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
                    canonical.city,
                    canonical.province,
                    canonical.postal_code,
                    canonical.m2_plot,
                    list(canonical.features),
                    canonical.cadastral_ref,
                ),
            )
            property_id = cur.fetchone()[0]

            cur.execute(
                """
                INSERT INTO listing
                    (property_id, source, external_id, url, listing_kind, status,
                     first_seen_at, last_seen_at, last_fetched_at, current_price,
                     description, photo_urls, contact_raw, reference_code,
                     raw_extra, operation)
                VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW(), NOW(), %s, %s, %s, %s,
                        %s, %s, COALESCE(%s, 'sale'))
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
                    canonical.reference_code,
                    _to_jsonb_param(canonical.raw_extra),
                    canonical.operation,
                ),
            )
            listing_id = cur.fetchone()[0]
        except UniqueViolation as exc:
            # Only the listing-level (source, external_id) collision is
            # recoverable here — that's a concurrent run having won the race
            # to insert the same listing, and the fix is to update its row
            # instead. Any *other* unique violation (a property-level
            # constraint, say) is a different failure whose recovery path
            # this is not: the re-fetch below looks the listing up by
            # (source, external_id), finds nothing, and dies on tuple-unpack
            # with a TypeError that hides the real constraint name. Narrowed
            # by constraint name so unrelated violations propagate honestly
            # (issue #140).
            if _constraint_name(exc) != _LISTING_SOURCE_EXTERNAL_ID_CONSTRAINT:
                raise
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

    A listing missing from one sweep isn't necessarily gone (pagination
    noise, falling off page 1 as newer listings push it down, a transient
    site hiccup) — see issue #12 EC-5 and _WITHDRAWAL_THRESHOLD's docstring.

    **Called once per connector per run, against the union of every
    scope's discovered ids — never per scope.** This query sweeps every
    active row for `source`, with no scope predicate, because a listing's
    row carries no record of which scope discovered it. So passing one
    scope's ids here marks every listing belonging to *other* scopes as
    missed. With `_WITHDRAWAL_THRESHOLD = 3` and >=4 enabled scopes,
    that withdraws live inventory within a single run — a Madrid listing
    is legitimately absent from the Sevilla, Barcelona and Valencia
    sweeps, and three misses is all it takes.

    That bug was latent while every connector set
    `discovers_full_inventory = False` (reconciliation never ran at all).
    Vivantial (#120) is the first connector to claim `True`, which is what
    made it reachable — caught in review before it shipped.

    The caller must also skip reconciliation entirely when any scope
    failed: a partial union is indistinguishable from genuine absence, so
    a failed Sevilla sweep would withdraw Sevilla's live listings.
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


def _finish_connector_run(
    conn, run_id: int, ok: int, failed: int, skipped: int = 0
) -> None:
    status = "success" if failed == 0 else ("partial" if ok > 0 else "failed")
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE connector_runs
               SET finished_at = NOW(), status = %s, connectors_ok = %s,
                   connectors_failed = %s, connectors_skipped = %s,
                   total_connectors = %s,
                   duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
             WHERE id = %s
            """,
            (status, ok, failed, skipped, ok + failed + skipped, run_id),
        )
    conn.commit()


def _create_dedup_run(conn, trigger: str, connector_run_id: int | None) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO dedup_runs (trigger, connector_run_id, status) "
            "VALUES (%s, %s, 'running') RETURNING id",
            (trigger, connector_run_id),
        )
        run_id: int = cur.fetchone()[0]
    conn.commit()
    return run_id


def _finish_dedup_run(
    conn,
    run_id: int,
    *,
    status: str,
    pairs_compared: int | None = None,
    merged: int | None = None,
    suggested: int | None = None,
    conflicts: int | None = None,
    error_msg: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dedup_runs
               SET finished_at = NOW(), status = %s, pairs_compared = %s,
                   merged = %s, suggested = %s, conflicts = %s, error_msg = %s,
                   duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
             WHERE id = %s
            """,
            (status, pairs_compared, merged, suggested, conflicts, error_msg, run_id),
        )
    conn.commit()


def run_dedup(
    conn,
    trigger: str = "scheduler",
    connector_run_id: int | None = None,
    *,
    dedup_max_runtime_seconds: int = _DEFAULT_DEDUP_MAX_RUNTIME_SECONDS,
) -> dedup_engine.DedupRunResult | None:
    """Run the dedup engine once, recording a `dedup_runs` row (issue #185).

    Returns the `DedupRunResult`, or **None** when this call was skipped
    because another dedup pass already holds the single-runner advisory lock
    (D-036) — see below. Callers that print a result (`ps dedup run`) must
    handle the None case.

    Run health / orphan reconciliation (D-036). Two guards wrap the engine:

    1. **Orphan reconciliation** — before anything else, any `dedup_runs` row
       stuck at status='running' past `dedup_max_runtime_seconds` (a crashed
       or killed prior process that never wrote its finishing UPDATE) is marked
       'failed' with an explanatory `error_msg`, via
       `_reconcile_orphaned_dedup_runs`. This is the core fix for the live
       incident where three rows were orphaned (9h/10h/19h) with nothing to
       clean them. Runs on every pass (and at ETL startup, from main.py) so a
       stuck row never lingers.

    2. **Single-runner guard** — a dedup pass against the shared listing corpus
       is expensive (~84 min) and two overlapping passes waste that cost and
       can double-write merges. Before creating its run row this acquires the
       session-scoped DEDUP advisory lock; if another process holds it (the
       scheduler pass vs. a manual `ps dedup run`, the exact overlap that left
       three concurrent 'running' rows live), this call logs the reason and
       returns None rather than piling a second pass on top. The lock
       auto-frees if this process is killed, so it never wedges future runs.

    This is the sole caller-visible entry point orchestrator.py and
    etl.dedup.cli both go through — previously `ps dedup run` called
    `etl.dedup.engine.run()` directly and nothing recorded that a dedup
    pass happened at all, so a silent no-op (nothing to compare) was
    indistinguishable from "dedup never ran" (which is exactly how issue
    #185 went unnoticed: property_merge_log and suggested_merge were both
    empty across the connectors' entire live history).

    Safe to call against a partial ingestion sweep (circuit breaker open,
    some scopes failed): the engine only ever *merges* or *suggests* based
    on pairs of listings that already exist in the DB — it never withdraws
    or otherwise treats a listing's absence as evidence of anything. An
    incomplete candidate set just means fewer pairs to compare this run;
    the next run (once the sweep completes) compares whatever's left. This
    is the same reasoning `_reconcile_missed_discoveries` already applies
    to withdrawal, applied here to justify why dedup does NOT need the
    same `reconcilable_union` gating that withdrawal does.

    Exceptions from `engine.run()` are caught, recorded as a 'failed' row
    (with `error_msg`), and then re-raised — this function itself doesn't
    decide whether a dedup failure should sink the caller's run. Callers
    that must stay resilient (`run_all_connectors`, same posture as
    `notify_materialize_all`) catch around this call so a dedup bug can't
    turn an otherwise-successful, already-committed connector sweep into a
    failed run; `ps dedup run` (etl.dedup.cli), by contrast, wants the
    exception to propagate so a manual invocation reports failure clearly.
    Any merges/suggestions `engine.run()` already committed before the
    exception stay committed (each pair commits independently).
    """
    # Guard 1: reconcile dead orphans first, so a stuck row is cleaned up even
    # on a pass that then skips on the lock below (D-036).
    _reconcile_orphaned_dedup_runs(conn, dedup_max_runtime_seconds)

    # Guard 2: single-runner. Fail closed (skip) if another dedup pass holds
    # the lock — never overlap a second ~84-min pass against the same corpus.
    if not postgres.try_acquire_run_lock(conn, postgres.DEDUP_ADVISORY_LOCK_ID):
        logger.warning(
            "Dedup run skipped: another dedup pass already holds the "
            "single-runner advisory lock (D-036). Not starting an overlapping "
            "pass against the same corpus (trigger=%s); the in-flight run will "
            "complete on its own.",
            trigger,
        )
        return None
    try:
        run_id = _create_dedup_run(conn, trigger, connector_run_id)
        try:
            result = dedup_engine.run(conn)
        except Exception as exc:
            logger.exception("Dedup run %s failed", run_id)
            _finish_dedup_run(conn, run_id, status="failed", error_msg=str(exc))
            raise
        _finish_dedup_run(
            conn,
            run_id,
            status="success",
            pairs_compared=result.pairs_compared,
            merged=result.merged,
            suggested=result.suggested,
            conflicts=result.conflicts,
        )
        logger.info(
            "Dedup run %s: compared=%d merged=%d suggested=%d conflicts=%d",
            run_id,
            result.pairs_compared,
            result.merged,
            result.suggested,
            result.conflicts,
        )
        return result
    finally:
        postgres.release_run_lock(conn, postgres.DEDUP_ADVISORY_LOCK_ID)


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
    skipped_count: int = 0,
    skipped_scopes: list[dict[str, str]] | None = None,
) -> None:
    """`skipped_count` (issue #143) is listings this connector's run left
    unfetched under the skip-if-seen policy — "known, still there per
    discover(), deliberately not re-fetched" — distinct from
    `connector_runs.connectors_skipped` (issue #99), which counts whole
    *connectors* skipped via `connector_config.enabled = false`. The two
    are skip in different senses at different granularities; see each
    column's comment in etl/schema/init.sql.

    `skipped_scopes` (issue #217) is a THIRD, again-different sense of
    "skipped": whole *geographies* this connector never looked at this run,
    each tagged with why — `budget` (covered, but the shared circuit
    breaker was already open before its turn came) or `uncovered` (this
    connector resolves no target for it at all, issue #177's case). Stored
    as JSONB so the distinction survives without anyone string-matching
    `error_msg`. `None`/empty is stored as SQL NULL rather than `[]` — "no
    scope was skipped" and "an empty list was computed" are the same fact,
    and NULL keeps `WHERE skipped_scopes IS NOT NULL` a usable filter.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_run_results
                (run_id, connector_name, started_at, finished_at, status,
                 discovered_count, fetched_count, error_count, error_msg,
                 skipped_count, skipped_scopes)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                skipped_count,
                json.dumps(skipped_scopes) if skipped_scopes else None,
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


def _reconcile_orphaned_dedup_runs(
    conn, max_runtime_seconds: int = _DEFAULT_DEDUP_MAX_RUNTIME_SECONDS
) -> int:
    """Mark dead `dedup_runs` rows stuck at status='running' as failed (D-036).

    A dedup pass whose process is killed mid-run (SIGKILL, container restart,
    OOM, host reboot) never gets its finishing UPDATE, so its row stays at
    status='running' with finished_at=NULL *forever* — nothing else would ever
    transition it. On the live instance three such rows accumulated (9h, 10h,
    19h old) with no mechanism to detect or clean them, and a permanently
    'running' row is indistinguishable from "still in progress" to `ps dedup
    status` or any monitor.

    Unlike `_reconcile_stale_runs` (which blindly fails *every* running
    connector_runs row on the assumption a new run means the old one is dead),
    this is **age-based**: only rows whose `started_at` is older than
    *max_runtime_seconds* are reconciled. A dedup pass can legitimately be
    triggered from two independent processes — the scheduler (via
    `run_all_connectors`) and a manual `ps dedup run` — so at reconcile time a
    genuinely-active concurrent run may exist; the age threshold is what keeps
    this from failing a run that is still doing real work. The advisory-lock
    single-runner guard in `run_dedup` is the complementary mechanism that
    stops two live runs overlapping in the first place; together they mean a
    run that *does* legitimately exceed the threshold is protected (a
    concurrent attempt can't start to trigger this reconcile against it —
    it skips on the lock), while a truly dead orphan is always cleaned up.

    Idempotent — re-applied at every ETL startup and at the start of every
    dedup pass; a second pass over already-reconciled rows updates nothing.
    Returns the number of rows reconciled.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE dedup_runs
               SET status = 'failed',
                   finished_at = NOW(),
                   duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER,
                   error_msg = COALESCE(
                       error_msg,
                       'orphaned: still ''running'' after ' || %s ||
                       's (max dedup runtime) with no active run — reconciled '
                       'as failed on startup/next-run (D-036)'
                   )
             WHERE status = 'running'
               AND started_at < NOW() - make_interval(secs => %s)
            """,
            (max_runtime_seconds, max_runtime_seconds),
        )
        reconciled = cur.rowcount
    conn.commit()
    if reconciled:
        logger.warning(
            "Reconciled %d orphaned dedup_runs row(s) stuck at status='running' "
            "past the %ds max-runtime (likely a crashed/killed prior process) — "
            "marked 'failed' with an explanatory error_msg (D-036)",
            reconciled,
            max_runtime_seconds,
        )
    return reconciled


def sync_connector_registry(conn) -> None:
    """Mirror the in-process CONNECTORS registry into `connector_registry`.

    Issue #100: the connector-management UI has to list every connector
    that *exists* — including ones with no `connector_config` row and no
    run history yet — but the registry lives here in Python while the
    dashboard is TypeScript in a separate container. Rather than duplicate
    the connector list in TypeScript (two sources of truth, guaranteed to
    drift the first time someone adds a connector without remembering to
    update the mirror), the ETL publishes its own registry to a table the
    dashboard reads. Adding a connector in Python makes it appear in the
    UI with no TypeScript change at all. See `connector_registry`'s comment
    block in etl/schema/init.sql for the alternatives considered.

    Called from etl/main.py at startup, after register_all(). Idempotent.

    Rows are never deleted here: a connector removed from the Python
    registry is marked `registered = false` instead, so its historical
    `connector_run_results` rows still resolve to a name in the UI rather
    than rendering as an orphan. Any row not currently registered gets
    flipped to false in the same pass, which is what makes a *rename*
    (old name retired, new name added) show up correctly rather than
    leaving two rows both claiming to be live.

    Also seeds a `connector_config` row with `enabled = false` for any
    connector that doesn't have one yet (issue #100 review). A newly
    discovered connector must be born DISABLED: the owner's requirement is
    "todos desactivados hasta que defina los filtros de búsqueda — no
    quiero que se cargue tooodo el sitio", and without this the very first
    startup that publishes a connector to the UI is also the run that
    downloads an entire city, because `_scopes_for_connector` treats a
    missing row as enabled (issue #71's original default). `ON CONFLICT DO
    NOTHING` means an operator's existing choice — enabled or disabled — is
    never overwritten on a later restart; only genuinely new connectors get
    the disabled seed.

    Ordering matters and is enforced by the caller: etl/main.py must not
    attempt a sweep if this function raised, or connectors whose rows were
    never created would fall through to the enabled-by-default path and
    ingest anyway. See the `registry_synced` guard there.
    """
    with conn.cursor() as cur:
        for connector in CONNECTORS:
            cur.execute(
                """
                INSERT INTO connector_registry (
                    connector_name, registered, rate_limit_per_minute,
                    discovers_full_inventory, supports_discovery,
                    supported_filters, updated_at
                )
                VALUES (%s, true, %s, %s, %s, %s::jsonb, NOW())
                ON CONFLICT (connector_name) DO UPDATE SET
                    registered = true,
                    rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
                    discovers_full_inventory = EXCLUDED.discovers_full_inventory,
                    supports_discovery = EXCLUDED.supports_discovery,
                    supported_filters = EXCLUDED.supported_filters,
                    updated_at = NOW()
                """,
                (
                    connector.name,
                    connector.rate_limit_per_minute,
                    connector.discovers_full_inventory,
                    connector.supports_discovery,
                    json.dumps(list(connector.supported_filters)),
                ),
            )
            cur.execute(
                """
                INSERT INTO connector_config (connector_name, enabled)
                VALUES (%s, false)
                ON CONFLICT (connector_name) DO NOTHING
                """,
                (connector.name,),
            )

        known = [c.name for c in CONNECTORS]
        if known:
            cur.execute(
                "UPDATE connector_registry SET registered = false, updated_at = NOW() "
                "WHERE registered = true AND connector_name <> ALL(%s)",
                (known,),
            )
        else:
            # No connectors registered at all (a supported state — see
            # etl/main.py). Everything previously known is now unregistered.
            cur.execute(
                "UPDATE connector_registry SET registered = false, updated_at = NOW() "
                "WHERE registered = true"
            )
    conn.commit()
    logger.info(
        "connector_registry synced (%d registered: %s)",
        len(CONNECTORS),
        ", ".join(sorted(c.name for c in CONNECTORS)) or "(none)",
    )


def _warn_unrecognized_connector_config_names(conn) -> None:
    """Warn (once per run) about any connector_config row whose connector_name
    doesn't match a currently-registered connector.

    Issue #99 hardening: today this table is edited by hand or a script; the
    upcoming connector-management UI (#100) will let an operator type or pick
    a connector name directly. A typo there currently just silently does
    nothing — `_scopes_for_connector` looks up by exact name and gets no
    row, indistinguishable from "never configured". Surfacing this at
    run-start, rather than only at debugging time, is what makes a typo
    visible instead of a quiet no-op an operator has no way to notice.
    """
    known = {c.name for c in CONNECTORS}
    with conn.cursor() as cur:
        cur.execute("SELECT connector_name FROM connector_config")
        configured = [row[0] for row in cur.fetchall()]
    for name in configured:
        if name not in known:
            logger.warning(
                "connector_config has a row for %r, which doesn't match any "
                "registered connector (known: %s) — this row has no effect",
                name,
                ", ".join(sorted(known)) or "(none registered)",
            )


def _update_last_seen_for_discovered(
    conn, source: str, external_ids: list[str]
) -> None:
    """Mark every listing this scope's discover() just found as seen now.

    Issue #143: skip-if-seen means fetch_detail() no longer runs for every
    discovered id on every run, so `listing.last_seen_at` can no longer
    rely solely on `_update_existing_listing`'s write — that only fires
    for ids actually fetched this run. Without a separate update here, a
    listing correctly skipped as unchanged would look increasingly stale
    by `last_seen_at` even though discover() just re-confirmed it exists,
    making "skipped, still there" indistinguishable from "nobody has
    looked at this in weeks" (see the issue's acceptance criteria).

    A plain `WHERE external_id = ANY(...)` update scoped to this one
    scope's ids has none of `_reconcile_missed_discoveries`' cross-scope
    hazard — that function's bug (see its docstring) came from sweeping
    every active row for the *source* with no scope predicate at all; this
    only ever touches rows this exact scope just discovered, so calling it
    once per scope (rather than deferred to a run-level union) is safe.

    Runs unconditionally, including for `discovers_full_inventory=False`
    connectors like Fotocasa — presence tracking for display/staleness
    purposes is a different concern from withdrawal reconciliation, which
    stays gated on `discovers_full_inventory` exactly as before.
    """
    if not external_ids:
        return
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE listing SET last_seen_at = NOW() "
            "WHERE source = %s AND external_id = ANY(%s)",
            (source, external_ids),
        )
    conn.commit()


def _record_discovery_price_observations(
    conn, source: str, discovery_prices: dict[str, Decimal]
) -> int:
    """Append every discovery-time price to `listing_price_history` (issue #183).

    Fotocasa's `discovered_prices()` yields a verified, detail-accurate price
    for *every* discovered listing on *every* sweep, at zero extra request
    cost (it's read out of the same `__initial_props__` JSON blob `discover()`
    already fetches — see `etl.connectors.fotocasa`). Before this, that signal
    was used only as a boolean gate in `_should_skip_fetch` and then thrown
    away: a price change seen at discovery time was lost unless the listing
    also happened to win a slot in this run's fetch budget (circuit breaker /
    rate limit / `min_refetch_interval_seconds`). During Fotocasa's initial
    backfill the fetch front only advances ~40 ids/run, so a verified price for
    the whole ~1,358-listing inventory was sitting unused every sweep while
    price-drop detection (issue #34) stayed stale for days.

    This writes those prices straight to the price-history timeline,
    **decoupled entirely from the fetch budget** — a discovered listing the
    budget never reaches this run still gets its observation recorded.

    Dedup / idempotency mirrors the fetch-path write in
    `_update_existing_listing`: that path appends a row only when the newly
    fetched price differs from what's stored, and updates the stored anchor in
    the same transaction so the same price is never re-inserted on the next
    run. Here the anchor is the listing's **most recent recorded price**
    (the latest `listing_price_history` row), and a row is inserted only when
    the discovery price `IS DISTINCT FROM` it. That gives the same guarantees
    without touching `listing.current_price`:

    * Same run: a listing the fetch loop DID re-fetch (a discovery-time price
      delta forces exactly that, `_should_skip_fetch` reason #5) already had
      its authoritative fetched price appended by `_update_existing_listing`,
      so the discovery price equals the latest row and is deduped away — no
      double-insert of the same observation.
    * Across runs: once a discovery price is recorded it becomes the latest
      row, so re-seeing the same price on the next sweep is a no-op.

    `listing.current_price` is deliberately left **fetch-path-owned** (D-068):
    updating it from a discovery price would make `_should_skip_fetch`'s
    "discovery price disagrees with stored price -> force a re-fetch" trigger
    (its central price-change safety net) stop firing, since stored would then
    already equal the discovered value. `listing_price_history` is the only
    consumer of the discovery-time signal.

    Connector-agnostic by construction: drives off whatever
    `Connector.discovered_prices()` returns, which is `{}` for every connector
    that hasn't verified a discovery-time price field — so this is a cheap
    early-return no-op for all but Fotocasa today. Only listings that already
    have a `listing` row can get an observation (the FK requires it); a
    brand-new discovered id with no row yet gets its first price on its first
    real fetch, exactly as before. Commits its own transaction, like the other
    discovery-time helper `_update_last_seen_for_discovered`. Returns the
    number of observations written.
    """
    if not discovery_prices:
        return 0
    external_ids = list(discovery_prices.keys())
    prices = [discovery_prices[external_id] for external_id in external_ids]
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO listing_price_history (listing_id, observed_at, price)
            SELECT l.id, NOW(), incoming.price
              FROM unnest(%s::text[], %s::numeric[])
                       AS incoming(external_id, price)
              JOIN listing l
                ON l.source = %s AND l.external_id = incoming.external_id
             WHERE incoming.price IS DISTINCT FROM (
                       SELECT h.price
                         FROM listing_price_history h
                        WHERE h.listing_id = l.id
                        ORDER BY h.observed_at DESC, h.id DESC
                        LIMIT 1
                   )
            """,
            (external_ids, prices, source),
        )
        recorded = cur.rowcount
    conn.commit()
    return recorded


def _fetch_freshness_map(
    conn, source: str, external_ids: list[str]
) -> dict[str, tuple[datetime | None, Decimal | None, str | None]]:
    """Batched (last_fetched_at, current_price, status) lookup for skip-if-seen.

    One query per (connector, scope) rather than one per listing — issue
    #143 exists because per-listing framework overhead was already the
    problem being solved; an N+1 query here would just move the cost
    instead of removing it, and matters most for exactly the connectors
    (large bank-portal batches) this policy is meant to help.

    `status` (Opus review, PR #175 must-fix) closes the gap that let a
    `withdrawn` listing reappearing in `discover()` at an unchanged price
    go un-refetched: see `_should_skip_fetch`'s docstring for why a
    non-'active' stored status must always force a real fetch.
    """
    if not external_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT external_id, last_fetched_at, current_price, status FROM listing "
            "WHERE source = %s AND external_id = ANY(%s)",
            (source, external_ids),
        )
        return {row[0]: (row[1], row[2], row[3]) for row in cur.fetchall()}


def _should_skip_fetch(
    *,
    last_fetched_at: datetime | None,
    stored_price: Decimal | None,
    stored_status: str | None,
    discovery_price: Decimal | None,
    min_refetch_interval_seconds: int,
    now: datetime,
) -> tuple[bool, str]:
    """Skip-if-seen policy (issue #143): should fetch_detail() run for this
    already-known external_id, or is it safe to skip this run?

    Each check below is a reason to force a re-fetch regardless of how
    "fresh" the listing otherwise looks — staleness age is the last
    resort, not the primary signal, because the things skip-if-seen must
    never silently break (price-drop detection, #34; withdrawal
    detection, EC-5) are both driven by data this function can see:

    1. Never fetched before -> always fetch. A `listing` row can exist
       without a real detail fetch ever having happened for it (the
       browser-extension capture path, issue #75, or a future backfill) —
       treating that the same as "recently fetched" would leave such a
       row permanently unpopulated the moment any connector enables a
       non-zero window.
    2. Stored status isn't 'active' (e.g. 'withdrawn') -> always fetch.
       Opus review, PR #175 must-fix: without this, a listing
       `_reconcile_missed_discoveries` marked withdrawn — because it was
       genuinely absent from several sweeps — that then *reappears* in
       `discover()` at an unchanged price was previously treated exactly
       like a normal active listing: skipped as "fresh, unchanged",
       leaving `status='withdrawn'` un-reverted (invisible to candidates/
       scoring, which filter withdrawn listings out),
       `missed_discovery_count` frozen (`_reconcile_missed_discoveries`
       only scans `WHERE status = 'active'`, so a withdrawn row can never
       have its own counter reset back down), and `last_seen_at` freshly
       bumped by `_update_last_seen_for_discovered` regardless — every
       staleness signal reports the row as healthy while the one field
       that actually says "we think this is gone" never changes. It only
       self-corrected once the staleness window itself expired (up to
       24h for Fotocasa) — before this policy, a reappearing listing was
       re-fetched on the very next sweep. Checked before the "disabled"
       and "missing price" branches below so this reason always wins the
       moment status disagrees, independent of whether skip-if-seen is
       even turned on for this connector.
    3. `min_refetch_interval_seconds <= 0` -> always fetch. The feature is
       off for this connector (the default for every connector unless it
       opts in — see `Connector.min_refetch_interval_seconds`); this is
       what keeps every existing connector's behaviour byte-identical to
       before issue #143 unless someone deliberately turns it on.
    4. Stored `current_price` is NULL -> always fetch. A core field never
       having been captured is worth paying to backfill rather than
       leaving silently empty forever behind a staleness window.
    5. Discovery-time price disagrees with the stored price -> always
       fetch, however recently it was last fetched. This is the guard
       against issue #143's central risk: a connector that supplies a
       discovery-time price (`Connector.discovered_prices`) gets a real
       price change detected on the very next sweep, not after the
       staleness window happens to expire.
    6. Otherwise, skip only once `min_refetch_interval_seconds` has
       genuinely elapsed since the last real fetch.

    Returns `(skip, reason)` — `reason` is always populated, including
    when `skip=False`, so the caller can log *why* a fetch happened, not
    only why one didn't (the issue's "record what it skipped and why"
    requirement applies just as much to "and why NOT" for an operator
    trying to understand a run).
    """
    if last_fetched_at is None:
        return False, "never fetched before"
    if stored_status is not None and stored_status != "active":
        return (
            False,
            (
                f"stored status is {stored_status!r} (not 'active') — forcing "
                "a re-fetch so a reappearing listing can be reconciled back "
                "to 'active' promptly rather than waiting out the staleness "
                "window"
            ),
        )
    if min_refetch_interval_seconds <= 0:
        return (
            False,
            (
                "skip-if-seen disabled for this connector "
                "(min_refetch_interval_seconds <= 0)"
            ),
        )
    if stored_price is None:
        return False, "stored current_price is missing — backfilling"
    if discovery_price is not None and discovery_price != stored_price:
        return (
            False,
            (
                f"discovery-time price {discovery_price} differs from stored "
                f"price {stored_price} — forcing a re-fetch regardless of staleness"
            ),
        )
    age_seconds = (now - last_fetched_at).total_seconds()
    if age_seconds >= min_refetch_interval_seconds:
        return (
            False,
            (
                f"stale: last fetched {age_seconds:.0f}s ago "
                f"(>= {min_refetch_interval_seconds}s window)"
            ),
        )
    return (
        True,
        (
            f"fetched {age_seconds:.0f}s ago (< {min_refetch_interval_seconds}s "
            f"window), current_price present, no discovery-time price delta"
        ),
    )


def run_connector(
    conn,
    connector: Connector,
    scope: ConnectorScope,
    limiter: RateLimiter,
    breaker: CircuitBreaker,
    *,
    min_refetch_interval_seconds: int = 0,
) -> dict:
    """Run one connector's discover -> fetch_detail -> normalize -> store cycle
    for a single scope, against a `limiter`/`breaker` shared across every
    scope this connector processes in the current orchestrator run.

    Issue #71 hardening: `limiter`/`breaker` used to be constructed fresh
    per call (i.e. per scope), which meant a circuit trip during one
    profile-geography's pass did nothing to protect the next one in the
    same run — with N active profile-geographies, a misbehaving/blocking
    site got N times the error budget it's supposed to have, and each new
    scope's first request skipped the rate limiter's minimum-interval wait
    (a fresh limiter starts with no last-call timestamp). Callers now own
    constructing these once per connector per run and passing them in, so
    state — and therefore the breaker's protection and the limiter's
    pacing — actually carries across scopes.

    Returns a summary dict; never raises for per-listing failures (those
    count toward the circuit breaker and get logged) — only raises if
    discover() itself fails, since without a target list there's nothing
    to run.
    """
    limiter.acquire()
    external_ids = connector.discover(scope, throttle=limiter.acquire)

    # Issue #143: presence tracking is unconditional — unlike withdrawal
    # reconciliation below, it doesn't need full-inventory coverage to be
    # safe (see _update_last_seen_for_discovered's docstring), and skip-
    # if-seen means a listing can go a whole run without ever reaching
    # _upsert_canonical_listing, which is the only other place
    # last_seen_at gets written.
    _update_last_seen_for_discovered(conn, connector.name, external_ids)

    # Issue #143: whatever discovery-time price signal this connector can
    # cheaply supply from the request(s) discover() just made — {} for a
    # connector that hasn't verified one (the default; see
    # Connector.discovered_prices). Never allowed to take down the run: a
    # bug in an override degrades to "no price signal" rather than
    # aborting a scope that already has real ids to process.
    try:
        discovery_prices = connector.discovered_prices()
    except Exception:
        logger.warning(
            "Connector %s: discovered_prices() raised — proceeding with no "
            "discovery-time price signal for this scope",
            connector.name,
            exc_info=True,
        )
        discovery_prices = {}

    # Issue #99 hardening: a scope carrying a narrowing filter (e.g.
    # `rooms`) means discover()'s absence of a listing can mean "doesn't
    # match this run's filter" just as easily as "genuinely gone" — the
    # same false-positive-withdrawal risk `discovers_full_inventory=False`
    # already exists to prevent, but triggered by filtering rather than
    # partial site coverage. A connector can genuinely enumerate its whole
    # unfiltered inventory (discovers_full_inventory=True) and still not be
    # a safe reconciliation source the moment a filter narrows what this
    # particular scope's discover() call actually returns.
    scope_is_filtered = scope.rooms is not None
    # Whether THIS scope's discovered ids may contribute to the run-level
    # withdrawal reconciliation the caller performs after every scope has
    # run. Reconciliation itself deliberately does NOT happen here — see
    # `_reconcile_missed_discoveries`' docstring for why per-scope
    # reconciliation is unsafe for a full-inventory connector.
    reconcilable = connector.discovers_full_inventory and not scope_is_filtered
    if scope_is_filtered and connector.discovers_full_inventory:
        # Issue #99 hardening, unchanged in intent: a filtered scope's
        # absences mean "doesn't match this filter" as easily as "gone".
        logger.info(
            "Connector %s: scope=%r carries a narrowing filter — excluding "
            "it from withdrawal reconciliation even though the connector "
            "otherwise discovers full inventory",
            connector.name,
            scope,
        )
    if reconcilable and not external_ids:
        # An empty discover() result is never trusted enough to feed
        # reconciliation — a well-behaved connector should already raise
        # ConnectorError on a soft-block/interruption page rather than
        # return an empty list (see fotocasa.py's _INITIAL_PROPS_MARKER
        # check), but this is a second line of defense: even a connector
        # bug that returns [] instead of raising must not be able to
        # mass-withdraw a source's entire inventory.
        reconcilable = False
        logger.warning(
            "Connector %s: discover() returned zero external_ids for "
            "scope=%r — excluding it from withdrawal reconciliation this "
            "run (see run_connector docstring)",
            connector.name,
            scope,
        )

    fetched = 0
    skipped = 0
    errors = 0
    # Issue #270 (D-047): soft-block (site rate-throttling) fetch failures,
    # tracked separately from `errors` (which stays the count of ALL failed
    # fetches, genuine or soft-block, for error_count/#291) so the caller can
    # tell a "waited for budget" backoff from a genuine-failure burst.
    soft_block_errors = 0
    # Issue #291: listings a discover() sweep surfaced but whose detail
    # fetch returned HTTP 404/410 — removed/withdrawn at the source between
    # discovery and fetch. Tracked separately from `errors` (and from D-047's
    # soft_block_errors) so this expected inventory churn stops inflating
    # `connector_run_results.error_count`.
    gone = 0
    # Issue #291 instrumentation: a breakdown of the per-listing errors that
    # DID count (fatal or soft-block, but not the reclassified "gone" ones)
    # by exception type, logged once per scope. The run result stores only an
    # aggregate count, so before this the only way to see WHAT the recurring
    # handful of errors were was to grep individual WARNING lines; this makes
    # the pattern skimmable (e.g. "SoftBlockError=5, ConnectorError=2")
    # without a schema change.
    error_kinds: Counter[str] = Counter()
    circuit_open = False
    # Which category tripped the breaker for this scope, if it did: 'fatal'
    # (genuine failures — worth surfacing) or 'soft' (rate-throttle — a clean
    # budget stop). None while the breaker stays closed.
    circuit_open_by: str | None = None

    # Issue #143: one batched lookup for the whole scope rather than one
    # query per listing — skipped entirely when the feature is off for this
    # connector (the common case today), so a connector that hasn't opted
    # into skip-if-seen doesn't pay even one extra query for THIS lookup.
    # Narrow claim, deliberately: `_update_last_seen_for_discovered` above
    # is a separate UPDATE + COMMIT that runs unconditionally for every
    # connector and scope regardless of min_refetch_interval_seconds (see
    # its own docstring for why) — Opus review, PR #175: don't read this
    # comment as "skip-if-seen has no cost for non-opted-in connectors"
    # overall, only that this specific freshness lookup is free for them.
    freshness = (
        _fetch_freshness_map(conn, connector.name, external_ids)
        if min_refetch_interval_seconds > 0
        else {}
    )

    for external_id in external_ids:
        if breaker.tripped:
            circuit_open = True
            circuit_open_by = breaker.tripped_by
            # Issue #270 (D-047): a soft-block-driven trip is the site
            # rate-throttling us — a clean "budget spent for this run" stop,
            # logged as a warning; a fatal-driven trip is a genuine failure
            # burst worth an error-level alarm.
            log = logger.warning if circuit_open_by == "soft" else logger.error
            log(
                "Connector %s: circuit breaker open (%s) after %d/%d errors "
                "(%d soft-block) — aborting remaining %d of %d discovered listings",
                connector.name,
                circuit_open_by,
                breaker.errors,
                breaker.attempts,
                breaker.soft_block_errors,
                len(external_ids) - fetched - errors - skipped - gone,
                len(external_ids),
            )
            break

        last_fetched_at, stored_price, stored_status = freshness.get(
            external_id, (None, None, None)
        )
        skip, reason = _should_skip_fetch(
            last_fetched_at=last_fetched_at,
            stored_price=stored_price,
            stored_status=stored_status,
            discovery_price=discovery_prices.get(external_id),
            min_refetch_interval_seconds=min_refetch_interval_seconds,
            now=datetime.now(timezone.utc),
        )
        if skip:
            skipped += 1
            logger.info(
                "Connector %s: skipping fetch_detail for external_id=%s — %s",
                connector.name,
                external_id,
                reason,
            )
            continue

        # No limiter.acquire() here: `throttle` IS the pacing mechanism, and
        # every connector calls it as fetch_detail's first action. Acquiring
        # again at the call site made each listing wait two full intervals —
        # at Fotocasa's 3/min that is 40s per listing rather than 20s, which
        # silently doubled the projected sweep cost in issue #143 (~16h vs
        # ~8h for ~1,500 ids). The parameter, not the call site, is the right
        # place for this: connectors that make several requests per listing
        # need to pace each one, which only they can do (issue #99).
        try:
            raw = connector.fetch_detail(external_id, throttle=limiter.acquire)
            canonical = connector.normalize(raw)
            _upsert_canonical_listing(conn, canonical)
        except ListingUnavailableError as exc:
            # Issue #291: the source says this listing is gone (HTTP 404/410)
            # — it was removed/withdrawn between the discover() sweep that
            # surfaced its id and this detail fetch. That is expected churn
            # on a live classifieds site, not a run error an operator should
            # chase, so it is NOT counted toward `errors` (this is what lets
            # a normal fotocasa/milanuncios scope report error_count=0
            # instead of the persistent 7-10 the issue reports). It IS still
            # recorded as a breaker error, deliberately: if the detail-URL
            # shape breaks, EVERY fetch 404s, and that total break must still
            # trip the shared breaker rather than silently fetching nothing
            # and reporting a clean run (the `_GONE_ALARM_RATIO` check after
            # the loop is the specific diagnosis a bare circuit_open can't
            # give). A removed listing is NOT a soft-block (D-047): it records
            # a FATAL breaker error (soft_block=False), so a wholesale 404
            # break trips the tight fatal threshold, not the looser soft-block
            # one. Deliberately does NOT mark the listing withdrawn: a single
            # 404 is not the `_WITHDRAWAL_THRESHOLD`-miss evidence withdrawal
            # requires, and trusting one here would reintroduce exactly the
            # mass-withdrawal hazard `_reconcile_missed_discoveries` guards
            # against if the URL shape ever broke.
            conn.rollback()
            gone += 1
            breaker.record_error(soft_block=False)
            logger.info(
                "Connector %s: external_id=%s no longer available at source "
                "(%s) — clean skip, not counted as a run error",
                connector.name,
                external_id,
                exc,
            )
            continue
        except Exception as exc:  # noqa: BLE001 — any failure (fetch, normalize, or persist) counts toward the breaker
            conn.rollback()  # reset connection state in case the failure was a DB error mid-transaction
            errors += 1
            # Issue #291 instrumentation: tally by exception type (includes
            # SoftBlockError, which still counts in `errors` per D-047) so the
            # per-scope breakdown below shows WHAT the counted errors were.
            error_kinds[type(exc).__name__] += 1
            # Issue #270 (D-047): a soft-block is the site rate-throttling us,
            # not a broken connector. It STILL counts as a failed fetch in
            # `errors`/error_count (reducing those is issue #291's job), but is
            # recorded against the breaker's looser soft-block threshold so a
            # transient throttle burst doesn't trip it like a genuine failure
            # burst would.
            soft_block = isinstance(exc, SoftBlockError)
            if soft_block:
                soft_block_errors += 1
            breaker.record_error(soft_block=soft_block)
            logger.warning(
                "Connector %s: %s on external_id=%s: %s",
                connector.name,
                "soft-blocked" if soft_block else "failed",
                external_id,
                exc,
            )
            continue

        fetched += 1
        breaker.record_success()

    # Issue #183: persist every discovery-time price observation straight to
    # listing_price_history, decoupled from the fetch budget. Runs AFTER the
    # fetch loop on purpose: a listing the loop re-fetched has already had its
    # authoritative price appended by _update_existing_listing, so deduping
    # against the latest recorded price (see the helper) collapses the
    # discovery observation into that row rather than double-inserting it,
    # while a listing the budget never reached this run still gets its
    # verified discovery-time price recorded. No-op ({} early return) for every
    # connector that hasn't verified a discovery-time price field.
    discovery_price_observations = _record_discovery_price_observations(
        conn, connector.name, discovery_prices
    )
    if discovery_price_observations:
        logger.info(
            "Connector %s: recorded %d discovery-time price observation(s) to "
            "listing_price_history this scope (decoupled from the fetch budget)",
            connector.name,
            discovery_price_observations,
        )

    if skipped:
        # Opus review, PR #175: the per-listing INFO line above is up to
        # one line per discovered id (1,358 for a full Fotocasa sweep) —
        # not something an operator actually reads line-by-line. This
        # per-scope aggregate is the number that's actually skimmable in
        # a log stream; the per-listing lines stay for when someone needs
        # to grep a specific external_id's reason.
        logger.info(
            "Connector %s: skip-if-seen skipped %d/%d discovered listings "
            "this scope (fetched %d, errors %d)",
            connector.name,
            skipped,
            len(external_ids),
            fetched,
            errors,
        )

    if gone:
        # Issue #291: expected inventory churn — logged at INFO (not an
        # error) so a run reports it without treating removed listings as
        # failures. The aggregate here is the skimmable counterpart to the
        # per-listing INFO lines above.
        logger.info(
            "Connector %s: %d/%d discovered listings were gone at the source "
            "(HTTP 404/410) this scope — removed between discovery and fetch, "
            "counted as clean skips, not errors",
            connector.name,
            gone,
            len(external_ids),
        )

    if errors:
        # Issue #291 instrumentation: surface WHAT the counted per-listing
        # errors were (by exception type), so a recurring pattern is visible
        # at a glance in the log stream rather than only reconstructable from
        # individual WARNING lines. These exclude the "gone" reclassification
        # above but INCLUDE soft-blocks (which still count in `errors` per
        # D-047) — the SoftBlockError-vs-other split in the breakdown is
        # exactly what tells a transient throttle apart from a real bug.
        logger.warning(
            "Connector %s: %d counted per-listing error(s) this scope "
            "(%d soft-block), by type: %s",
            connector.name,
            errors,
            soft_block_errors,
            ", ".join(f"{kind}={n}" for kind, n in sorted(error_kinds.items())),
        )

    # Issue #291: a handful of "gone" listings is normal churn; a large
    # fraction of every fetch coming back gone is the detail path having
    # broken (every real listing 404s), which the bare fetched/errors counts
    # would otherwise hide. Alarm on the fraction of ATTEMPTED fetches, not
    # of discovered ids (most discovered ids can be skip-if-seen skips).
    attempted = fetched + errors + gone
    if attempted >= _GONE_ALARM_MIN_ATTEMPTS and gone > attempted * _GONE_ALARM_RATIO:
        logger.error(
            "Connector %s: %d/%d ATTEMPTED fetches returned HTTP 404/410 "
            "(gone) this scope — far above the churn a live site produces "
            "between discovery and fetch. This is the signature of the "
            "detail-URL shape (or the whole detail path) having broken so "
            "every real listing 404s, not normal removals; the shared "
            "circuit breaker should also be tripping. Check fetch_detail's "
            "URL construction against the live site.",
            connector.name,
            gone,
            attempted,
        )

    return {
        "discovered_count": len(external_ids),
        "fetched_count": fetched,
        "skipped_count": skipped,
        "error_count": errors,
        "soft_block_error_count": soft_block_errors,
        "gone_count": gone,
        # Issue #183: discovery-time price observations written to
        # listing_price_history this scope, independent of the fetch budget.
        "discovery_price_observations": discovery_price_observations,
        "circuit_open": circuit_open,
        # 'fatal' | 'soft' | None — which category tripped the breaker this
        # scope (D-047). Drives whether the caller records the connector's
        # stop as a genuine problem or a clean budget backoff.
        "circuit_open_by": circuit_open_by,
        # Returned rather than acted on here: withdrawal reconciliation is
        # a per-connector-per-run decision the caller makes against the
        # union of every scope's ids. See _reconcile_missed_discoveries.
        "discovered_external_ids": set(external_ids),
        "reconcilable": reconcilable,
    }


def _active_profile_scopes(conn) -> list[ConnectorScope]:
    """Derive discovery scopes from every active search_profile's geography.

    Issue #71: closes the gap ConnectorScope's docstring described as
    aspirational. Zero active profiles -> an empty list, which
    `run_all_connectors` treats as "nothing to discover" — not a fallback to
    any hardcoded geography. Profiles with the same (rounded) center and
    radius are deduplicated so two profiles targeting the same area don't
    make a connector crawl it twice in one run.

    `search_profile.scope.geography` is `{"type": "radius", "center":
    [lat, lon], "radius_km": ...}` (dashboard/lib/profiles-schema.ts). A
    profile with a missing/malformed geography is skipped with a warning
    rather than raising — one bad row shouldn't block discovery for every
    other active profile.
    """
    with conn.cursor() as cur:
        # ORDER BY id (issue #217/D-030): a plain SELECT gives no row-order
        # guarantee at all absent an ORDER BY. `_order_scopes_by_fairness`
        # relies on ties (multiple scopes tied at "never attempted") being
        # broken by profile creation order — oldest-starved-first — which
        # only holds if this list is deterministically ordered to begin
        # with.
        cur.execute(
            "SELECT id, scope FROM search_profile WHERE archived_at IS NULL ORDER BY id"
        )
        rows = cur.fetchall()

    seen: dict[tuple[float, float, float], ConnectorScope] = {}
    for profile_id, scope_json in rows:
        geography = (scope_json or {}).get("geography")
        if not isinstance(geography, dict) or geography.get("type") != "radius":
            logger.warning(
                "search_profile id=%s: scope.geography missing/not type "
                "'radius' — skipping for connector discovery",
                profile_id,
            )
            continue
        center = geography.get("center")
        radius_km = geography.get("radius_km")
        if (
            not isinstance(center, list)
            or len(center) != 2
            # bool is a subclass of int in Python — isinstance(True, int)
            # is True, so exclude it explicitly or a malformed
            # radius_km=true/false would silently pass this check as if it
            # were a real number.
            or isinstance(radius_km, bool)
            or not isinstance(radius_km, (int, float))
        ):
            logger.warning(
                "search_profile id=%s: scope.geography.center/radius_km "
                "malformed — skipping for connector discovery",
                profile_id,
            )
            continue

        try:
            lat, lon, radius = float(center[0]), float(center[1]), float(radius_km)
        except (TypeError, ValueError):
            # center/radius_km passed the isinstance/len checks above (e.g.
            # center=["abc", "def"] is a 2-element list) but isn't actually
            # numeric. Same "one bad row must not take down the whole run"
            # invariant as the isinstance checks above and as
            # _scopes_for_connector's mirror of this same guard — skip only
            # this profile's scope, not the run.
            logger.warning(
                "search_profile id=%s: scope.geography.center/radius_km "
                "not numeric (got center=%r, radius_km=%r) — skipping for "
                "connector discovery",
                profile_id,
                center,
                radius_km,
            )
            continue

        dedup_key = (
            round(lat, _SCOPE_DEDUP_DECIMALS),
            round(lon, _SCOPE_DEDUP_DECIMALS),
            round(radius, 1),
        )
        seen.setdefault(dedup_key, ConnectorScope(center=(lat, lon), radius_km=radius))

    return list(seen.values())


def _scopes_for_connector(
    conn, connector_name: str, profile_scopes: list[ConnectorScope]
) -> tuple[list[ConnectorScope], bool, int | None]:
    """Resolve one connector's actual scopes for this run, per issue #99's
    hybrid model: an explicit `connector_config` row overrides the shared
    `_active_profile_scopes` default; a connector with no row (the common
    case — this table starts empty) keeps issue #71's behavior unchanged.

    Returns (scopes, enabled, min_refetch_interval_seconds_override).
    `enabled=False` means the caller must skip this connector entirely —
    before ever deriving a scope or calling discover(). It still gets a
    `connector_run_results` row (status='skipped', counted separately from
    ok/failed) so a disabled connector is visible in run history rather
    than silently absent — an operator turning a connector off is not a
    failure, and shouldn't add 'failed'/'ok' noise, but it also shouldn't
    look identical to "everything ran fine and there was simply nothing to
    do". This is a different, more absolute case than `enabled=True,
    scopes=[]` (nothing to do this run because there's no override and no
    active profile reaches this connector's coverage — issue #71's
    existing, already-normal no-op path, which still gets no result row
    since nothing was ever skipped by operator choice).

    `min_refetch_interval_seconds_override` (issue #143) is `None` when no
    override is configured — the caller falls back to
    `connector.min_refetch_interval_seconds`, same override-vs-class-
    attribute-default pattern `filters.rooms` already established for
    `ConnectorScope.rooms` above.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT enabled, geography_override, filters, "
            "min_refetch_interval_seconds "
            "FROM connector_config WHERE connector_name = %s",
            (connector_name,),
        )
        row = cur.fetchone()

    if row is None:
        # No config row at all: issue #71's default, unmodified.
        return profile_scopes, True, None

    enabled, geography_override, filters, min_refetch_interval_seconds_raw = row
    if not enabled:
        return [], False, None

    # geography_override/filters are JSONB — the column type guarantees
    # valid JSON, but says nothing about *shape*. A string or list value
    # (e.g. an operator/future-UI bug that stores "madrid" instead of
    # {"center": [...], ...}) is not a dict, and calling .get() on it
    # raises AttributeError — which, uncaught here, would previously abort
    # this connector's resolution entirely and propagate up through the
    # per-connector loop in run_all_connectors, killing the WHOLE run for
    # every connector, not just this one misconfigured row. Every branch
    # below is guarded with isinstance(..., dict) before any .get() call,
    # specifically so a malformed row can only ever fall back to the
    # profile-derived default — it must never be able to take down a run.
    if isinstance(geography_override, dict) and geography_override:
        center = geography_override.get("center")
        radius_km = geography_override.get("radius_km")
        if (
            isinstance(center, list)
            and len(center) == 2
            and not isinstance(radius_km, bool)
            and isinstance(radius_km, (int, float))
        ):
            try:
                lat, lon, radius = (
                    float(center[0]),
                    float(center[1]),
                    float(radius_km),
                )
            except (TypeError, ValueError):
                logger.warning(
                    "connector_config for %s: geography_override has "
                    "non-numeric center/radius_km (got %r) — falling back "
                    "to profile-derived scope",
                    connector_name,
                    geography_override,
                )
                base_scopes = profile_scopes
            else:
                base_scopes = [ConnectorScope(center=(lat, lon), radius_km=radius)]
        else:
            # Malformed override shouldn't silently disable the connector
            # or crash the run — fall back to the profile-derived default,
            # same "don't let one bad row block everything else" posture
            # _active_profile_scopes already takes for a malformed profile.
            logger.warning(
                "connector_config for %s: geography_override malformed "
                "(expected {center: [lat, lon], radius_km: n}, got %r) — "
                "falling back to profile-derived scope",
                connector_name,
                geography_override,
            )
            base_scopes = profile_scopes
    elif geography_override:
        # Present, truthy, but not a dict at all (a bare string/list/number)
        # — same fallback, distinct log wording from "genuinely absent"
        # below so an operator can tell "you configured something, but it
        # was unusable" apart from "you never configured anything".
        logger.warning(
            "connector_config for %s: geography_override is not an object "
            "(expected {center: [lat, lon], radius_km: n}, got %r) — "
            "falling back to profile-derived scope",
            connector_name,
            geography_override,
        )
        base_scopes = profile_scopes
    else:
        # Genuinely absent/empty (None, {}, "", 0) — no override was ever
        # configured for this connector, not "one was configured but is
        # unusable". Distinguishing these two is why this isn't a single
        # `if geography_override:` branch.
        base_scopes = profile_scopes

    rooms: int | None = None
    if isinstance(filters, dict):
        rooms_raw = filters.get("rooms")
        if rooms_raw is not None and not isinstance(rooms_raw, bool):
            try:
                rooms = int(rooms_raw)
            except (TypeError, ValueError):
                logger.warning(
                    "connector_config for %s: filters.rooms=%r is not a "
                    "valid integer — ignoring",
                    connector_name,
                    rooms_raw,
                )
    elif filters:
        logger.warning(
            "connector_config for %s: filters is not an object (got %r) — ignoring",
            connector_name,
            filters,
        )

    if rooms is not None:
        base_scopes = [dataclasses.replace(s, rooms=rooms) for s in base_scopes]

    min_refetch_interval_seconds: int | None = None
    if min_refetch_interval_seconds_raw is not None:
        if isinstance(min_refetch_interval_seconds_raw, bool):
            # Same bool-is-a-subclass-of-int trap as radius_km above.
            logger.warning(
                "connector_config for %s: min_refetch_interval_seconds=%r "
                "is a boolean, not an integer — ignoring",
                connector_name,
                min_refetch_interval_seconds_raw,
            )
        else:
            try:
                candidate = int(min_refetch_interval_seconds_raw)
            except (TypeError, ValueError):
                logger.warning(
                    "connector_config for %s: min_refetch_interval_seconds=%r "
                    "is not a valid integer — ignoring",
                    connector_name,
                    min_refetch_interval_seconds_raw,
                )
            else:
                if candidate < 0:
                    logger.warning(
                        "connector_config for %s: min_refetch_interval_seconds=%d "
                        "is negative — ignoring",
                        connector_name,
                        candidate,
                    )
                else:
                    min_refetch_interval_seconds = candidate

    return base_scopes, True, min_refetch_interval_seconds


def _order_scopes_by_fairness(
    conn, connector: Connector, scopes: list[ConnectorScope]
) -> list[ConnectorScope]:
    """Reorder *scopes* so a never-(or longest-ago-)attempted scope sorts
    first — issue #217/D-030.

    The bug this exists to fix: the shared circuit breaker's error budget
    is cumulative across every scope in a run, and a soft-blocking
    connector (Fotocasa) reliably exhausts it during the very first scope
    in list order. Every scope after that gets skipped outright — not
    "rarely reached", *never*, because the list order never changed
    between runs. A profile in a brand-new geography that happens to sort
    anywhere but first was starved permanently, with no error: the run
    just reports `circuit_open` and moves on.

    Fix: track, per (connector, scope), the last time it actually reached
    an attempt (`_record_scope_attempt`, called once `run_connector` is
    about to be invoked for it — see the call site in `run_all_connectors`
    below). Sorting ascending by that timestamp — treating "never
    attempted" as older than any real timestamp via `_NEVER_ATTEMPTED` —
    gives two properties from one persisted field, not two separate
    mechanisms:

    1. **Prioritise never-crawled scopes.** A scope with no
       `connector_scope_state` row sorts before every scope that has one,
       every single run, until it finally gets its own attempt.
    2. **Rotate the already-crawled scopes.** Whichever scope was reached
       this run gets its timestamp bumped to "now" (see
       `_record_scope_attempt`), which pushes it to the BACK of next run's
       order — so the scope that just consumed this run's budget isn't
       the one consuming next run's budget too.

    Bound (stated for the acceptance criterion): the shared breaker always
    lets the run's first-in-order scope reach a full `discover()` call —
    it starts untripped, and the "already open" skip only fires for scope
    index >= 1 (see the loop below) — so at least one scope is genuinely
    attempted per run in the worst case (the one Fotocasa exhibits: the
    breaker trips during that very first scope and every later one is
    skipped for budget). A newly-created profile's scope therefore reaches
    its first attempt within **U + 1** runs of being created, where U is
    the number of OTHER scopes for that connector that were already
    "never attempted" at the moment the profile was created (ties among
    never-attempted scopes break by `scopes`' incoming order, which is
    `_active_profile_scopes`' `ORDER BY id` — i.e. profile creation order,
    oldest first). In the common case — the one issue #217 was filed
    against, a single new profile in an otherwise-fully-crawled
    connector's coverage — U is 0 and the bound is exactly 1 run,
    matching the acceptance criterion's "scope 2 is attempted on the
    following run" literally.

    A scope whose `scope_key()` returns None (no coverage at all for this
    connector) can't be tracked by key and is treated as
    `_NEVER_ATTEMPTED` too — harmless, since that branch in the loop below
    never calls `discover()` or touches the shared breaker, so it can't
    consume another scope's turn no matter where it sorts.

    Stable sort (Python's `sorted()`): ties keep their incoming relative
    order, which is what makes the "U older never-attempted scopes go
    first" bound hold rather than an arbitrary/undefined tie order.
    """
    with conn.cursor() as cur:
        # `last_attempted_at IS NOT NULL` is load-bearing, not defensive
        # tidiness: since issue #217 added the covered-but-skipped-for-budget
        # row (`_record_scope_covered_but_skipped`), a row can legitimately
        # exist with a NULL `last_attempted_at`. Letting that NULL through
        # would put `None` in this dict and make `sorted()` raise
        # TypeError comparing None to a datetime — and semantically such a
        # scope IS still never-attempted, so it must fall through to the
        # `_NEVER_ATTEMPTED` default below and keep its front-of-queue
        # priority rather than being treated as recently served.
        cur.execute(
            "SELECT scope_key, last_attempted_at FROM connector_scope_state "
            "WHERE connector_name = %s AND last_attempted_at IS NOT NULL",
            (connector.name,),
        )
        last_attempted = dict(cur.fetchall())

    def _priority(scope: ConnectorScope) -> datetime:
        key = connector.scope_key(scope)
        if key is None:
            return _NEVER_ATTEMPTED
        return last_attempted.get(key, _NEVER_ATTEMPTED)

    return sorted(scopes, key=_priority)


_MUNICIPAL_COVERAGE_RADIUS_KM = 5.0
"""How far from a resolved municipality's own centroid we are willing to
claim was crawled, in km.

A connector crawls a MUNICIPALITY (a city slug page, a sitemap's municipio
entries), not a circle — there is no exact radius to store, and the
gazetteer records centroids only, no boundaries. So this is a deliberate
under-estimate: it is smaller than the real extent of any large
municipality (Madrid's own boundary reaches ~15 km from its centroid), which
means a point genuinely inside a big city's outskirts can fail the
containment test and be reported as "no record of a crawl here".

That direction is chosen on purpose. Reporting less coverage than was
actually achieved sends a user to "we have no record of crawling this yet",
which is honest and self-correcting. Reporting MORE — the pre-review
behaviour — told the user their area was crawled and is genuinely empty when
nothing had ever looked at it, which is the exact misdiagnosis issue #217
was filed about. See D-030 and PR #228 review finding 2.
"""


def _scope_coverage_columns(
    scope: ConnectorScope,
) -> tuple[float | None, float | None, float | None]:
    """(coverage_center_lat, coverage_center_lon, coverage_radius_km) for
    `connector_scope_state` — the circle describing WHAT WAS ACTUALLY
    CRAWLED for *scope*, or (None, None, None) when no honest circle can be
    derived and therefore no coverage may be claimed at all.

    Issue #217 stores this so a consumer holding only a lat/lon (the
    dashboard's zero-candidate diagnostic, issue #194) can ask "has any
    connector crawled a scope covering this point" without reimplementing
    each connector's Python-side geography resolution.

    PR #228 review, finding 2: this used to return the scope's OWN center
    and `radius_km`, which is not a crawl footprint at all. `radius_km` is
    the profile's search radius — `resolve_place` -> `nearest_place` only
    ever uses it to TIGHTEN the match ceiling (`min(_MAX_MATCH_DISTANCE_KM,
    radius_km)`), never to widen what is crawled — and it is allowed up to
    200 km. A Dos Hermanas profile at `radius_km=120` therefore stored a
    120 km disc, and the diagnostic answered "crawled" for Estepona, 117.8
    km away and never looked at by anyone. That is the failure mode issue
    #217 exists to remove, reintroduced by the feature meant to cure it.

    What is stored instead is the resolved municipality's own centroid plus
    `_MUNICIPAL_COVERAGE_RADIUS_KM` — the thing the connector actually
    crawls, with a conservative extent. Connectors that crawl WIDER than one
    municipality (Solvia sweeps a whole provincia, D-018; BuildingCenter
    sweeps the national catalogue, D-023) are therefore under-reported, and
    that is the acceptable direction; nothing here may ever over-report.

    Returns no circle at all when the scope has no center (a free-text
    `geography` scope — tests, a `connector_config` geography_override) or
    when its center resolves to no place in the gazetteer (the
    `unresolvable_scope_key` case): in both, we have no idea what area was
    crawled, and inventing one is exactly the mistake above.
    """
    if scope.center is None:
        return None, None, None
    try:
        place = resolve_place(scope)
    except UnresolvableGeographyError:
        return None, None, None
    if place is None:
        return None, None, None
    return place.lat, place.lon, _MUNICIPAL_COVERAGE_RADIUS_KM


def _record_scope_covered_but_skipped(
    conn,
    connector_name: str,
    scope_key: str,
    scope: ConnectorScope,
    when: datetime,
) -> None:
    """Persist that *scope_key* is genuinely COVERED by *connector_name* but
    was passed over this run because the shared circuit breaker was already
    open — issue #217/D-030.

    This is the row that makes the issue's third acceptance criterion
    answerable from data instead of from prose. A `connector_scope_state`
    row with `last_attempted_at IS NULL` means "this connector resolves your
    geography fine, it just hasn't had its turn yet"; *no row at all* means
    "no connector covers this geography" (`scope_key()` returned None, so
    there is no key to store under). Before this, a brand-new profile in a
    covered-but-starved area and one in a genuinely uncovered area both
    produced exactly nothing anywhere.

    `last_attempted_at` is deliberately left ALONE on conflict (not set,
    not cleared): a scope crawled three runs ago and skipped for budget
    since must keep its real attempt timestamp, both because that timestamp
    is what `_order_scopes_by_fairness` sorts on and because clearing it
    would falsely claim the area was never crawled. Only the geography
    columns are refreshed, so a profile whose radius changed doesn't leave a
    stale circle behind.
    """
    center_lat, center_lon, radius_km = _scope_coverage_columns(scope)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_scope_state (
                connector_name, scope_key, last_attempted_at,
                last_skipped_for_budget_at,
                coverage_center_lat, coverage_center_lon, coverage_radius_km
            )
            VALUES (%s, %s, NULL, %s, %s, %s, %s)
            ON CONFLICT (connector_name, scope_key) DO UPDATE
                SET last_skipped_for_budget_at = EXCLUDED.last_skipped_for_budget_at,
                    coverage_center_lat = EXCLUDED.coverage_center_lat,
                    coverage_center_lon = EXCLUDED.coverage_center_lon,
                    coverage_radius_km  = EXCLUDED.coverage_radius_km
            """,
            (connector_name, scope_key, when, center_lat, center_lon, radius_km),
        )
    conn.commit()


def _record_scope_attempt(
    conn, connector_name: str, scope_key: str, scope: ConnectorScope, when: datetime
) -> None:
    """Persist that *scope_key* reached a real attempt for *connector_name*
    at *when* — issue #217/D-030's fairness bookkeeping.

    Called once per scope actually reached in `run_all_connectors`' loop
    (right before `run_connector` is invoked for it), regardless of how
    that attempt turns out — success, per-listing errors, an
    `UnresolvableGeographyError`, or the shared breaker tripping partway
    through its own listings. "Attempted" means "we looked", not "we
    succeeded": a scope whose `discover()` genuinely fails on every run
    must still rotate to the back of the priority queue, or a
    persistently-broken scope would starve every other scope exactly the
    way issue #217's bug did — just via a permanent failure instead of a
    permanently-losing list position.

    Upsert, not insert: `connector_scope_state`'s PK is
    (connector_name, scope_key), so a scope attempted on a prior run
    already has a row and this only ever needs to bump its timestamp.
    Committed immediately (not batched with the rest of the run's writes)
    so the fairness state is durable even if the process crashes partway
    through this scope's `run_connector` call — a crash must not make this
    scope look never-attempted next run when it genuinely was attempted.
    """
    center_lat, center_lon, radius_km = _scope_coverage_columns(scope)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_scope_state (
                connector_name, scope_key, last_attempted_at,
                coverage_center_lat, coverage_center_lon, coverage_radius_km
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (connector_name, scope_key) DO UPDATE
                SET last_attempted_at = EXCLUDED.last_attempted_at,
                    coverage_center_lat = EXCLUDED.coverage_center_lat,
                    coverage_center_lon = EXCLUDED.coverage_center_lon,
                    coverage_radius_km  = EXCLUDED.coverage_radius_km
            """,
            (connector_name, scope_key, when, center_lat, center_lon, radius_km),
        )
    conn.commit()


def _record_scope_discovered(
    conn, connector_name: str, scope_key: str, when: datetime
) -> None:
    """Persist that a `discover()` for *scope_key* actually SUCCEEDED at
    *when* — PR #228 review, finding 1.

    Called only after `run_connector` returns without raising, i.e. after a
    real `discover()` completed. Deliberately separate from
    `_record_scope_attempt`, which fires before the call and unconditionally
    because fairness ordering requires failures to count as turns taken.

    That asymmetry is the whole point. `last_attempted_at` answers "has this
    scope had its turn?" (ordering); `last_discovered_at` answers "did
    anyone ever actually manage to crawl here?" (the user-facing coverage
    claim). Driving the dashboard's "this area was crawled on <date>" line
    off the former meant a scope whose `discover()` raises on every run —
    a soft-block page, a post-redesign parse failure — still reported itself
    to the user as successfully crawled and genuinely empty.

    A bare UPDATE, not an upsert: `_record_scope_attempt` runs immediately
    before `run_connector` for this same key, so the row is guaranteed to
    exist. Committed immediately for the same durability reason as the
    attempt write, and it touches neither the attempt timestamp nor the
    coverage circle — both are already correct from the attempt write.
    """
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE connector_scope_state SET last_discovered_at = %s "
            "WHERE connector_name = %s AND scope_key = %s",
            (when, connector_name, scope_key),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Freshness cadence (issue #295, D-050)
# ---------------------------------------------------------------------------


class FreshnessRow(NamedTuple):
    """The connector_freshness_state row for one connector (or a synthetic
    all-NULL row when none exists yet — a connector with no row is simply
    "never fresh", due immediately, same posture as every other
    NULL-means-never-happened column in this schema)."""

    last_fresh_at: datetime | None
    cycle_started_at: datetime | None
    cycle_target_scope_count: int | None


def _load_connector_freshness(conn, connector_name: str) -> FreshnessRow | None:
    """Current connector_freshness_state row, or None when the connector has
    never entered the cadence machinery (no row yet = never fresh = due)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT last_fresh_at, cycle_started_at, cycle_target_scope_count "
            "FROM connector_freshness_state WHERE connector_name = %s",
            (connector_name,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return FreshnessRow(*row)


def _resolve_freshness_interval_hours(
    conn, connector_name: str, default_interval_hours: int
) -> int:
    """Effective freshness interval for *connector_name*: the per-connector
    `connector_config.freshness_interval_hours` override when present and valid,
    else the global *default_interval_hours*.

    Same override-vs-global-default precedence as
    `min_refetch_interval_seconds` (issue #143). A NULL, non-positive, or
    non-int override falls back to the default rather than disabling the gate —
    NULL means "use the default", never "never track freshness".
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT freshness_interval_hours FROM connector_config "
            "WHERE connector_name = %s",
            (connector_name,),
        )
        row = cur.fetchone()
    if row is None or row[0] is None:
        return default_interval_hours
    raw = row[0]
    if isinstance(raw, bool):
        # bool is a subclass of int — same trap guarded elsewhere.
        return default_interval_hours
    try:
        candidate = int(raw)
    except (TypeError, ValueError):
        return default_interval_hours
    return candidate if candidate > 0 else default_interval_hours


def _freshness_decision(
    freshness_row: FreshnessRow | None,
    interval_hours: int,
    trigger: str,
    now: datetime,
) -> Literal["skip", "start", "continue"]:
    """Decide, for one connector on one tick, whether to skip it entirely,
    start a new refresh cycle, or continue an in-flight one (issue #295, D-050).

    - Manual/CLI triggers (`trigger != "scheduler"` — `ps connector run`, the
      dashboard's "Ejecutar ahora"/etl_manual_trigger) BYPASS the gate, like
      D-038's restart-guard bypass: a deliberate operator action must never
      silently no-op because the connector happens to be fresh. They continue an
      existing cycle, or start one.
    - A cycle already in flight (`cycle_started_at IS NOT NULL`) always
      continues, regardless of how the interval compares to elapsed time — the
      interval gates only STARTING a new cycle, never abandoning one partway.
    - Never fresh (`last_fresh_at IS NULL`) → due immediately → start.
    - Fresh and the interval has elapsed → start; otherwise → skip.
    """
    if trigger != "scheduler":
        if freshness_row is not None and freshness_row.cycle_started_at is not None:
            return "continue"
        return "start"

    if freshness_row is not None and freshness_row.cycle_started_at is not None:
        return "continue"

    last_fresh_at = freshness_row.last_fresh_at if freshness_row is not None else None
    if last_fresh_at is None:
        return "start"
    if now - last_fresh_at >= timedelta(hours=interval_hours):
        return "start"
    return "skip"


def _target_scope_keys(connector: Connector, scopes: list[ConnectorScope]) -> set[str]:
    """The set of resolvable scope keys a cycle must cover for *connector* given
    this tick's resolved *scopes* — `scope_key()` results that are neither None
    (no coverage) nor the unresolvable-geography sentinel (discover() raises for
    it by construction). Deduped, since two profiles can resolve to one key."""
    keys: set[str] = set()
    for scope in scopes:
        key = connector.scope_key(scope)
        if key is None or is_unresolvable_scope_key(key):
            continue
        keys.add(key)
    return keys


def _scope_keys_discovered_since(
    conn, connector_name: str, since: datetime
) -> set[str]:
    """scope_keys whose discover() last SUCCEEDED at/after *since* — the "done
    this cycle" set, read live from connector_scope_state (issue #217/D-030), so
    no separate per-scope progress table is needed."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT scope_key FROM connector_scope_state "
            "WHERE connector_name = %s AND last_discovered_at >= %s",
            (connector_name, since),
        )
        return {row[0] for row in cur.fetchall()}


def _start_connector_freshness_cycle(
    conn, connector_name: str, cycle_started_at: datetime, target_scope_count: int
) -> None:
    """Upsert a new in-progress cycle: cycle_started_at set to now, last_fresh_at
    left as-is (idle→in-progress transition), target count snapshotted."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_freshness_state (
                connector_name, cycle_started_at, cycle_target_scope_count,
                updated_at
            )
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (connector_name) DO UPDATE
                SET cycle_started_at = EXCLUDED.cycle_started_at,
                    cycle_target_scope_count = EXCLUDED.cycle_target_scope_count,
                    updated_at = EXCLUDED.updated_at
            """,
            (connector_name, cycle_started_at, target_scope_count, cycle_started_at),
        )
    conn.commit()


def _complete_connector_freshness_cycle(
    conn, connector_name: str, now: datetime
) -> None:
    """Mark a cycle complete: last_fresh_at = now, cycle_started_at = NULL. The
    connector goes quiet until the interval elapses again."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_freshness_state (
                connector_name, last_fresh_at, cycle_started_at, updated_at
            )
            VALUES (%s, %s, NULL, %s)
            ON CONFLICT (connector_name) DO UPDATE
                SET last_fresh_at = EXCLUDED.last_fresh_at,
                    cycle_started_at = NULL,
                    updated_at = EXCLUDED.updated_at
            """,
            (connector_name, now, now),
        )
    conn.commit()


def _finalize_connector_freshness_cycle(
    conn,
    connector: Connector,
    cycle_started_at: datetime,
    scopes: list[ConnectorScope],
    now: datetime,
    stuck_after_hours: int,
) -> None:
    """Cycle completion / stuck detection for one connector at the end of its
    per-run block (issue #295, D-050).

    Completion is binary and DERIVED, never stored as a list: compute the
    connector's live target scope-key set from *scopes*, count how many have
    been discovered since *cycle_started_at*, and if 100% (including the vacuous
    zero-target case) mark the cycle fresh and clear it. Otherwise leave
    cycle_started_at untouched so the next tick continues it — and if the cycle
    is older than *stuck_after_hours*, log a WARNING and let it read as
    "still refreshing, taking unusually long" forever. NEVER force-complete: a
    connector that can't finish (Fotocasa tripping the breaker every tick, #270)
    must never falsely claim fresh.
    """
    target_keys = _target_scope_keys(connector, scopes)
    discovered_since = _scope_keys_discovered_since(
        conn, connector.name, cycle_started_at
    )
    remaining = target_keys - discovered_since
    if not remaining:
        _complete_connector_freshness_cycle(conn, connector.name, now)
        logger.info(
            "Connector %s: freshness cycle complete — %d/%d target scope(s) "
            "discovered since cycle start %s; marked fresh, next cycle waits out "
            "the interval",
            connector.name,
            len(target_keys),
            len(target_keys),
            cycle_started_at,
        )
        return

    if now - cycle_started_at > timedelta(hours=stuck_after_hours):
        logger.warning(
            "Connector %s: freshness cycle STUCK — started %s (>%dh ago), still "
            "%d of %d target scope(s) not yet discovered this cycle. Flagging "
            "for observability; NOT force-completing (it will keep reading as "
            "'refreshing', never falsely 'fresh'). This usually means the site "
            "can't be fully covered (e.g. the circuit breaker trips every tick "
            "— #270).",
            connector.name,
            cycle_started_at,
            stuck_after_hours,
            len(remaining),
            len(target_keys),
        )
    else:
        logger.info(
            "Connector %s: freshness cycle continuing — %d/%d target scope(s) "
            "discovered so far this cycle (started %s); resumes next tick",
            connector.name,
            len(target_keys) - len(remaining),
            len(target_keys),
            cycle_started_at,
        )


def run_all_connectors(
    conn,
    trigger: str = "scheduler",
    connector_name: str | None = None,
    *,
    dedup_max_runtime_seconds: int = _DEFAULT_DEDUP_MAX_RUNTIME_SECONDS,
    default_freshness_interval_hours: int = _DEFAULT_FRESHNESS_INTERVAL_HOURS,
    freshness_cycle_stuck_after_hours: int = _DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS,
) -> int:
    """Run every registered connector once, recording a connector_runs row.

    Safe to call with an empty CONNECTORS registry (EC-4) — records a run
    with total_connectors=0 and returns immediately.

    Scope resolution per connector (issue #99, evolving #71): a
    `connector_config` row, when present, can disable a connector outright
    or override its scope with an explicit geography + native filters,
    independent of what search profiles exist. A connector with no config
    row falls back to issue #71's original default — scope derived from
    the union of every active search_profile's geography. See
    `_scopes_for_connector`.

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
            raise UnknownConnectorError(
                f"Unknown connector {connector_name!r} — known: {known}"
            )
        connectors_to_run = matching
    else:
        connectors_to_run = CONNECTORS

    _reconcile_stale_runs(conn)
    _warn_unrecognized_connector_config_names(conn)
    run_id = _create_connector_run(conn, trigger)
    ok = 0
    failed = 0
    skipped = 0

    # Issue #99: this is now only the shared *default* input, not the final
    # word — each connector below resolves its own actual scopes via
    # _scopes_for_connector, which may override it entirely (explicit
    # geography_override) or ignore it (disabled). No blanket early-return
    # here anymore: a connector-level override can still have real work to
    # do even with zero active search profiles, so "no profiles" can no
    # longer mean "skip literally everything" at the whole-run level — it's
    # now evaluated per connector, same place enabled/disabled is.
    profile_scopes = _active_profile_scopes(conn)

    for connector in connectors_to_run:
        scopes, enabled, min_refetch_override = _scopes_for_connector(
            conn, connector.name, profile_scopes
        )
        if not enabled:
            # Issue #99 hardening: an operator explicitly turned this
            # connector off — real and worth a visible trace, not a silent
            # no-op. A run where every connector happens to be disabled
            # used to look byte-identical to a healthy, fully-successful
            # empty run; recording a 'skipped' result row (and counting it
            # separately from ok/failed) is what makes "nothing ran because
            # I told it not to" distinguishable from "nothing ran and I
            # have no idea why". WARNING, not INFO, to match the severity
            # this project already uses for "no scopes to discover" below —
            # an operator forgetting they disabled a connector is exactly
            # the kind of thing that should be noisy, not buried in INFO.
            logger.warning(
                "Connector %s: disabled via connector_config — skipping "
                "entirely this run",
                connector.name,
            )
            now = datetime.now(timezone.utc)
            _record_connector_result(
                conn,
                run_id,
                connector.name,
                status="skipped",
                discovered_count=0,
                fetched_count=0,
                error_count=0,
                error_msg="disabled via connector_config",
                started_at=now,
                finished_at=now,
            )
            skipped += 1
            continue

        # Issue #295 (D-050): freshness cadence gate. Decide, per connector per
        # tick, whether this connector is due for (or mid-) a refresh cycle
        # BEFORE spending any discover()/breaker/limiter cost. A scheduler tick
        # for a connector that is fresh and not yet due is skipped ENTIRELY —
        # no connector_run_results row, same "genuinely nothing to do" posture
        # as the empty-`scopes` early-continue below (issue #71/#99). Manual and
        # CLI triggers bypass the gate (D-038 precedent): a human pressing a
        # button must never silently no-op. `cycle_started_at` (this cycle's
        # anchor) drives both resume (skip scopes already discovered since it)
        # and completion (all target scopes discovered since it → fresh).
        now_freshness = datetime.now(timezone.utc)
        freshness_row = _load_connector_freshness(conn, connector.name)
        interval_hours = _resolve_freshness_interval_hours(
            conn, connector.name, default_freshness_interval_hours
        )
        decision = _freshness_decision(
            freshness_row, interval_hours, trigger, now_freshness
        )
        if decision == "skip":
            logger.info(
                "Connector %s: fresh (last_fresh_at=%s, interval=%dh) and no "
                "cycle in progress — skipping this scheduler tick (not due yet, "
                "no run row created)",
                connector.name,
                freshness_row.last_fresh_at if freshness_row else None,
                interval_hours,
            )
            continue
        if decision == "start":
            cycle_started_at = now_freshness
            _start_connector_freshness_cycle(
                conn,
                connector.name,
                cycle_started_at,
                target_scope_count=len(_target_scope_keys(connector, scopes)),
            )
            logger.info(
                "Connector %s: starting a freshness cycle at %s "
                "(trigger=%s, interval=%dh)",
                connector.name,
                cycle_started_at,
                trigger,
                interval_hours,
            )
        else:  # "continue" — a cycle is already in flight
            assert freshness_row is not None  # only reachable with a real row
            cycle_started_at = freshness_row.cycle_started_at
            assert cycle_started_at is not None
            logger.info(
                "Connector %s: continuing an in-progress freshness cycle "
                "(started %s, trigger=%s)",
                connector.name,
                cycle_started_at,
                trigger,
            )

        if not scopes:
            # Same posture issue #71 established for "no active profiles":
            # not an error, nothing to record — just genuinely nothing for
            # this connector to do this run (no override, and no active
            # profile's geography resolves to its coverage).
            #
            # Issue #295 (D-050): the vacuous-completion case. A cycle is active
            # (we just started it, or are continuing one) but the connector has
            # zero currently-covered scopes — that is 100% of an empty target
            # set, so the cycle is trivially complete. Mark it fresh and clear
            # it, or it would stay "refreshing" forever with nothing to do.
            logger.warning(
                "Connector %s: no scopes to discover this run (no "
                "connector_config override and no active search profile "
                "reaches its coverage) — skipping",
                connector.name,
            )
            _finalize_connector_freshness_cycle(
                conn,
                connector,
                cycle_started_at,
                [],
                datetime.now(timezone.utc),
                freshness_cycle_stuck_after_hours,
            )
            continue

        # Issue #217/D-030: never-attempted scopes first, already-attempted
        # ones oldest-attempt-first — see _order_scopes_by_fairness for the
        # full rationale and the bound this gives a newly-created profile.
        # Must run AFTER the `not scopes` check above (nothing to order for
        # an empty list) and BEFORE the breaker/limiter are constructed
        # below, since the per-scope loop iterates this reordered list.
        scopes = _order_scopes_by_fairness(conn, connector, scopes)

        # Issue #143: an explicit connector_config override wins; otherwise
        # fall back to this connector's own class-attribute default (0 for
        # every connector that hasn't opted into skip-if-seen).
        effective_min_refetch_interval_seconds = (
            min_refetch_override
            if min_refetch_override is not None
            else connector.min_refetch_interval_seconds
        )

        started_at = datetime.now(timezone.utc)
        discovered_total = 0
        fetched_total = 0
        skipped_fetch_total = 0
        error_total = 0
        # Issue #270 (D-047): the subset of error_total that was soft-block
        # (rate-throttle), for the informational notice. error_total still
        # counts every failed fetch (genuine + soft-block) as an error — only
        # the run STATUS treats a soft-block-driven stop as clean.
        soft_block_error_total = 0
        # A breaker trip driven by GENUINE fatal errors — worth surfacing as
        # 'circuit_open'. Distinct from a soft-block/budget stop, which is a
        # clean 'ok' outcome recorded only as an informational note.
        any_fatal_circuit_open = False
        # Issue #270 (D-047): clean "waited for budget" notices — the breaker
        # tripped on soft-blocks, a discover() hit a soft-block wall, or whole
        # scopes were skipped because the (soft-block-tripped) breaker was
        # already open. None of these are failures; a non-empty list just means
        # the run stopped short of full coverage for a benign reason and keeps
        # the status 'ok'.
        budget_notes: list[str] = []
        any_scope_failed = False
        # Issue #177 (M4): tracked separately from any_scope_failed — see
        # the UnresolvableGeographyError except clause below for why a
        # scope whose center matches no place in the gazetteer at all must
        # NOT be treated identically to a real discover() failure (network
        # error, parse error, etc.) when deciding this connector's overall
        # status and whether withdrawal reconciliation is safe this run.
        any_scope_unresolvable = False
        scope_summaries: list[str] = []
        error_msgs: list[str] = []
        # Issue #217: the structured counterpart to error_msg's prose, so a
        # consumer never has to string-match free text to tell "we ran out
        # of budget before reaching your geography" from "this connector
        # doesn't cover your geography at all". Persisted verbatim to
        # connector_run_results.skipped_scopes (JSONB); entries are
        # {"scope": <scope_key or repr(scope)>, "reason": "budget"|"uncovered"}.
        skipped_scopes: list[dict[str, str]] = []

        # Issue #71 hardening: one limiter/breaker per connector per RUN,
        # not per scope — shared across every profile-geography this
        # connector processes below, so a circuit trip (or the rate
        # limiter's pacing) actually carries over from one scope to the
        # next instead of resetting and giving a blocking site N times the
        # error budget it's supposed to have (see run_connector's
        # docstring).
        limiter = RateLimiter(connector.rate_limit_per_minute)
        breaker = CircuitBreaker(
            connector.circuit_breaker_error_rate,
            connector.circuit_breaker_min_attempts,
            window=connector.circuit_breaker_window,
            # Issue #270 (D-047): soft-block (rate-throttle) errors trip against
            # this looser threshold; None falls back to the fatal rate inside
            # CircuitBreaker, a no-op for connectors that don't opt in.
            soft_block_error_rate_threshold=connector.circuit_breaker_soft_block_error_rate,
        )
        seen_scope_keys: set[str] = set()
        # Issue #295 (D-050): the resume mechanism. scope_keys already
        # discovered since this cycle started are skipped in the per-scope loop
        # below — no discover() call, no rate-limiter/breaker cost — so a
        # multi-tick cycle picks up exactly where it left off instead of
        # re-crawling scopes it already refreshed this cycle. One query, read
        # live from connector_scope_state (no separate progress table). Composes
        # with #217/D-030's fairness ordering: fairness puts the genuinely
        # remaining (oldest-attempted) scopes first, and this guarantees any
        # already-done ones are never redundantly re-walked if the breaker had
        # leftover budget after finishing them.
        already_fresh_this_cycle = _scope_keys_discovered_since(
            conn, connector.name, cycle_started_at
        )
        # Withdrawal reconciliation runs once per connector per run,
        # against the union of every scope's discovered ids — never per
        # scope (see _reconcile_missed_discoveries' docstring: the sweep
        # has no scope predicate, so per-scope reconciliation withdraws
        # other scopes' live listings). `reconcilable_union` stays True
        # only while every scope processed so far was a safe contributor —
        # including scopes never even reached this run because the shared
        # breaker was already open (issue #217): a skipped-for-budget scope
        # tried even less than a failed one, so its absence from
        # `discovered_union` is exactly as untrustworthy as a genuine
        # discover() failure's would be.
        discovered_union: set[str] = set()
        reconcilable_union = True

        for scope_index, scope in enumerate(scopes):
            if breaker.tripped:
                # Already tripped from an earlier scope in this same run —
                # every remaining scope for this connector gets skipped
                # outright, not attempted and immediately aborted. This is
                # what "shared across scopes" actually buys: without it,
                # each scope got its own fresh, untripped breaker.
                #
                # Issue #270 (D-047): whether this stop is surfaced as a
                # problem or recorded as a clean "waited for budget" outcome
                # depends on WHY the earlier scope tripped the breaker (fatal
                # vs soft-block) — that was already captured on the tripping
                # scope into any_fatal_circuit_open / budget_notes. The
                # skipped-for-budget scopes here are themselves never a failure
                # (they were never even attempted), so this branch only records
                # them (as a budget note below); it does not, by itself, decide
                # the run status.
                # Issue #217: classify what's left rather than lumping it
                # all together. "discover() was never CALLED because an
                # earlier scope used up the shared error budget" and
                # "discover() was never going to find anything here because
                # this connector has no coverage for it" (issue #177's
                # case) are genuinely different answers to a user asking
                # "why is my profile empty?", and they used to be
                # indistinguishable from outside — both simply produced no
                # data and no message.
                #
                # `connector.scope_key()` is documented never to raise
                # (base.py), so calling it here purely to classify is safe —
                # it's the same call every attempted scope gets below, and
                # it does no I/O.
                skipped_for_budget: list[str] = []
                # PR #228 review, nit 5: two un-reached scopes can resolve
                # to the SAME key (two profiles, one city). Without a local
                # seen-set they were both appended — duplicated in
                # skipped_scopes, duplicated in the error_msg prose, and
                # `_record_scope_covered_but_skipped` called twice. The
                # outer `seen_scope_keys` is read below but deliberately not
                # written to: it means "crawled this run", and these scopes
                # were not.
                classified_keys: set[str] = set()
                for remaining in scopes[scope_index:]:
                    remaining_key = connector.scope_key(remaining)
                    if is_unresolvable_scope_key(remaining_key):
                        # PR #228 review, finding 3. `scope_key()` returned
                        # the `unresolvable-geography:` sentinel, which
                        # issue #177 introduced precisely so this scope is
                        # NOT confused with "no coverage" — its discover()
                        # raises UnresolvableGeographyError by construction,
                        # on this run and every future one.
                        #
                        # Calling that a budget casualty is wrong twice
                        # over: it tells an operator "more budget would have
                        # helped" when nothing ever will, and the
                        # connector_scope_state row it used to write made
                        # the dashboard promise the user "esta zona sí está
                        # cubierta, todavía no le ha tocado el turno" for a
                        # profile centre that matches no place in the
                        # gazetteer at all. So: its own reason, and no row —
                        # matching how the attempted path already treats
                        # this as a distinct third outcome
                        # (`any_scope_unresolvable`) rather than folding it
                        # into either existing bucket.
                        if remaining_key not in classified_keys:
                            classified_keys.add(remaining_key)
                            skipped_scopes.append(
                                {"scope": remaining_key, "reason": "unresolvable"}
                            )
                            error_msgs.append(
                                f"unresolvable geography (never reached this "
                                f"run — breaker already open): {remaining}"
                            )
                        continue
                    if remaining_key is None:
                        # Not a budget casualty: this scope would have been
                        # skipped as uncovered even on a completely healthy
                        # run, so labelling it "skipped for budget" would
                        # actively mislead. Recorded under the uncovered
                        # reason instead, matching the `scope_key() is None`
                        # branch below.
                        skipped_scopes.append(
                            {"scope": repr(remaining), "reason": "uncovered"}
                        )
                        continue
                    if remaining_key in seen_scope_keys:
                        # Already crawled earlier this same run under an
                        # equivalent scope (two profiles resolving to one
                        # city). Its data is present, so reporting it as
                        # starved would be wrong.
                        continue
                    if remaining_key in already_fresh_this_cycle:
                        # Issue #295 (D-050): already discovered earlier THIS
                        # CYCLE (a prior tick). Not starved for budget — its
                        # data is fresh for the current cycle, so it neither
                        # blocks completion nor needs a "covered but skipped"
                        # row. Classifying it as budget would misreport a done
                        # scope as waiting.
                        continue
                    if remaining_key in classified_keys:
                        # A second un-reached scope resolving to a key
                        # already reported as starved — one report, not two.
                        continue
                    classified_keys.add(remaining_key)
                    skipped_for_budget.append(remaining_key)
                    # The row this writes is what lets the dashboard say
                    # "covered, but hasn't had its turn yet" — a
                    # connector_scope_state row with a NULL
                    # last_attempted_at. Without it, a brand-new profile's
                    # covered-but-starved geography is indistinguishable
                    # from one no connector covers at all (no row either
                    # way).
                    _record_scope_covered_but_skipped(
                        conn,
                        connector.name,
                        remaining_key,
                        remaining,
                        datetime.now(timezone.utc),
                    )
                if skipped_for_budget:
                    budget_notes.append(
                        "no se cargaron más zonas por presupuesto de la "
                        "ejecución (circuit breaker ya abierto): "
                        + ", ".join(skipped_for_budget)
                    )
                    skipped_scopes.extend(
                        {"scope": key, "reason": "budget"} for key in skipped_for_budget
                    )
                # Issue #270 (D-047): a clean, expected outcome (we simply
                # didn't get to these zones this run), logged at INFO — not an
                # error. What tripped the breaker in the first place was already
                # logged (warning for soft-block, error for fatal) by the scope
                # that tripped it.
                logger.info(
                    "Connector %s: circuit breaker already open — skipping "
                    "remaining scopes this run (%d of %d not attempted, "
                    "clean budget stop)",
                    connector.name,
                    len(scopes) - scope_index,
                    len(scopes),
                )
                # Issue #217 hardening: these scopes were never attempted at
                # all — not even a failed discover() call, which at least
                # tries. Exactly the same "a partial union can't distinguish
                # gone from not-looked-at" hazard `_reconcile_missed_
                # discoveries`' docstring already establishes for a failed
                # scope (see the generic `except Exception` branch below,
                # which sets this same flag) — reconciliation must not run
                # against a union that's missing these scopes' listings
                # just because THIS run happened to reach its budget early.
                reconcilable_union = False
                break

            scope_key = connector.scope_key(scope)
            if scope_key is None:
                # Not a failure — this connector has no coverage for
                # wherever this scope is (e.g. a profile far from every
                # known city). Skipping it here, before ever calling
                # discover(), is what stops an unresolvable scope from
                # permanently marking the connector 'failed' every single
                # run (issue #71 review finding) — previously this reached
                # discover(), which raised ConnectorError, which this loop
                # caught as a genuine scope failure.
                #
                # Issue #177 (M3) hardening: `scope_key() is None` covers
                # two genuinely different situations that used to get the
                # identical log line — "nothing to resolve at all" (no
                # center/geography on the scope) and "resolved fine to a
                # REAL municipality, but this connector's own coverage
                # table doesn't have a slug for it" (e.g. a point inside a
                # small town the gazetteer knows but no connector's
                # `_CITY_SLUGS`-equivalent table lists). The second case is
                # a genuinely useful "resolved but uncovered" signal an
                # operator can act on (add the slug once it's live-verified
                # — see e.g. fotocasa.py's `_CITY_SLUGS` docstring); folding
                # it into the same message as "no geography info at all"
                # made it indistinguishable from a total non-event. Best
                # effort only: resolve_place() itself never raises here in
                # practice (a scope whose center is genuinely unresolvable
                # gets the `unresolvable_scope_key` sentinel from
                # scope_key(), not None — see that function's docstring),
                # but the guard costs nothing and keeps this path from
                # itself becoming a new way to blow up the loop.
                #
                # Issue #217: also recorded structurally, so the "uncovered"
                # half of the distinction this issue asked for doesn't depend
                # on a consumer parsing the prose below.
                skipped_scopes.append({"scope": repr(scope), "reason": "uncovered"})
                place = None
                if scope.center is not None:
                    try:
                        place = resolve_place(scope)
                    except UnresolvableGeographyError:
                        place = None
                if place is not None:
                    logger.warning(
                        "Connector %s: scope=%r resolved to %s/%s but this "
                        "connector's own coverage table has no entry for "
                        "it — skipping (resolved, just not covered by this "
                        "connector; not a failure)",
                        connector.name,
                        scope,
                        place.name,
                        place.province,
                    )
                    error_msgs.append(
                        f"resolved but uncovered: {scope} -> "
                        f"{place.name}/{place.province}"
                    )
                else:
                    logger.warning(
                        "Connector %s: scope=%r has no known coverage — "
                        "skipping (not a failure)",
                        connector.name,
                        scope,
                    )
                continue

            if scope_key in already_fresh_this_cycle:
                # Issue #295 (D-050): resume skip. This scope was already
                # discovered since the current cycle started (an earlier tick
                # covered it), so the cycle doesn't need to redo it — no
                # discover() call, no rate-limiter/breaker cost spent. Recorded
                # under the `fresh_this_cycle` reason (extending #217/D-030's
                # budget/uncovered/unresolvable vocabulary), logged at INFO,
                # never an error. Marked seen so any duplicate scope resolving to
                # the same key later this run is also treated as done. It still
                # counts toward completion — its connector_scope_state row
                # already has last_discovered_at >= cycle_started_at.
                seen_scope_keys.add(scope_key)
                skipped_scopes.append(
                    {"scope": scope_key, "reason": "fresh_this_cycle"}
                )
                logger.info(
                    "Connector %s: scope key=%r already discovered this "
                    "freshness cycle (since %s) — skipping (clean resume, not "
                    "an error)",
                    connector.name,
                    scope_key,
                    cycle_started_at,
                )
                continue

            if scope_key in seen_scope_keys:
                # Two active profiles resolved to the same real target
                # (e.g. two different Madrid-area profiles both landing on
                # "madrid-capital") — crawl it once, not once per profile.
                logger.info(
                    "Connector %s: scope=%r resolves to already-crawled "
                    "key=%r this run — skipping redundant crawl",
                    connector.name,
                    scope,
                    scope_key,
                )
                continue
            seen_scope_keys.add(scope_key)

            try:
                # Issue #217/D-030: this scope has now reached a real
                # attempt — persisted BEFORE calling run_connector (not
                # after) so a crash mid-scope still counts it as "looked at"
                # for next run's fairness ordering, and unconditionally (not
                # only on success) so a scope whose discover() keeps failing
                # doesn't also keep winning the front of the queue forever.
                #
                # PR #228 review, nit 6: this DB write lives INSIDE the
                # per-scope try. Outside it, a failure here (e.g. the
                # connection left in a failed-transaction state by an
                # earlier scope's DB error) propagated out of the
                # per-connector loop and killed the sweep for EVERY
                # connector — a strictly wider blast radius than before this
                # call existed, when the first DB touch after that handler
                # was inside run_connector and therefore contained per
                # scope. It is still the first thing that happens for this
                # scope, so the ordering guarantee above is unchanged.
                _record_scope_attempt(
                    conn, connector.name, scope_key, scope, datetime.now(timezone.utc)
                )
                result = run_connector(
                    conn,
                    connector,
                    scope,
                    limiter,
                    breaker,
                    min_refetch_interval_seconds=effective_min_refetch_interval_seconds,
                )
            except UnresolvableGeographyError as exc:
                # Issue #177 (M4): this is the sentinel path
                # `unresolvable_scope_key()` exists for — scope_key()
                # deliberately returned a non-None sentinel (instead of
                # None) so THIS scope reaches discover(), whose
                # resolve_place() call raises here, for a scope whose
                # center matches no place in the gazetteer at ALL. That is
                # a real, visible problem (a profile with a bogus/foreign
                # center) worth surfacing — but it is NOT the same kind of
                # failure as `run_connector` raising for any other reason
                # (network error, parse error, a genuine partial sweep of a
                # REAL area), and treating it identically double-counted
                # the damage:
                #
                #   1. It set `reconcilable_union = False` for the ENTIRE
                #      connector run, skipping withdrawal reconciliation
                #      for every OTHER scope too — even ones that resolved
                #      and crawled successfully this same run. But an
                #      unresolvable scope never had any real listings under
                #      it, in this run or any other, so its absence from
                #      `discovered_union` is not "a hole we can't account
                #      for" the way a failed real crawl is — there was
                #      never anything there to miss. `reconcilable_union`
                #      is deliberately left untouched here.
                #   2. It always set `any_scope_failed = True`, which (see
                #      the status precedence comment below) permanently
                #      marks the WHOLE connector 'failed' on every run for
                #      as long as the one bad profile stays active — even
                #      when every OTHER active profile resolves and crawls
                #      fine. That directly contradicts this same function's
                #      documented intent a few lines below ("an
                #      unresolvable-for-everyone connector must not end up
                #      permanently 'failed'"). `any_scope_unresolvable` is
                #      tracked separately: if nothing else succeeds this
                #      run either, the run is still reported 'failed' (see
                #      the status computation below) — this one bad scope
                #      just no longer holds hostage every OTHER scope's
                #      already-successful result.
                #
                # Always logged and always added to `error_msgs`
                # (unconditionally, not gated on the final status) so this
                # stays a VISIBLE outcome in connector_run_results.error_msg
                # even on an otherwise fully 'ok' run — never silently
                # dropped just because the rest of the connector's scopes
                # were fine.
                any_scope_unresolvable = True
                logger.error(
                    "Connector %s: scope=%r has an unresolvable geography "
                    "(matches no known place in the gazetteer at all) — "
                    "logged as a visible problem, not folded into a "
                    "generic connector failure: %s",
                    connector.name,
                    scope,
                    exc,
                )
                error_msgs.append(f"unresolvable geography {scope}: {exc}")
                continue
            except (
                Exception
            ) as exc:  # one scope's discover() failing shouldn't skip the rest
                # PR #228 review, nit 6: a DB-level failure leaves the
                # connection in a failed-transaction state, in which EVERY
                # subsequent statement — including the next scope's
                # `_record_scope_attempt` — raises until someone rolls back.
                # Best effort: this handler's job is to contain one scope's
                # failure, and it cannot do that while leaving the shared
                # connection unusable for the scopes after it.
                try:
                    conn.rollback()
                except Exception:
                    logger.exception(
                        "Connector %s: rollback after a failed scope=%r "
                        "itself failed — later scopes this run may not be "
                        "able to write",
                        connector.name,
                        scope,
                    )
                # A scope that didn't complete leaves a hole in the union: its
                # listings are absent not because they're gone but because we
                # never looked. Reconciling against a partial union would
                # withdraw them — true whether the cause was a genuine failure
                # or a soft-block backoff.
                reconcilable_union = False
                if isinstance(exc, SoftBlockError):
                    # Issue #270 (D-047): the site rate-throttled us at
                    # discover() time (e.g. Milanuncios' GeeTest wall). This is
                    # a clean "waited for budget" backoff, NOT a connector
                    # failure — do not set any_scope_failed. Recorded as a
                    # notice and, structurally, as a skipped scope with a
                    # soft-block reason so it stops looking like an error in the
                    # health surface.
                    budget_notes.append(
                        f"no se pudo cargar {scope} por bloqueo temporal del "
                        f"sitio (rate-throttling): {exc}"
                    )
                    skipped_scopes.append(
                        {"scope": repr(scope), "reason": "soft_block"}
                    )
                    logger.warning(
                        "Connector %s: discover() soft-blocked for scope=%r "
                        "(rate-throttling) — clean budget backoff, not a "
                        "failure: %s",
                        connector.name,
                        scope,
                        exc,
                    )
                    continue
                any_scope_failed = True
                logger.exception(
                    "Connector %s: discover() failed for scope=%r",
                    connector.name,
                    scope,
                )
                error_msgs.append(f"{scope}: {exc}")
                continue

            # PR #228 review, finding 1: run_connector returned without
            # raising, so a real discover() completed for this scope. Only
            # now may this scope be reported to a user as actually crawled —
            # `last_attempted_at` above says we tried, which is a different
            # claim and must not be rendered as this one.
            _record_scope_discovered(
                conn, connector.name, scope_key, datetime.now(timezone.utc)
            )

            discovered_total += result["discovered_count"]
            fetched_total += result["fetched_count"]
            skipped_fetch_total += result["skipped_count"]
            error_total += result["error_count"]
            soft_block_error_total += result["soft_block_error_count"]
            # Issue #270 (D-047): route a breaker trip by its cause. A fatal
            # trip (genuine failure burst) is surfaced as 'circuit_open'; a
            # soft-block trip (site rate-throttling) is a clean "waited for
            # budget" stop that keeps the status 'ok' with an informational
            # notice.
            if result["circuit_open"]:
                if result["circuit_open_by"] == "fatal":
                    any_fatal_circuit_open = True
                else:
                    budget_notes.append(
                        f"{scope_key}: se alcanzó el límite por bloqueo temporal "
                        f"del sitio (rate-throttling) tras "
                        f"{result['fetched_count']} descargas; el resto se "
                        f"reintentará en la próxima ejecución"
                    )
            discovered_union |= result["discovered_external_ids"]
            reconcilable_union = reconcilable_union and result["reconcilable"]
            scope_summaries.append(
                f"{scope_key}: discovered={result['discovered_count']} "
                f"fetched={result['fetched_count']} "
                f"skipped={result['skipped_count']} "
                f"gone={result['gone_count']} errors={result['error_count']}"
            )

        # Withdrawal reconciliation: once per connector per run, against
        # the union of every scope's ids. Doing it inside run_connector
        # (i.e. per scope) would mark every listing outside the current
        # scope as missed, because the sweep has no scope predicate — with
        # >=4 scopes that withdraws live inventory in a single run. See
        # _reconcile_missed_discoveries' docstring.
        if reconcilable_union and discovered_union:
            _reconcile_missed_discoveries(conn, connector.name, discovered_union)
        elif not reconcilable_union:
            logger.info(
                "Connector %s: skipping withdrawal reconciliation this run "
                "(a scope failed, was filtered, returned nothing, or the "
                "connector doesn't claim full inventory) — an incomplete "
                "union can't distinguish 'gone' from 'not looked at'",
                connector.name,
            )

        # connector_run_results.status CHECK only allows 'ok'/'failed'/
        # 'circuit_open' — there's no 'partial' value for "some scopes
        # failed, others didn't" without a schema migration, which is out
        # of scope for this hardening pass. Precedence, most-to-least
        # severe:
        #   1. any_scope_failed -> 'failed', ALWAYS, even if the breaker
        #      also tripped this run. Issue #71 review finding: the old
        #      precedence put circuit_open first, which could mask a
        #      genuine, unrelated scope failure behind "oh, it was just
        #      the circuit breaker" when both happened in the same run —
        #      a real failure must never be hidden behind a different,
        #      less-alarming status. "Failed" now means only GENUINE
        #      (fatal) failures: a discover() that raised anything other
        #      than a SoftBlockError. A soft-block backoff is NOT a failure
        #      (see #4).
        #   2. any_fatal_circuit_open (and no explicit failure) ->
        #      'circuit_open'. Issue #270 (D-047): ONLY a breaker trip driven
        #      by GENUINE fatal errors surfaces here — that is the "something
        #      is really wrong (site structure changed, network dead)" signal
        #      worth alarming on. A breaker trip driven by SOFT-BLOCKS (site
        #      rate-throttling) is deliberately NOT here — it is a clean
        #      "waited for budget" stop and falls through to 'ok' (#4) with an
        #      informational notice.
        #   3. any_scope_unresolvable (issue #177, M4) AND nothing else
        #      this run ever reached a successful `run_connector` call
        #      (`scope_summaries` empty) -> 'failed'. Every active scope
        #      this connector had was a dead end (either unresolvable-
        #      geography or some other failure/duplicate/no-coverage), so
        #      there is genuinely nothing to call 'ok' — this is also what
        #      keeps `test_unresolvable_geography_reaches_connector_run_
        #      results_as_failed`'s single-bad-profile scenario failing
        #      loudly, unchanged from before this fix.
        #   4. otherwise -> 'ok'. This covers "every attempted scope
        #      succeeded", "zero scopes were attempted because all of them
        #      were unresolvable/duplicate", AND (issue #270, D-047) every
        #      BUDGET/SOFT-BLOCK outcome: the breaker tripped on rate-throttle,
        #      a discover() hit a soft-block wall, or whole scopes were skipped
        #      because the (soft-block-tripped) breaker was already open. The
        #      owner's principle (#270): "waiting for budget is NOT an error —
        #      it's a clean run outcome, just a notice that we couldn't load
        #      more this time." A connector that ingested fine and then stopped
        #      because it spent its per-run budget must show green, not an error
        #      state, in the health UI — the reason is surfaced via the
        #      informational notice folded into error_msg below (and
        #      skipped_scopes), and the genuine fetch failures via error_count,
        #      never via a scary status. Also (issue #177, M4) "at least one
        #      scope succeeded even though a DIFFERENT scope had an
        #      unresolvable geography".
        # `scope_summaries`/`error_msgs` (folded into error_msg below) make
        # a mixed-outcome run distinguishable by inspection, even though
        # `status` itself can only be one of three values.
        if any_scope_failed:
            status = "failed"
        elif any_fatal_circuit_open:
            status = "circuit_open"
        elif any_scope_unresolvable and not scope_summaries:
            status = "failed"
        else:
            status = "ok"

        # Issue #270 (D-047): make explicit that error_count INCLUDES
        # soft-block (rate-throttle) fetch failures — they are genuine failed
        # fetches (counted for #291) even though the run status stays clean.
        # This keeps "error_count=7 but status ok" self-explanatory in the
        # health surface rather than looking contradictory.
        if soft_block_error_total:
            budget_notes.append(
                f"{soft_block_error_total} de {error_total} errores fueron "
                "bloqueos temporales del sitio (rate-throttling), no fallos del "
                "conector (ver #291)"
            )

        # Issue #270 (D-047): budget/soft-block notices are informational and
        # belong on the run REGARDLESS of status — a clean 'ok' run that hit
        # its budget must still tell the operator "no se cargaron más por
        # presupuesto". Prefixed so they read as notices, not errors, when the
        # UI shows error_msg. Emitted before "scopes ok:" so the headline
        # reason comes first.
        for note in budget_notes:
            error_msgs.append(f"nota: {note}")

        if status != "ok" and scope_summaries:
            # Only worth stating "these scopes were fine" when the overall
            # status is NOT a clean 'ok' — this is exactly what makes a
            # mixed-outcome run ("Madrid succeeded, Sevilla failed")
            # distinguishable from a total failure at a glance, without
            # cluttering error_msg on runs that have nothing to explain.
            error_msgs.append("scopes ok: " + " | ".join(scope_summaries))

        if status == "ok":
            ok += 1
        else:
            failed += 1
        _record_connector_result(
            conn,
            run_id,
            connector.name,
            status=status,
            discovered_count=discovered_total,
            fetched_count=fetched_total,
            skipped_count=skipped_fetch_total,
            error_count=error_total,
            error_msg="; ".join(error_msgs) or None,
            skipped_scopes=skipped_scopes,
            started_at=started_at,
            finished_at=datetime.now(timezone.utc),
        )

        # Issue #295 (D-050): cycle completion / stuck detection, after this
        # connector's per-scope loop has committed every _record_scope_discovered
        # for the scopes it covered this tick. If 100% of the live target scope
        # set has been discovered since cycle_started_at, the cycle is marked
        # fresh and cleared; otherwise it's left in progress for the next tick to
        # continue (and flagged stuck, never force-completed, past the threshold).
        # The run STATUS above is unchanged by this — a mid-cycle "continue" is a
        # perfectly normal run row (issue #295 §5); freshness state is a separate,
        # connector-level, non-error signal layered on top.
        _finalize_connector_freshness_cycle(
            conn,
            connector,
            cycle_started_at,
            scopes,
            datetime.now(timezone.utc),
            freshness_cycle_stuck_after_hours,
        )

    # Issue #285: the end-of-sweep bookkeeping (`_finish_connector_run`, the
    # dedup pass) and the re-materialize notify are wrapped so the notify runs
    # in a `finally`. Before this, a raise anywhere between the connector loop
    # and the notify — a `_finish_connector_run` failure, an unexpected raise
    # escaping the dedup guard — silently *skipped* the re-materialize, and
    # nothing retried it until the next successful sweep. That best-effort-but-
    # skippable notify is the likely real cause of the Estepona stale-profile
    # incident (D-044/D-046). The notify stays best-effort (a dashboard outage
    # must not fail an already-committed ingest); the `finally` only guarantees
    # it is *attempted* even when bookkeeping raises. The periodic staleness
    # reconciler (etl.materialize_reconciler, D-046) is the durable backstop for
    # the case where the notify is attempted here but the dashboard is down.
    try:
        _finish_connector_run(conn, run_id, ok, failed, skipped)

        # Issue #185: run dedup once per connector sweep, unconditionally — not
        # gated on this run having discovered anything, not gated on every
        # connector having succeeded. Two reasons this is the right place:
        #
        # 1. AFTER every connector's withdrawal reconciliation, never before or
        #    interleaved: reconciliation (_reconcile_missed_discoveries, inside
        #    the per-connector loop above) is what's allowed to *withdraw* a
        #    listing, and issue #25's occupancy assessment depends on duplicates
        #    already being consolidated by the time it runs. Running dedup here
        #    — after the whole connector loop, before `notify_materialize_all`
        #    — guarantees both orderings hold: reconciliation-before-dedup and
        #    dedup-before-assess.
        # 2. Dedup itself never withdraws anything — it only merges/suggests
        #    pairs of listings that already exist in the DB (see run_dedup's
        #    docstring) — so it's safe to run even when this sweep was partial
        #    (a circuit breaker tripped, a scope failed): an incomplete
        #    candidate set just means fewer pairs get compared this pass, never
        #    a false "these are gone" conclusion the way a partial withdrawal
        #    reconciliation would be. That asymmetry is why dedup does NOT need
        #    an equivalent to `reconcilable_union` gating it.
        #
        # Wrapped in try/except, same posture as notify_materialize_all in the
        # `finally` below: a dedup bug must not retroactively turn an
        # already-committed, successful connector sweep into a failed run.
        try:
            run_dedup(
                conn,
                trigger=trigger,
                connector_run_id=run_id,
                dedup_max_runtime_seconds=dedup_max_runtime_seconds,
            )
        except Exception:
            logger.warning(
                "Dedup run raised unexpectedly — connector sweep is committed "
                "and the run record is final; continuing",
                exc_info=True,
            )
    finally:
        # Issue #94: a completed run used to leave freshly-ingested properties
        # unscored indefinitely — `scoreNewCandidates`/`materializeProfile` were
        # only ever reachable from two dashboard-side API routes, so nothing
        # scored a new listing until a human clicked something. Notify the
        # dashboard now that the run's bookkeeping is committed.
        #
        # Deliberately AFTER _finish_connector_run and dedup (issue #25: assess
        # only after duplicates are consolidated) — but in a `finally` (issue
        # #285) so that even a raise in that bookkeeping still ATTEMPTS the
        # re-materialize instead of silently skipping it and stranding every
        # active profile at stale data until the next successful sweep (the
        # likely Estepona cause — D-044/D-046). The connector run's own record
        # is already durable by the time we get here, so this outbound HTTP call
        # can hang or fail without retroactively making a successful ingest look
        # like a failed run.
        #
        # notify_materialize_all() already swallows its own failures, so this
        # guard is belt-and-braces: it keeps an unexpected bug (or a test
        # double) in the notifier from propagating out of this `finally` and
        # masking whatever the `try` was already raising, or destroying an
        # already-committed run's return value.
        try:
            notify_materialize_all(trigger=trigger)
        except Exception:
            logger.warning(
                "materialize-all notification raised unexpectedly — ingest is "
                "committed and the run record is final; continuing",
                exc_info=True,
            )

    return run_id


def notify_materialize_all(trigger: str = "scheduler") -> bool:
    """POST the dashboard's materialize-all endpoint after a connector run.

    Cross-service by necessity: the connector orchestrator is Python and the
    hard-filter/scoring pipeline is TypeScript inside the dashboard
    container, so this is an HTTP call over the compose network rather than
    a direct function call. `materialize.ts`'s own docstring already named
    this exact design as the intended follow-up.

    Never raises. Ingest has already succeeded and been committed by the
    time this runs; a materialize/scoring failure is a *degraded* outcome
    (candidates render unscored, which the UI handles gracefully — task 3.3)
    rather than a correctness problem worth failing the run over. This
    mirrors the log-and-swallow discipline `materializeProfile` already
    applies to its own `scoreNewCandidates` call, and the scheduler loop's
    per-iteration isolation.

    Safe to retry/overlap: materialization is idempotent (an upsert plus a
    full recompute of the match set) and re-scoring an already-scored
    candidate reproduces the same number, so a duplicate or retried call
    cannot corrupt state — it just recomputes the same answer.

    Returns True when the dashboard acknowledged the call, False on any
    failure or when the callback is disabled by configuration.
    """
    # Imported lazily so importing this module never requires `requests` or a
    # valid config — several orchestrator tests construct scopes and run
    # connectors against a stripped environment.
    import requests

    from etl.config import Config

    try:
        cfg = Config()
    except Exception:
        logger.warning(
            "materialize-all notification skipped: ETL config unavailable",
            exc_info=True,
        )
        return False

    base_url = cfg.dashboard_base_url.rstrip("/")
    if not base_url:
        logger.info(
            "materialize-all notification disabled (etl.dashboard_base_url is empty) — "
            "newly ingested listings stay unscored until a manual materialize"
        )
        return False

    url = f"{base_url}/api/profiles/materialize-all"
    headers = {"content-type": "application/json"}
    if cfg.admin_api_key:
        headers["x-admin-key"] = cfg.admin_api_key
    else:
        # The endpoint fails closed when ADMIN_API_KEY is unset, so this call
        # will 401. Warn rather than silently no-op: an operator who set up
        # the ETL without the shared key needs to know why scoring stopped.
        logger.warning(
            "ADMIN_API_KEY not set for the ETL container — the materialize-all "
            "notification will be rejected (401) and newly ingested listings "
            "will stay unscored"
        )

    try:
        response = requests.post(
            url,
            headers=headers,
            json={"trigger": trigger},
            timeout=cfg.dashboard_callback_timeout_seconds,
        )
    except Exception as exc:  # noqa: BLE001 — see below
        # Deliberately broad. `requests` raises a wide family of errors
        # (RequestException subclasses, plus socket/SSL/DNS errors that leak
        # through as OSError), and a *new* unanticipated one must still not
        # take down a run whose data is already committed. The correct
        # behaviour for every possible failure here is identical: log it,
        # degrade to unscored candidates, carry on.
        logger.warning(
            "materialize-all notification to %s failed (%s) — ingest is "
            "committed and unaffected; candidates will be scored on the next "
            "successful run or a manual trigger",
            url,
            exc,
        )
        return False

    if response.status_code == 401:
        logger.warning(
            "materialize-all notification to %s rejected: 401 unauthorized. "
            "The ETL's ADMIN_API_KEY must match the dashboard's.",
            url,
        )
        return False

    if not response.ok:
        logger.warning(
            "materialize-all notification to %s returned HTTP %s — ingest is "
            "committed and unaffected",
            url,
            response.status_code,
        )
        return False

    logger.info("materialize-all notification to %s acknowledged", url)
    return True


# Runs in these connector_runs.status values are genuinely finished — used
# by the restart-burst guard (issue #172) to find when ingestion last
# actually completed. 'running' is deliberately excluded: a still-in-flight
# (or crashed-and-not-yet-reconciled, see _reconcile_stale_runs) row says
# nothing about when a sweep last finished, and including it would let an
# in-progress run make the guard think a completion just happened.
_COMPLETED_RUN_STATUSES = ("success", "partial", "failed")


def last_completed_run_finished_at(conn) -> datetime | None:
    """Most recent `connector_runs.finished_at` among genuinely completed runs.

    None when no run has ever completed (a fresh install) — the guard
    below treats that the same as "long enough ago", since there is no
    prior sweep for a burst of restarts to be re-sweeping too soon after.

    `AND finished_at IS NOT NULL` (Opus review, PR #175 also-fix) matters
    beyond defensive redundancy: Postgres' default `ORDER BY ... DESC`
    sorts NULLs *first*, not last, so a single completed-status row with a
    NULL `finished_at` (a `connector_runs` insert that set `status`
    without also setting `finished_at` — a bug elsewhere, or a future
    schema change) would sort ahead of every real completion and make
    this function return `None` forever, permanently disabling the guard
    rather than merely miscounting one row.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT finished_at FROM connector_runs "
            "WHERE status = ANY(%s) AND finished_at IS NOT NULL "
            "ORDER BY finished_at DESC LIMIT 1",
            (list(_COMPLETED_RUN_STATUSES),),
        )
        row = cur.fetchone()
    return row[0] if row else None


def should_skip_immediate_sweep(
    conn, min_restart_sweep_interval_seconds: int
) -> tuple[bool, datetime | None]:
    """Whether a startup/`--once` sweep should be skipped (issue #172).

    Context: `run_scheduler_loop` (and `--once`) sweeps every connector
    immediately, not just on the hourly schedule — intentional and useful
    after a genuine gap (the container was down for hours), but combined
    with `restart: unless-stopped` it means a crash-loop hammers every
    connector's site again on every restart attempt, with no rate-limiter
    memory surviving the restart (`RateLimiter`/`CircuitBreaker` are
    constructed fresh per `run_all_connectors` call — issue #71). Two of
    the first four spiked bank-portal connectors already sit behind
    edge-level WAFs; a self-inflicted request burst from a crash loop is
    exactly the kind of good-neighbor-crawling violation issue #1 §15
    exists to prevent, and it is nobody's *deliberate* aggressive crawl —
    that is what makes it dangerous, no human decision point to catch it.

    True only when a completed run (see `last_completed_run_finished_at`)
    finished more recently than `min_restart_sweep_interval_seconds` ago —
    the signature of a restart-loop re-attempting within seconds/minutes
    of the previous attempt, not a genuine gap since the last sweep. A
    non-positive threshold disables the guard outright (always False) —
    an explicit operator opt-out, not a special case to code around.

    Clock skew (Opus review, PR #175 also-fix): `elapsed` compares
    Python's `datetime.now(timezone.utc)` (this process' clock) against a
    `finished_at` written by Postgres' own `NOW()` (the DB server's
    clock) — two different clocks. If the DB server's clock is ever ahead
    of this process' clock, `finished_at` can land in this process'
    future, making `elapsed` negative. A negative `elapsed` is always
    `< min_restart_sweep_interval_seconds` (for any non-negative
    threshold), so an un-clamped comparison would treat clock skew as "a
    sweep juuust finished" and skip — and because this guard is
    re-evaluated, the wedge lasts exactly as long as the skew itself.
    Clamped to "never skip" instead: a negative elapsed carries no
    genuine restart-burst signal, only a clock discrepancy, and "run" is
    the safe direction on the same reasoning `should_skip_immediate_sweep`
    already uses for "no prior run" and "guard disabled".
    """
    if min_restart_sweep_interval_seconds <= 0:
        return False, None
    last_finished = last_completed_run_finished_at(conn)
    if last_finished is None:
        return False, None
    elapsed = (datetime.now(timezone.utc) - last_finished).total_seconds()
    if elapsed < 0:
        return False, last_finished
    return elapsed < min_restart_sweep_interval_seconds, last_finished


def run_all_connectors_respecting_restart_guard(
    conn,
    trigger: str = "scheduler",
    *,
    min_restart_sweep_interval_seconds: int = 0,
    dedup_max_runtime_seconds: int = _DEFAULT_DEDUP_MAX_RUNTIME_SECONDS,
    default_freshness_interval_hours: int = _DEFAULT_FRESHNESS_INTERVAL_HOURS,
    freshness_cycle_stuck_after_hours: int = _DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS,
) -> int | None:
    """`run_all_connectors()`, unless the restart-burst guard (issue #172)
    says this sweep is too soon after the last completed one.

    Returns the new `connector_runs` id, or `None` when skipped — nothing
    was created this call, so callers (and tests) can tell "ran" from
    "skipped" without re-deriving it from logs.

    Only ever wired to a *full* sweep (no `connector_name` filter) — see
    `etl/main.py`'s `--once` handling: an operator explicitly naming one
    connector via `ps connector run <name>` is a deliberate, targeted
    action, not the unattended crash-loop scenario this guard exists for.
    `run_all_connectors` itself is unaffected and untouched — tests and
    any other direct caller keep today's unconditional-sweep behavior.
    """
    skip, last_finished = should_skip_immediate_sweep(
        conn, min_restart_sweep_interval_seconds
    )
    if skip:
        assert last_finished is not None  # skip=True only when a run was found
        elapsed = (datetime.now(timezone.utc) - last_finished).total_seconds()
        logger.warning(
            "Skipping immediate connector sweep: the last completed run "
            "finished at %s (%.0fs ago), under the "
            "min_restart_sweep_interval_seconds=%ds threshold. This reads "
            "as a rapid restart (crash-loop), not a genuine gap since the "
            "last sweep — no request is being made to any connector's site "
            "for this trigger. Waiting for the next scheduled interval "
            "instead.",
            last_finished,
            elapsed,
            min_restart_sweep_interval_seconds,
        )
        return None
    return run_all_connectors(
        conn,
        trigger=trigger,
        dedup_max_runtime_seconds=dedup_max_runtime_seconds,
        default_freshness_interval_hours=default_freshness_interval_hours,
        freshness_cycle_stuck_after_hours=freshness_cycle_stuck_after_hours,
    )


def run_scheduler_loop(
    conn_factory,
    interval_seconds: int = 3600,
    min_restart_sweep_interval_seconds: int = 0,
    dedup_max_runtime_seconds: int = _DEFAULT_DEDUP_MAX_RUNTIME_SECONDS,
    default_freshness_interval_hours: int = _DEFAULT_FRESHNESS_INTERVAL_HOURS,
    freshness_cycle_stuck_after_hours: int = _DEFAULT_FRESHNESS_CYCLE_STUCK_AFTER_HOURS,
) -> None:
    """Run all connectors on a fixed interval, forever. Long-running-container mode.

    Each iteration is isolated: a transient failure (DB connection drop,
    deadlock, an unexpected exception anywhere in run_all_connectors) is
    logged and the loop continues to the next scheduled iteration, rather
    than propagating and killing the long-running container process. The
    alternative — letting the process die — turns one bad hour into total
    ingestion downtime until something notices the container exited.

    `min_restart_sweep_interval_seconds` (issue #172) is applied on the
    FIRST iteration only (Opus review, PR #175 must-fix — this used to be
    applied on every iteration; see below for why that wedged). The
    restart-burst guard's whole premise is "a fresh process just started
    — is that because of a genuine gap, or a crash-loop restarting
    seconds after the last attempt?" That question only makes sense for
    the process's own first sweep. Every iteration after the first is
    already paced `interval_seconds` apart by the `sleep` below, within
    this *same* long-running process — there is no restart to be
    suspicious of, so nothing here should be able to skip a scheduled
    sweep.

    The previous unconditional version broke exactly there: it re-ran
    `should_skip_immediate_sweep` every iteration, comparing "how long
    since the last completed run" against the *same* threshold every
    time. That threshold is operator-configured
    (`etl.min_restart_sweep_interval_seconds` /
    `ETL_MIN_RESTART_SWEEP_INTERVAL_SECONDS`, config/schema.yaml declares
    no maximum) completely independently of `interval_seconds` (a
    hard-coded 3600 in etl/main.py, invisible from the config UI) — so
    nothing prevented an operator from picking a threshold >=
    `interval_seconds`. The moment they did (measured: threshold=7200,
    hourly interval), every iteration's own sweep became the "last
    completed run" the *next* iteration's guard check saw — always under
    the threshold, always skipped, forever, one `logger.warning` per
    hour, with ingestion permanently stopped until the container
    restarted with a smaller threshold. Restricting the guard to the
    first iteration removes the possibility structurally: only the very
    first iteration can ever compare against a *prior* process' last run,
    so every later iteration always sweeps, regardless of how the
    threshold compares to the interval.
    """
    first_iteration = True
    while True:
        conn = conn_factory()
        try:
            # Run lock (issue #244): the ad-hoc manual-trigger poll loop
            # (etl/manual_trigger.py) runs in a separate thread and can start a
            # sweep at any moment. Both take this same advisory lock so a
            # scheduled sweep and a manual one never run concurrently and
            # double-write the same listings. If the manual loop is mid-run,
            # skip this tick and let the next interval retry — the manual run
            # is doing the same work anyway.
            if not postgres.try_acquire_run_lock(conn):
                logger.warning(
                    "Scheduler sweep skipped this iteration: a manual (or other) "
                    "connector run holds the run lock. Retrying next interval."
                )
            else:
                try:
                    if first_iteration:
                        run_all_connectors_respecting_restart_guard(
                            conn,
                            trigger="scheduler",
                            min_restart_sweep_interval_seconds=min_restart_sweep_interval_seconds,
                            dedup_max_runtime_seconds=dedup_max_runtime_seconds,
                            default_freshness_interval_hours=default_freshness_interval_hours,
                            freshness_cycle_stuck_after_hours=freshness_cycle_stuck_after_hours,
                        )
                    else:
                        # Not the process' first sweep — paced by this same
                        # loop's own `sleep(interval_seconds)` below, so the
                        # restart-burst guard has nothing to protect against
                        # here. See docstring.
                        run_all_connectors(
                            conn,
                            trigger="scheduler",
                            dedup_max_runtime_seconds=dedup_max_runtime_seconds,
                            default_freshness_interval_hours=default_freshness_interval_hours,
                            freshness_cycle_stuck_after_hours=freshness_cycle_stuck_after_hours,
                        )
                finally:
                    postgres.release_run_lock(conn)
        except Exception:
            logger.exception(
                "run_all_connectors failed for this scheduler iteration — "
                "will retry at the next interval rather than exit"
            )
        finally:
            conn.close()
        first_iteration = False
        time.sleep(interval_seconds)
