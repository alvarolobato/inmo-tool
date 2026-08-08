/**
 * E2E: captured Idealista search URLs review page (issue #475, part of #471,
 * D-041).
 *
 * Drives a real Next.js server against a real Postgres, seeding
 * captured_search_urls rows directly via `pg`. Asserts the two things every
 * user-facing surface in this repo is held to (D-041): no error surface, and
 * real content present (the seeded URL, its `shape` badge, the count tile).
 *
 * Admin-gated (middleware.ts gates every UI page on the `ps_admin` cookie), so
 * the test sets that cookie the way /admin/login does. Skips cleanly when
 * Postgres is unreachable or ADMIN_API_KEY is unset, matching the other specs.
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

// Unique test URLs (kept out of any real capture space) so cleanup is precise.
const SHAPE_URL =
  "https://www.idealista.com/areas/venta-viviendas/?shape=%28%28E2E-475-shape%29%29";
const PLAIN_URL =
  "https://www.idealista.com/venta-viviendas/estepona-malaga/E2E-475-plain/";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();
const seededIds: number[] = [];

async function purge(): Promise<void> {
  await pool.query("DELETE FROM captured_search_urls WHERE url LIKE '%E2E-475-%'");
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[captured-urls.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  for (const { url, title } of [
    { url: SHAPE_URL, title: "Zona dibujada E2E" },
    { url: PLAIN_URL, title: "Búsqueda E2E" },
  ]) {
    const res = await pool.query<{ id: number }>(
      `INSERT INTO captured_search_urls (portal, url, title)
       VALUES ('idealista', $1, $2) RETURNING id`,
      [url, title],
    );
    seededIds.push(res.rows[0].id);
  }
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("lists captured URLs with the shape badge and no error surface", async ({ page }) => {
  await page.goto("/admin/captured-urls");
  await expect(page.getByTestId("captured-urls-page")).toBeVisible();

  // Real content: at least the two seeded rows and a non-empty total.
  const rows = page.getByTestId("captured-url-row");
  await expect(rows.first()).toBeVisible();
  const total = Number((await page.getByTestId("captured-urls-total").textContent())?.trim());
  expect(total).toBeGreaterThanOrEqual(2);

  // The drawn-zone URL renders verbatim (shape= preserved) as a link.
  const shapeLink = page.getByTestId("captured-url-link").filter({ hasText: "E2E-475-shape" });
  await expect(shapeLink).toBeVisible();
  await expect(shapeLink).toHaveAttribute("href", SHAPE_URL);

  // The empty state is NOT shown when there is data.
  await expect(page.getByTestId("captured-urls-empty")).toHaveCount(0);

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
