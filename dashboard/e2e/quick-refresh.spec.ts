/**
 * E2E (D-041): quick refresh on profile create (issue #245).
 *
 * The user-facing contract this locks in: creating a search profile kicks off
 * a background data fetch for its zone, and the UI tells the user so. The ETL
 * poller (the Python container) isn't part of this browser+DB e2e, so — like
 * run-now.spec.ts — this asserts the two halves the dashboard actually owns:
 *
 *   1. The save writes the correct backend signal: a pending full-sweep
 *      `etl_manual_trigger` row (connector_name NULL, triggered_by
 *      'profile-refresh') — the exact row `etl/manual_trigger.py` reads.
 *   2. The "buscando datos nuevos para esta zona…" indicator renders after the
 *      save, and no error surface appears anywhere in the flow.
 *
 * Admin-gated like every UI page (middleware.ts). Requires ADMIN_API_KEY on
 * the server under test and a reachable Postgres — skips cleanly otherwise.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

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

const NAME_PREFIX = "e2e-quick-refresh-";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[quick-refresh.spec] no reachable Postgres - skipping e2e suite.");
  }
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM etl_manual_trigger");
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  // Start from a clean trigger queue so the create enqueues its own row rather
  // than coalescing onto a leftover pending one (single-pending unique index).
  await pool.query("DELETE FROM etl_manual_trigger");
  await seedAdminSession(page, baseURL);
});

test("creating a profile enqueues a full sweep and shows the 'buscando datos' indicator", async ({
  page,
}) => {
  const name = `${NAME_PREFIX}${Date.now()}`;

  await page.goto("/profiles");
  await page.getByRole("button", { name: "Nuevo perfil" }).click();
  // The form ships valid defaults (Madrid radius 5km, piso), so a name is all
  // the user must supply to create.
  await page.getByPlaceholder("Ej: Alquiler alto rendimiento, bajo coste").fill(name);
  await page.getByRole("button", { name: "Crear perfil" }).click();

  // 1. The profile lands in the list.
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

  // 2. The UX signal: the quick-refresh indicator renders.
  const indicator = page.getByTestId("refresh-indicator");
  await expect(indicator).toBeVisible({ timeout: 10_000 });
  await expect(indicator).toContainText("Buscando datos nuevos para esta zona");

  // 3. The load-bearing backend contract: exactly one pending full-sweep
  //    trigger, tagged as coming from the profile refresh — the row the ETL
  //    poll loop consumes.
  await expect
    .poll(async () => {
      const r = await pool.query<{ connector_name: string | null; triggered_by: string | null }>(
        "SELECT connector_name, triggered_by FROM etl_manual_trigger WHERE status = 'pending'",
      );
      if (r.rows.length !== 1) return `rows=${r.rows.length}`;
      return `${r.rows[0].connector_name ?? "NULL"}|${r.rows[0].triggered_by ?? "NULL"}`;
    })
    .toBe("NULL|profile-refresh");

  // 4. No error surface — the bar every user-facing page in this repo is held to.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
});
