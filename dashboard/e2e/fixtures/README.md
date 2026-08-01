# Dashboard e2e test data

Synthetic, **production-faithful** seed data so dashboard e2e tests (issue #800)
run against a real Postgres where the home (`/`) and every saved dashboard
(Cuadro de Mandos 8–9, Review semanal 10–13) render real values.

## Files

| File | What it is |
|------|------------|
| `generate_seed.py` | Deterministic generator. Run occasionally to (re)produce `seed.sql`. |
| `seed.sql` | **Generated** — the committed dataset that tests/CI load. Do not hand-edit. |
| `init-test-db.sh` | Loads `etl/schema/init.sql` + `seed.sql` into a target DSN. |

## Quick start

```bash
# Against any throwaway Postgres (NEVER production):
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/powershop_e2e \
  dashboard/e2e/fixtures/init-test-db.sh
```

This applies the mirror schema then loads the seed. It is idempotent
(`seed.sql` truncates the tables it owns first).

## Regenerating `seed.sql`

```bash
python dashboard/e2e/fixtures/generate_seed.py > dashboard/e2e/fixtures/seed.sql
```

The generator is **deterministic** (fixed RNG seed) — same input → byte-identical
output, so `seed.sql` is reviewable in diffs and stable in CI.

## How it works — the four design decisions

1. **No production data, no PII.** This is a public repo. The generator was
   tuned from production **aggregates only** (value distributions, the intraday
   sales curve, ~43% gross margin, 3-digit store-code style, payment-method mix,
   wholesale-invoice magnitudes) — never real rows. Every name/reference is
   obviously synthetic (`Proveedor 03`, `Cliente 0007`, `ART00042`, `V…`).

2. **Dates are relative to `CURRENT_DATE`.** Every date/timestamp is emitted as
   `CURRENT_DATE - N` / `NOW() - INTERVAL …`. So the dataset is always "recent"
   whenever it is loaded — the home (as-of *today*) and the dashboards'
   `last_7_days` range always match rows, with **no clock mocking and no
   staleness**. There are sales for today (with a realistic intraday curve),
   the last 7 days, and ~90 days back for trend widgets.

3. **Faithful shapes, faithful joins.** Volumes are small (~6k sales, ~12k sale
   lines, ~120 articles, …) but the referential integrity the dashboards rely on
   is exact, so every join returns rows:
   - `ps_lineas_ventas.codigo` → `ps_articulos.codigo` (TEXT)
   - `ps_lineas_ventas.num_ventas` → `ps_ventas.reg_ventas`
   - `ps_articulos.num_familia` → `ps_familias.reg_familia` (dashboards INNER JOIN this)
   - `ps_lineas_compras.num_articulo` → `ps_articulos.reg_articulo`
   - `ps_compras.num_proveedor` → `ps_proveedores.reg_proveedor`
   - `ps_albaranes.num_pedido` / `ps_lineas_compras.num_pedido` → `ps_compras.reg_pedido`

4. **Tuned for coverage, not volume realism.** Where a faithful ratio would leave
   a widget empty, the test data balances both branches on purpose (documented so
   it isn't mistaken for real behaviour):
   - Purchase orders: ~50% received / ~50% open (prod is ~9% received) so
     dashboard 9's *Recibidos* **and** *Abiertos* tables both return rows.

## Tables populated

Retail: `ps_ventas`, `ps_lineas_ventas`, `ps_pagos_ventas`.
Purchasing: `ps_compras`, `ps_lineas_compras`, `ps_albaranes`.
Wholesale: `ps_gc_facturas`.
Stock: `ps_traspasos`, `ps_stock_tienda`, `ps_stock_central`.
Dimensions: `ps_tiendas`, `ps_articulos`, `ps_familias`, `ps_departamentos`,
`ps_colores`, `ps_marcas`, `ps_temporadas`, `ps_proveedores`, `ps_clientes`.
ETL status (home "Datos al día" + health): `etl_watermarks`, `etl_sync_runs`.

Dashboard rows themselves (8–13) are created by the app's seeders
(`getOrCreateReviewDashboardId`, etc.) — the e2e harness triggers those; this
fixture only provides the `ps_*` data they query.

## Validation

The generated `seed.sql` was loaded into a real Postgres 16 and every dashboard /
home / review query returned non-empty results — including the 4-table inner
join (`ps_lineas_ventas → ps_ventas → ps_articulos → ps_familias`) that the
margin table and item ranking depend on. Re-validate after regenerating:

```bash
dashboard/e2e/fixtures/init-test-db.sh "$E2E_DATABASE_URL"
psql "$E2E_DATABASE_URL" -c "SELECT count(*) FROM ps_ventas WHERE fecha_creacion = CURRENT_DATE;"  # > 0
```

## Using it from the e2e tests (#800)

The `dashboard-e2e` CI job already runs a Postgres service. The e2e setup should:
1. `init-test-db.sh "$E2E_DATABASE_URL"` (schema + seed) before the suite;
2. start the dashboard pointed at that DSN with `DASHBOARD_LLM_PROVIDER=e2e-stub`;
3. seed the dashboards (reuse the app seeders), then assert each renders without
   an error surface.

See the **e2e-testing** skill (`docs/skills/e2e-testing.md`) for the full pattern.
