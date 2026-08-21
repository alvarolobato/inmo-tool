/**
 * E2E: ad-hoc "Ejecutar ahora" / "Ejecutar todo ahora" (issue #244).
 *
 * The revived capability: clicking the button writes an `etl_manual_trigger`
 * row that `etl/manual_trigger.py`'s poll loop picks up and runs. The ETL
 * poller isn't part of this browser+DB e2e (it's the Python container), so
 * these tests assert the two halves the UI is actually responsible for:
 *
 *   1. The button writes the correct trigger row — scoped to one connector on
 *      the connectors page, or NULL (full sweep) from the /etl monitor. This
 *      is the load-bearing backend contract, inspected in the same DB row the
 *      ETL poll loop reads (mirrors connectors.spec.ts's approach).
 *   2. Once a trigger reaches 'done' (here simulated by updating the row, as
 *      the ETL would), the UI's status poll resolves to a completed state —
 *      and no error surface renders at any point.
 *
 * Admin-gated like the sibling ETL specs; sets the `ps_admin` cookie.
 * Requires ADMIN_API_KEY on the server under test and a reachable Postgres —
 * skips cleanly otherwise.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

function buildPool(): Pool {
  const dsn = process.env.POSTGRES_DSN;
  if (dsn) return new Pool({ connectionString: dsn, max: 2 });
  return new Pool({
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "inmotool",
    max: 2,
  });
}

const CONNECTOR = "e2e-runnow-fotocasa";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();

async function clearTriggers() {
  // The single-pending partial index allows at most one pending row across
  // all tests — always start from a clean slate.
  await pool.query("DELETE FROM etl_manual_trigger");
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[run-now.spec] Postgres unreachable — skipping");
    return;
  }

  await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CONNECTOR]);
  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters)
     VALUES ($1, true, 20, false, true, '["rooms"]'::jsonb)`,
    [CONNECTOR],
  );
  await clearTriggers();
});

test.afterAll(async () => {
  if (dbAvailable) {
    await clearTriggers();
    await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CONNECTOR]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await clearTriggers();
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("per-connector run writes a scoped trigger, shows a busy state, no error surface", async ({
  page,
}) => {
  // #642 P1: connector management moved to the Fuentes detail page, which
  // starts the ConnectorCard expanded (a single-source page has nothing to
  // collapse behind — issue #264's browsability rationale only applies to
  // the list).
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await expect(page.getByTestId(`connector-${CONNECTOR}`)).toBeVisible();
  await page.getByTestId(`run-now-${CONNECTOR}`).click();

  // The load-bearing backend assertion: a pending trigger scoped to exactly
  // this connector — the row the ETL poll loop (etl/manual_trigger.py) reads.
  await expect
    .poll(async () => {
      const r = await pool.query(
        "SELECT connector_name FROM etl_manual_trigger WHERE status = 'pending'",
      );
      return r.rows[0]?.connector_name ?? null;
    })
    .toBe(CONNECTOR);

  // The button reflects the queued run (the ETL poller isn't part of this
  // e2e, so it stays "en cola"/"Ejecutando…" — the full poll-to-'done'
  // transition is covered by the RunNowButton component test and the
  // full-sweep test below, which don't depend on a connector-list refetch).
  await expect(page.getByTestId(`run-status-${CONNECTOR}`)).toContainText("cola");
  await expect(page.getByTestId(`run-now-${CONNECTOR}`)).toContainText("Ejecutando");

  // No error surface — the bar every user-facing page in this repo is held to.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("full-sweep run from /etl writes a NULL-connector trigger", async ({ page }) => {
  await page.goto("/etl");
  await expect(page.getByTestId("run-now-all")).toBeVisible();

  await page.getByTestId("run-now-all").click();

  // A full sweep = a pending trigger with no connector scope.
  await expect
    .poll(async () => {
      const r = await pool.query(
        "SELECT COUNT(*)::int AS n FROM etl_manual_trigger "
          + "WHERE status = 'pending' AND connector_name IS NULL",
      );
      return r.rows[0].n;
    })
    .toBe(1);

  await pool.query(
    "UPDATE etl_manual_trigger SET status = 'done', finished_at = NOW() WHERE status = 'pending'",
  );

  await expect(page.getByTestId("run-status-all")).toContainText("completada");
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
});
