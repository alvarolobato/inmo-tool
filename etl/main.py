"""ETL main entrypoint — placeholder orchestrator.

The real connector framework and per-site orchestration land in Phase 1.3
(issue #11) and Phase 1.4 (issue #12). This module intentionally does no
sync work yet: it only proves the container starts, connects to Postgres,
and applies the schema — so `docker compose up` and `ps etl run` don't
crash-loop while later Phase 1 tasks build the real pipeline on top of this.

Usage:
    python -m etl.main --once       # connect, init schema, log, exit
    python -m etl.main              # connect, init schema, then idle-loop
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO,
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("etl")

_SCHEMA_SQL_PATH = Path(__file__).parent / "schema" / "init.sql"
_IDLE_LOOP_SECONDS = 3600

_NOT_YET_IMPLEMENTED = (
    "No connectors implemented yet — see Phase 1.3 (issue #11, connector "
    "framework) and Phase 1.4 (issue #12, first connector). This process "
    "will connect to Postgres and keep the schema current, but performs no "
    "ingestion until those land."
)


def _init_schema(conn_pg) -> None:
    """Execute etl/schema/init.sql against PostgreSQL (idempotent — IF NOT EXISTS).

    init.sql is still the inherited PowerShop schema (ps_* tables) at this
    point in the stack — it creates tables this project doesn't use. Schema
    replacement with the real property/listing/profile model is Phase 1.2
    (issue #10), not this task's job.
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
        help="Connect, init schema, log the not-yet-implemented notice, and exit "
        "(default: idle-loop indefinitely, for the long-running container)",
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
    finally:
        conn_pg.close()

    logger.warning(_NOT_YET_IMPLEMENTED)

    if args.once:
        return

    # Long-running container mode (docker-compose CMD): idle rather than
    # exit, so the service shows healthy/up instead of crash-looping while
    # there's nothing to schedule yet.
    while True:
        time.sleep(_IDLE_LOOP_SECONDS)
        logger.info("Idle — %s", _NOT_YET_IMPLEMENTED)


if __name__ == "__main__":
    main()
