"""ETL sync for CCStock (central warehouse stock) → ps_stock_central.

CCStock table
-------------
CCStock is the central-warehouse stock matrix in PowerShop. It has one row
per article (NumArticulo, Real/float PK with .99 suffix) and 34 stock-slot
columns (Stock1..Stock34) representing per-size quantities.

Column type notes (confirmed via _USER_COLUMNS, 2026-05-01):
  - NumArticulo : DATA_TYPE=6, DATA_LENGTH=8  (Real / 8-byte float — PK)
  - Stock       : DATA_TYPE=6, DATA_LENGTH=8  (Real — row-level sum by 4D)
  - Stock1..Stock34 : DATA_TYPE=3, DATA_LENGTH=2  (16-bit integer WORD)
  - FechaModifica : DATA_TYPE=8 (Date)

Important: Stock1..Stock34 in CCStock are the SAME 16-bit WORD type as in
Exportaciones.  The p4d driver returns unsigned values for negatives
(e.g. 65535 = −1).  We apply decode_signed_int16_word() on these columns,
exactly as done for Exportaciones.  The root-level "Stock" column (singular)
is Real (DATA_TYPE=6) and does NOT need decoding.

Strategy
--------
Full-refresh nightly (truncate + insert).  CCStock has ~41 500 rows
(one per article in the central warehouse), so the full refresh is fast.
No watermark is needed.

ps_stock_central schema (see etl/schema/init.sql):
  num_articulo  NUMERIC(20,3) PK   — from NumArticulo
  stock         INTEGER            — SUM(decode(Stock1..Stock34))
  fecha_modifica DATE              — from FechaModifica
"""

from __future__ import annotations

import logging
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from etl.db.fourd import decode_signed_int16_word, safe_fetch
from etl.db.postgres import truncate_and_insert, upsert

logger = logging.getLogger(__name__)

# Number of slot columns in CCStock (same 34-slot system as Exportaciones).
_MAX_SLOT = 34

# Stock slot column names in 4D (original casing for SELECT).
_STOCK_COLS = [f"Stock{i}" for i in range(1, _MAX_SLOT + 1)]

# Fixed columns to select (4D original casing).
_FIXED_COLS = ["NumArticulo", "FechaModifica"]

# Full SELECT column list.
_CCSTOCK_COLUMNS = ", ".join(_FIXED_COLS + _STOCK_COLS)

# Quantize target for NUMERIC(20,3) PK (NumArticulo has .99 suffix pattern
# like all 4D PKs — stored with scale 3 to avoid collisions on 3-decimal PKs).
_THREE_PLACES = Decimal("0.001")


def _map_ccstock_row(src: dict[str, Any]) -> dict[str, Any] | None:
    """Map one CCStock source row to a ps_stock_central dict.

    Returns None if NumArticulo is missing/zero (skip row).

    Stock1..Stock34 are 16-bit WORD (DATA_TYPE=3, DATA_LENGTH=2): the p4d
    driver returns unsigned values for negatives.  We apply
    decode_signed_int16_word() on each slot and sum them.  The root-level
    "Stock" column (Real, DATA_TYPE=6) is NOT selected because we recompute
    the sum ourselves from the slot values for accuracy.
    """
    num_art_raw = src.get("numarticulo")
    if not num_art_raw:
        return None

    num_articulo = Decimal(str(num_art_raw)).quantize(
        _THREE_PLACES, rounding=ROUND_HALF_UP
    )

    # Sum the 34 signed-int16 stock slots.
    total_stock = 0
    for i in range(1, _MAX_SLOT + 1):
        raw = src.get(f"stock{i}")
        if raw is not None:
            total_stock += int(decode_signed_int16_word(raw))

    return {
        "num_articulo": num_articulo,
        "stock": total_stock,
        "fecha_modifica": src.get("fechamodifica"),
    }


def sync_ccstock(conn_4d: Any, conn_pg: Any, since: Any = None) -> int:
    """Sync ps_stock_central from the 4D CCStock table.

    since=None  → full refresh (TRUNCATE + INSERT). Catches articles
                  removed from the central warehouse.
    since=date  → delta upsert (WHERE FechaModifica > since). The hourly
                  delta cron uses this; the nightly full pass cleans up.
    """
    where = ""
    if since is not None:
        # `>=` not `>`: FechaModifica is date-only (DATA_TYPE=8). Strict `>`
        # would silently skip same-day updates once the watermark advances
        # to today. Upsert is idempotent so re-fetching today's rows is
        # harmless.
        date_str = since.strftime("%Y-%m-%d")
        where = f" WHERE FechaModifica >= {{d '{date_str}'}}"
    sql = f"SELECT {_CCSTOCK_COLUMNS} FROM CCStock{where}"
    logger.info(
        "sync_ccstock: fetching %s rows from CCStock ...",
        "delta" if since is not None else "all",
    )

    raw_rows = safe_fetch(conn_4d, sql)
    logger.info("sync_ccstock: fetched %d source rows", len(raw_rows))

    pg_rows: list[dict[str, Any]] = []
    skipped = 0
    for src in raw_rows:
        mapped = _map_ccstock_row(src)
        if mapped is None:
            skipped += 1
            continue
        pg_rows.append(mapped)

    if skipped:
        logger.warning(
            "sync_ccstock: skipped %d rows with missing/zero NumArticulo", skipped
        )

    if since is None:
        count = truncate_and_insert(conn_pg, "ps_stock_central", pg_rows)
        logger.info("sync_ccstock: inserted %d rows into ps_stock_central", count)
        return count

    if not pg_rows:
        return 0
    count = upsert(conn_pg, "ps_stock_central", pg_rows, pk_cols=["num_articulo"])
    logger.info("sync_ccstock: upserted %d rows into ps_stock_central", count)
    return count
