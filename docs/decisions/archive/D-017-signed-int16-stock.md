---
id: D-017
title: Signed 16-bit `Exportaciones.StockN` over 4D SQL / p4d
date: 2026-04-22
---

# D-017: Signed 16-bit `Exportaciones.StockN` over 4D SQL / p4d

*Decided: 2026-04-22*

**Context**: Dashboard stock KPIs showed hundreds of millions of units; investigation showed `ps_stock_tienda.stock = 65535` while PowerShop POS showed `−1` for the same slot, with `CCStock` (Real) matching the signed row total. Users asked whether metadata and a “native 4D” path exist.
**Evidence**:
- Live **`_USER_COLUMNS`**: all **`Exportaciones.Stock1`…`Stock34`** are **`DATA_TYPE = 3`**, **`DATA_LENGTH = 2`** (16-bit integer). **`CCStock`** is **`DATA_TYPE = 6`** (Real, length 8). **`LineasVentas.Unidades`** and **`Traspasos.UnidadesS/E`** are **Real (6/8)** in the catalog — not 16-bit slots.
- Cross-check **4D SQL** (`ps sql query`) returns the same `65535` values the ETL saw; the UI uses native 4D types and shows negatives.
- Local **PowerShop Server / PSClient** file trees (e.g. install bundles) contain **compiler/resources** (XLF mentions `WORD` types) but **not** `.4DProject` field lists — **not** a substitute for `_USER_COLUMNS` on the server.
**Decision**: Implement **`decode_signed_int16_word()`** in `etl/db/fourd.py`: for integers in ``32768..65535``, subtract **65536** (exact signed-int16 reinterpretation of the low 16 bits — **not** a domain heuristic). Call **only** when normalizing **type-3/length-2 (16-bit) stock-slot columns** as confirmed by `_USER_COLUMNS`. As of 2026-05-01 those are: **`Exportaciones.Stock1`…`Stock34`** AND **`CCStock.Stock1`…`Stock34`** (the per-size slots on both tables share the type). **Do not** apply to the root-level **`CCStock.Stock`** (Real, type 6 — `etl/sync/ccstock.py` only decodes the 34 slot columns), to **`LineasVentas.Unidades`** or **`Traspasos.UnidadesS/E`** (catalog: **Real**, type 6), or to wholesale **`GCLin*`** line quantities (can exceed 32767) — see `mayorista.py` note.
**Alternatives rejected**: Relying on a `p4d.connect()` option (none exposed for type coercion). Fixing only in dashboards (would leave raw mirror wrong for WrenAI/SQL). Guessing additional columns without type-3/length-2 proof.
**Rationale**: 4D “knows” the type from the **structure**; the bug is at the **SQL wire representation**. The decode rule is **metadata-driven** (which columns) + **bit-accurate** (how to convert).
**See**: `etl/db/fourd.py`, `etl/sync/stock.py`, `etl/sync/ccstock.py`, [4d-sql-dialect.md](../skills/4d-sql-dialect.md), [data-access.md](../skills/data-access.md), [stock-logistics.md](../architecture/stock-logistics.md).
