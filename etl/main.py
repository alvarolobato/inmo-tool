"""ETL main entrypoint — connector orchestrator.

Connects to Postgres, applies the schema, then runs every registered
connector once (--once) or on a recurring interval (long-running container
mode). The connector framework lands in Phase 1.3 (issue #11); no real
connector is registered yet (etl.orchestrator.CONNECTORS is empty until
Phase 1.4, issue #12) — that's a supported, tested state, not a stub: this
process still connects, applies schema, and runs a (currently empty)
connector sweep cleanly.

Usage:
    python -m etl.main --once       # connect, init schema, run once, exit
    python -m etl.main              # connect, init schema, then loop hourly
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
from pathlib import Path

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO,
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("etl")

_SCHEMA_SQL_PATH = Path(__file__).parent / "schema" / "init.sql"
_RUN_INTERVAL_SECONDS = 3600


def _init_schema(conn_pg) -> None:
    """Execute etl/schema/init.sql against PostgreSQL (idempotent — IF NOT EXISTS).

    init.sql now defines the real property/listing/profile model (Phase 1.2,
    issue #10) alongside the pre-existing dashboard/LLM/ETL-observability
    infrastructure tables inherited from the source project (dashboards,
    conversations, llm_*, etl_sync_runs, etc.) — those are left untouched
    here since later phases still depend on them as-is.
    """
    sql = _SCHEMA_SQL_PATH.read_text(encoding="utf-8")
    with conn_pg.cursor() as cur:
        cur.execute(sql)
    conn_pg.commit()
    logger.info("Schema initialised (init.sql applied)")


def main() -> None:
    parser = argparse.ArgumentParser(description="inmo-tool ETL orchestrator")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Connect, init schema, run every registered connector once, and exit "
        "(default: loop hourly, for the long-running container)",
    )
    parser.add_argument(
        "--connector",
        metavar="NAME",
        default=None,
        help="Restrict --once to a single registered connector by name "
        "(task 1.5, #13 — backs `ps connector run <name>`). Ignored in "
        "long-running loop mode: the scheduler always runs every connector.",
    )
    args = parser.parse_args()

    from etl.config import Config

    try:
        config = Config()
    except ValueError as exc:
        logger.error("Configuration error: %s", exc)
        sys.exit(1)

    from etl.db import postgres

    logger.info("Connecting to PostgreSQL ...")
    try:
        conn_pg = postgres.get_connection(config)
        logger.info("PostgreSQL connection OK")
    except Exception as exc:  # noqa: BLE001 — top-level boundary, any connection failure exits
        logger.error("Cannot connect to PostgreSQL: %s", exc)
        sys.exit(1)

    try:
        _init_schema(conn_pg)
    except Exception:
        logger.exception("Schema initialisation failed")
        conn_pg.close()
        sys.exit(1)

    import etl.connectors
    from etl import orchestrator

    etl.connectors.register_all()  # registers real connectors (task 1.4) — see module docstring for why this is a deferred call, not an import-time side effect

    # Orphan reconciliation at startup (D-036): a dedup pass killed mid-run by
    # a container restart/OOM/SIGKILL leaves its `dedup_runs` row stuck at
    # status='running' forever. Clean any such dead row up front — before the
    # first sweep — so `ps dedup status` and monitors never show a phantom
    # "still running" pass from a process that no longer exists. Age-based
    # (older than dedup_max_runtime_seconds), so a run genuinely in flight from
    # another process is never touched. Best-effort: a failure here must not
    # stop the ETL from starting.
    try:
        orchestrator._reconcile_orphaned_dedup_runs(
            conn_pg, config.dedup_max_runtime_seconds
        )
    except Exception:
        logger.exception(
            "Startup orphaned-dedup-run reconciliation failed — continuing; "
            "the next dedup pass reconciles again (D-036)"
        )
        conn_pg.rollback()

    # Publish the registry for the connector-management UI (issue #100) and
    # seed a disabled connector_config row for any connector that lacks one.
    #
    # NOT best-effort any more (issue #100 review): that seeding is what makes
    # a brand-new connector born disabled, and `_scopes_for_connector` treats a
    # *missing* row as enabled (issue #71's default). So if this fails, the
    # rows don't exist, and a sweep would ingest a whole city from a connector
    # the operator never enabled — precisely what the disabled-by-default rule
    # exists to prevent. Skip the sweep instead and let the next restart retry;
    # not ingesting is always the safe direction here.
    registry_synced = False
    try:
        orchestrator.sync_connector_registry(conn_pg)
        registry_synced = True
    except Exception:
        logger.exception(
            "connector_registry sync failed — skipping this startup's connector "
            "sweep entirely, because connectors whose connector_config row was "
            "never seeded would otherwise run enabled-by-default. The connector "
            "management UI may also show a stale list until the next restart."
        )
        conn_pg.rollback()

    if not orchestrator.CONNECTORS:
        logger.warning(
            "No connectors registered yet — see Phase 1.4 (issue #12). "
            "Running an empty sweep (proves the loop itself works)."
        )

    if args.once:
        try:
            if registry_synced:
                if args.connector is None:
                    # Full sweep: the restart-burst guard applies (issue
                    # #172) — `ps connector run` with no name is exactly
                    # the command a restart/crash-loop scenario would
                    # trigger repeatedly.
                    orchestrator.run_all_connectors_respecting_restart_guard(
                        conn_pg,
                        trigger="cli",
                        min_restart_sweep_interval_seconds=(
                            config.min_restart_sweep_interval_seconds
                        ),
                        dedup_max_runtime_seconds=config.dedup_max_runtime_seconds,
                    )
                else:
                    # A named single-connector run is a deliberate,
                    # targeted operator action, not the unattended-restart
                    # scenario the guard exists for — never gated.
                    orchestrator.run_all_connectors(
                        conn_pg,
                        trigger="cli",
                        connector_name=args.connector,
                        dedup_max_runtime_seconds=config.dedup_max_runtime_seconds,
                    )
            else:
                logger.error(
                    "Skipping the connector sweep: connector_registry sync "
                    "failed, so disabled-by-default seeding is unverified."
                )
            # Also drain any pending browser-extension captures (issue
            # #75) in --once mode — mainly so `ps connector run` / manual
            # testing can exercise the capture path without waiting for
            # the long-running poll thread below.
            from etl import capture

            capture.process_pending_captures(conn_pg)

            # Also drain any pending dedup review-queue confirm/reject
            # requests in --once mode (issue: dedup review-queue UI) — same
            # reasoning as the capture drain immediately above.
            from etl.dedup import actions as dedup_actions

            dedup_actions.process_pending_actions(conn_pg)

            # Also drain one pending ad-hoc manual trigger in --once mode
            # (issue #244) — same "do queued work" reasoning as the drains
            # above, so `ps connector run` / manual testing can exercise the
            # trigger path without waiting for the long-running poll thread.
            from etl import manual_trigger

            manual_trigger.process_pending_trigger(conn_pg)

            # Also run one materialize-staleness reconciler tick in --once mode
            # (issue #285) — same "do queued/backstop work" reasoning as the
            # drains above. Harmless after the sweep just fired its own notify
            # (nothing is stale, so it no-ops); mainly lets `ps connector run`
            # exercise the self-heal path without the long-running poll thread.
            from etl import materialize_reconciler

            materialize_reconciler.reconcile_stale_profiles(conn_pg)
        except orchestrator.UnknownConnectorError as exc:
            # Caught specifically, not bare ValueError — an unrelated
            # ValueError from somewhere inside a connector's own code
            # should surface as a real crash/traceback, not get silently
            # treated as if it were an operator's connector-name typo.
            logger.error("%s", exc)
            sys.exit(1)
        finally:
            conn_pg.close()
        return

    conn_pg.close()

    # Browser-extension capture polling (issue #75) runs on its own much
    # shorter interval than the hourly connector sweep, in a separate
    # thread — a human waiting on the extension's popup for a result
    # shouldn't wait up to an hour. daemon=True: this thread must not keep
    # the process alive if the main scheduler loop below ever exits.
    from etl import capture

    capture_thread = threading.Thread(
        target=capture.run_capture_poll_loop,
        args=(lambda: postgres.get_connection(config),),
        daemon=True,
    )
    capture_thread.start()

    # Dedup review-queue action polling (dashboard confirm/reject requests
    # on `suggested_merge`) — same "own short interval, own thread" reasoning
    # as the capture thread just above: see etl/dedup/actions.py's module
    # docstring for why the dashboard can only signal a confirm/reject
    # through this queue table rather than calling confirm_suggestion()/
    # reject_suggestion() directly (separate containers, no shared process).
    from etl.dedup import actions as dedup_actions

    dedup_action_thread = threading.Thread(
        target=dedup_actions.run_action_poll_loop,
        args=(lambda: postgres.get_connection(config),),
        daemon=True,
    )
    dedup_action_thread.start()

    # Ad-hoc manual-trigger polling (issue #244): the dashboard's "Ejecutar
    # ahora" button writes an etl_manual_trigger row; this thread picks it up
    # on a short interval and runs a sweep (all connectors, or one when
    # scoped). Same "own short interval, own thread" reasoning as the two
    # threads above. It takes the connector run lock, so it never overlaps the
    # scheduler sweep below (etl.orchestrator.run_scheduler_loop takes the
    # same lock).
    from etl import manual_trigger

    manual_trigger_thread = threading.Thread(
        target=manual_trigger.run_manual_trigger_poll_loop,
        args=(lambda: postgres.get_connection(config),),
        daemon=True,
    )
    manual_trigger_thread.start()

    # Worklist sitemap-seed polling (issue #260): the worklist page's
    # "Refrescar sitemap" button writes a capture_worklist_seed_trigger row;
    # this thread picks it up and fetches the portal's public sitemap
    # (discovery-only — two static GETs, never a detail page or the guest RPC)
    # to upsert pending worklist rows. Same "own short interval, own thread"
    # reasoning as the three threads above.
    from etl import worklist_seed

    worklist_seed_thread = threading.Thread(
        target=worklist_seed.run_worklist_seed_poll_loop,
        args=(lambda: postgres.get_connection(config),),
        daemon=True,
    )
    worklist_seed_thread.start()

    # Profile-materialize staleness reconciler (issue #285, D-046): a
    # sweep-INDEPENDENT poll loop that re-fires notify_materialize_all whenever
    # an active profile has gone stale because a best-effort notify was
    # missed/failed on an ingest path. This is the durable self-healing backstop
    # for the Estepona class of bug (a single skipped notify stranding a profile
    # at 0/stale data with nothing to retry it). Same "own short interval, own
    # thread, daemon" pattern as the four threads above.
    from etl import materialize_reconciler

    materialize_reconciler_thread = threading.Thread(
        target=materialize_reconciler.run_materialize_reconciler_poll_loop,
        args=(lambda: postgres.get_connection(config),),
        kwargs={"interval_seconds": config.materialize_reconciler_interval_seconds},
        daemon=True,
    )
    materialize_reconciler_thread.start()

    if not registry_synced:
        # Same reasoning as the --once branch: without the seeded rows, every
        # connector would sweep enabled-by-default. Exit rather than idle so
        # the container's restart policy retries the sync from scratch.
        logger.error(
            "Not starting the connector scheduler: connector_registry sync "
            "failed, so disabled-by-default seeding is unverified. Exiting so "
            "the container restarts and retries."
        )
        sys.exit(1)

    # Long-running container mode (docker-compose CMD): a fresh connection
    # per cycle, same pattern the source project used, so a dropped
    # connection between runs doesn't wedge the whole process.
    orchestrator.run_scheduler_loop(
        lambda: postgres.get_connection(config),
        interval_seconds=_RUN_INTERVAL_SECONDS,
        min_restart_sweep_interval_seconds=config.min_restart_sweep_interval_seconds,
        dedup_max_runtime_seconds=config.dedup_max_runtime_seconds,
    )


if __name__ == "__main__":
    main()
