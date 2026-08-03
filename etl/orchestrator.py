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
from datetime import datetime, timezone
from decimal import Decimal

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorScope,
)
from etl.connectors.circuit_breaker import CircuitBreaker
from etl.connectors.rate_limit import RateLimiter

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

# Postgres' auto-generated name for listing's UNIQUE (source, external_id)
# — the one unique violation `_upsert_canonical_listing` knows how to
# recover from (a concurrent run won the insert race). See the narrowed
# handler there for why any other violation must propagate instead.
_LISTING_SOURCE_EXTERNAL_ID_CONSTRAINT = "listing_source_external_id_key"


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
) -> None:
    """`skipped_count` (issue #143) is listings this connector's run left
    unfetched under the skip-if-seen policy — "known, still there per
    discover(), deliberately not re-fetched" — distinct from
    `connector_runs.connectors_skipped` (issue #99), which counts whole
    *connectors* skipped via `connector_config.enabled = false`. The two
    are skip in different senses at different granularities; see each
    column's comment in etl/schema/init.sql.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connector_run_results
                (run_id, connector_name, started_at, finished_at, status,
                 discovered_count, fetched_count, error_count, error_msg,
                 skipped_count)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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


def _fetch_freshness_map(
    conn, source: str, external_ids: list[str]
) -> dict[str, tuple[datetime | None, Decimal | None]]:
    """Batched (last_fetched_at, current_price) lookup for skip-if-seen.

    One query per (connector, scope) rather than one per listing — issue
    #143 exists because per-listing framework overhead was already the
    problem being solved; an N+1 query here would just move the cost
    instead of removing it, and matters most for exactly the connectors
    (large bank-portal batches) this policy is meant to help.
    """
    if not external_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT external_id, last_fetched_at, current_price FROM listing "
            "WHERE source = %s AND external_id = ANY(%s)",
            (source, external_ids),
        )
        return {row[0]: (row[1], row[2]) for row in cur.fetchall()}


def _should_skip_fetch(
    *,
    last_fetched_at: datetime | None,
    stored_price: Decimal | None,
    discovery_price: Decimal | None,
    min_refetch_interval_seconds: int,
    now: datetime,
) -> tuple[bool, str]:
    """Skip-if-seen policy (issue #143): should fetch_detail() run for this
    already-known external_id, or is it safe to skip this run?

    Each check below is a reason to force a re-fetch regardless of how
    "fresh" the listing otherwise looks — staleness age is the last
    resort, not the primary signal, because the two things skip-if-seen
    must never silently break (price-drop detection, #34; withdrawal
    detection, EC-5) are both driven by data this function can see:

    1. Never fetched before -> always fetch. A `listing` row can exist
       without a real detail fetch ever having happened for it (the
       browser-extension capture path, issue #75, or a future backfill) —
       treating that the same as "recently fetched" would leave such a
       row permanently unpopulated the moment any connector enables a
       non-zero window.
    2. `min_refetch_interval_seconds <= 0` -> always fetch. The feature is
       off for this connector (the default for every connector unless it
       opts in — see `Connector.min_refetch_interval_seconds`); this is
       what keeps every existing connector's behaviour byte-identical to
       before issue #143 unless someone deliberately turns it on.
    3. Stored `current_price` is NULL -> always fetch. A core field never
       having been captured is worth paying to backfill rather than
       leaving silently empty forever behind a staleness window.
    4. Discovery-time price disagrees with the stored price -> always
       fetch, however recently it was last fetched. This is the guard
       against issue #143's central risk: a connector that supplies a
       discovery-time price (`Connector.discovered_prices`) gets a real
       price change detected on the very next sweep, not after the
       staleness window happens to expire.
    5. Otherwise, skip only once `min_refetch_interval_seconds` has
       genuinely elapsed since the last real fetch.

    Returns `(skip, reason)` — `reason` is always populated, including
    when `skip=False`, so the caller can log *why* a fetch happened, not
    only why one didn't (the issue's "record what it skipped and why"
    requirement applies just as much to "and why NOT" for an operator
    trying to understand a run).
    """
    if last_fetched_at is None:
        return False, "never fetched before"
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
    circuit_open = False

    # Issue #143: one batched lookup for the whole scope rather than one
    # query per listing — skipped entirely when the feature is off for this
    # connector (the common case today), so a connector that hasn't opted
    # into skip-if-seen doesn't pay even one extra query for it.
    freshness = (
        _fetch_freshness_map(conn, connector.name, external_ids)
        if min_refetch_interval_seconds > 0
        else {}
    )

    for external_id in external_ids:
        if breaker.tripped:
            circuit_open = True
            logger.error(
                "Connector %s: circuit breaker open after %d/%d errors — "
                "aborting remaining %d of %d discovered listings",
                connector.name,
                breaker.errors,
                breaker.attempts,
                len(external_ids) - fetched - errors - skipped,
                len(external_ids),
            )
            break

        last_fetched_at, stored_price = freshness.get(external_id, (None, None))
        skip, reason = _should_skip_fetch(
            last_fetched_at=last_fetched_at,
            stored_price=stored_price,
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
        "skipped_count": skipped,
        "error_count": errors,
        "circuit_open": circuit_open,
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
        cur.execute("SELECT id, scope FROM search_profile WHERE archived_at IS NULL")
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


def run_all_connectors(
    conn, trigger: str = "scheduler", connector_name: str | None = None
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
        if not scopes:
            # Same posture issue #71 established for "no active profiles":
            # not an error, nothing to record — just genuinely nothing for
            # this connector to do this run (no override, and no active
            # profile's geography resolves to its coverage).
            logger.warning(
                "Connector %s: no scopes to discover this run (no "
                "connector_config override and no active search profile "
                "reaches its coverage) — skipping",
                connector.name,
            )
            continue

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
        any_circuit_open = False
        any_scope_failed = False
        scope_summaries: list[str] = []
        error_msgs: list[str] = []

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
        )
        seen_scope_keys: set[str] = set()
        # Withdrawal reconciliation runs once per connector per run,
        # against the union of every scope's discovered ids — never per
        # scope (see _reconcile_missed_discoveries' docstring: the sweep
        # has no scope predicate, so per-scope reconciliation withdraws
        # other scopes' live listings). `reconcilable_union` stays True
        # only while every scope processed so far was a safe contributor.
        discovered_union: set[str] = set()
        reconcilable_union = True

        for scope_index, scope in enumerate(scopes):
            if breaker.tripped:
                # Already tripped from an earlier scope in this same run —
                # every remaining scope for this connector gets skipped
                # outright, not attempted and immediately aborted. This is
                # what "shared across scopes" actually buys: without it,
                # each scope got its own fresh, untripped breaker.
                any_circuit_open = True
                logger.error(
                    "Connector %s: circuit breaker already open — skipping "
                    "remaining scopes this run (%d of %d not attempted)",
                    connector.name,
                    len(scopes) - scope_index,
                    len(scopes),
                )
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
                logger.warning(
                    "Connector %s: scope=%r has no known coverage — "
                    "skipping (not a failure)",
                    connector.name,
                    scope,
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
                result = run_connector(
                    conn,
                    connector,
                    scope,
                    limiter,
                    breaker,
                    min_refetch_interval_seconds=effective_min_refetch_interval_seconds,
                )
            except (
                Exception
            ) as exc:  # one scope's discover() failing shouldn't skip the rest
                any_scope_failed = True
                # A failed scope leaves a hole in the union: its listings
                # are absent not because they're gone but because we never
                # looked. Reconciling against a partial union would
                # withdraw them.
                reconcilable_union = False
                logger.exception(
                    "Connector %s: discover() failed for scope=%r",
                    connector.name,
                    scope,
                )
                error_msgs.append(f"{scope}: {exc}")
                continue

            discovered_total += result["discovered_count"]
            fetched_total += result["fetched_count"]
            skipped_fetch_total += result["skipped_count"]
            error_total += result["error_count"]
            any_circuit_open = any_circuit_open or result["circuit_open"]
            discovered_union |= result["discovered_external_ids"]
            reconcilable_union = reconcilable_union and result["reconcilable"]
            scope_summaries.append(
                f"{scope_key}: discovered={result['discovered_count']} "
                f"fetched={result['fetched_count']} "
                f"skipped={result['skipped_count']} errors={result['error_count']}"
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
        #      less-alarming status.
        #   2. any_circuit_open (and no explicit failure) -> 'circuit_open'.
        #   3. otherwise -> 'ok'. This covers both "every attempted scope
        #      succeeded" AND "zero scopes were attempted because all of
        #      them were unresolvable/duplicate" — neither is a failure;
        #      a connector doing nothing because no active profile falls
        #      in its coverage area is a normal, expected outcome, not an
        #      error condition (this is what issue #71's review flagged:
        #      an unresolvable-for-everyone connector must not end up
        #      permanently 'failed').
        # `scope_summaries`/`error_msgs` (folded into error_msg below) make
        # a mixed-outcome run distinguishable from a total failure/total
        # no-op by inspection, even though `status` itself can only be one
        # of three values.
        if any_scope_failed:
            status = "failed"
        elif any_circuit_open:
            status = "circuit_open"
        else:
            status = "ok"

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
            started_at=started_at,
            finished_at=datetime.now(timezone.utc),
        )

    _finish_connector_run(conn, run_id, ok, failed, skipped)

    # Issue #94: a completed run used to leave freshly-ingested properties
    # unscored indefinitely — `scoreNewCandidates`/`materializeProfile` were
    # only ever reachable from two dashboard-side API routes, so nothing
    # scored a new listing until a human clicked something. Notify the
    # dashboard now that the run's bookkeeping is committed.
    #
    # Deliberately AFTER _finish_connector_run, never inside it: the run's
    # own record must already be durable before an outbound HTTP call that
    # can hang or fail. A callback failure must not retroactively make a
    # successful ingest look like a failed run.
    #
    # notify_materialize_all() already swallows its own failures, so this
    # guard is belt-and-braces: it keeps an unexpected bug (or a test double)
    # in the notifier from destroying an already-committed run's return
    # value, which is what callers use to look the run up afterwards.
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
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT finished_at FROM connector_runs "
            "WHERE status = ANY(%s) ORDER BY finished_at DESC LIMIT 1",
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
    """
    if min_restart_sweep_interval_seconds <= 0:
        return False, None
    last_finished = last_completed_run_finished_at(conn)
    if last_finished is None:
        return False, None
    elapsed = (datetime.now(timezone.utc) - last_finished).total_seconds()
    return elapsed < min_restart_sweep_interval_seconds, last_finished


def run_all_connectors_respecting_restart_guard(
    conn,
    trigger: str = "scheduler",
    *,
    min_restart_sweep_interval_seconds: int = 0,
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
    return run_all_connectors(conn, trigger=trigger)


def run_scheduler_loop(
    conn_factory,
    interval_seconds: int = 3600,
    min_restart_sweep_interval_seconds: int = 0,
) -> None:
    """Run all connectors on a fixed interval, forever. Long-running-container mode.

    Each iteration is isolated: a transient failure (DB connection drop,
    deadlock, an unexpected exception anywhere in run_all_connectors) is
    logged and the loop continues to the next scheduled iteration, rather
    than propagating and killing the long-running container process. The
    alternative — letting the process die — turns one bad hour into total
    ingestion downtime until something notices the container exited.

    `min_restart_sweep_interval_seconds` (issue #172, default 0 = guard
    off) is applied on every iteration, not just the first: within one
    long-running process this can never trigger except by a bug (each
    iteration is already paced `interval_seconds` apart by the `sleep`
    below), and applying it unconditionally — rather than special-casing
    "first iteration" — is what makes the guard's actual target, a fresh
    process spun up by a container restart, hit the same code path with
    no extra state to keep in sync.
    """
    while True:
        conn = conn_factory()
        try:
            run_all_connectors_respecting_restart_guard(
                conn,
                trigger="scheduler",
                min_restart_sweep_interval_seconds=min_restart_sweep_interval_seconds,
            )
        except Exception:
            logger.exception(
                "run_all_connectors failed for this scheduler iteration — "
                "will retry at the next interval rather than exit"
            )
        finally:
            conn.close()
        time.sleep(interval_seconds)
