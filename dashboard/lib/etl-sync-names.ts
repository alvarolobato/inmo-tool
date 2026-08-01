/**
 * Single source of truth for watermark-backed ETL sync table names.
 *
 * Must stay in sync with SYNC_NAMES_WITH_WATERMARK in etl/main.py.
 * The drift test at dashboard/__tests__/sync-names-drift.test.ts enforces this.
 * ccstock is included here even though it uses truncate-on-full instead of
 * watermark-based delta — the API still accepts it as a valid force-resync target.
 */
export const SYNC_NAMES_WITH_WATERMARK: readonly string[] = [
  "articulos",
  "clientes",
  "ccstock",
  "facturas",
  "ventas",
  "lineas_ventas",
  "pagos_ventas",
  "gc_albaranes",
  "gc_lin_albarane",
  "gc_facturas",
  "gc_lin_facturas",
  "stock",
  "traspasos",
] as const;
