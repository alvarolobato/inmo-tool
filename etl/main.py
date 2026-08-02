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

    from etl import orchestrator

    if not orchestrator.CONNECTORS:
        logger.warning(
            "No connectors registered yet — see Phase 1.4 (issue #12). "
            "Running an empty sweep (proves the loop itself works)."
        )

    if args.once:
        try:
            orchestrator.run_all_connectors(conn_pg, trigger="cli")
        finally:
            conn_pg.close()
        return

    conn_pg.close()

    # Long-running container mode (docker-compose CMD): a fresh connection
    # per cycle, same pattern the source project used, so a dropped
    # connection between runs doesn't wedge the whole process.
    orchestrator.run_scheduler_loop(
        lambda: postgres.get_connection(config), interval_seconds=_RUN_INTERVAL_SECONDS
    )


if __name__ == "__main__":
    main()
