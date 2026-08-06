/**
 * E2E: URL-building discovery admin page (issue #336, D-063).
 *
 * Per D-041, a new user-facing (here: admin) surface ships a Playwright e2e
 * that loads a seeded Postgres row, navigates the page under a real server, and
 * asserts (1) no error surface renders and (2) real content (not an empty
 * state) renders. The load-bearing assertion is that a discovered
 * `portal_filter_catalog` row is fetched and its property-type options render
 * with the canonical mapping — the exact read path the connector's URL builder
 * later consumes.
 *
 * Admin-gated (middleware.ts `/etl/:path*` + `/api/etl/:path*`), so the test
 * sets the `ps_admin` cookie the same way /admin/login does. Requires
 * ADMIN_API_KEY + a reachable Postgres — skips cleanly otherwise, matching the
 * other specs. The CI e2e job globs ./e2e, so this spec is picked up with no
 * workflow change.
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

const CONNECTOR = "aliseda";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[discovery.spec] Postgres unreachable — skipping");
    return;
  }

  // Clean slate for this connector, then seed one discovered catalog session.
  await pool.query("DELETE FROM portal_filter_catalog WHERE connector = $1", [CONNECTOR]);
  await pool.query(
    `INSERT INTO portal_filter_catalog (connector, source, axes, captured_at)
       VALUES ($1, $2, $3::jsonb, NOW())`,
    [
      CONNECTOR,
      "embedded-config",
      JSON.stringify({
        property_type: [
          { label: "Piso", portalValue: "36", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
          { label: "Ático", portalValue: "40", urlFragment: "/comprar-viviendas/aticos", subtipo: 40 },
          { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
        ],
      }),
    ],
  );
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM portal_filter_catalog WHERE connector = $1", [CONNECTOR]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("renders the discovered catalog with no error surface", async ({ page }) => {
  await page.goto("/etl/discovery");
  await expect(page.getByTestId("discovery-page")).toBeVisible();

  // The seeded catalog loads (not the empty state, not a skeleton).
  await expect(page.getByTestId("discovery-catalog")).toBeVisible();
  await expect(page.getByTestId("discovery-empty")).toHaveCount(0);
  await expect(page.getByTestId("catalog-source")).toContainText("embedded-config");
  await expect(page.getByTestId("catalog-options-count")).toContainText("3");

  // The property-type options render, mapped to canonical types (real content).
  const table = page.getByTestId("property-type-table");
  await expect(table).toBeVisible();
  await expect(table).toContainText("Piso");
  await expect(table).toContainText("Ático");
  await expect(table).toContainText("/comprar-viviendas/aticos");
  await expect(table.getByText("atico", { exact: true })).toBeVisible();
  await expect(table.getByText("chalet", { exact: true })).toBeVisible();

  // No error surface — the bar every admin/user-facing page in this repo meets.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

test("shows the connector picker and the start-discovery action", async ({ page }) => {
  await page.goto("/etl/discovery");
  await expect(page.getByTestId("discovery-connector-select")).toBeVisible();
  await expect(page.getByTestId("start-discovery")).toBeEnabled();
});

test("is reachable from the admin nav, next to Captura guiada", async ({ page }) => {
  // The page was unreachable from the UI before this — only by typing the URL.
  await page.goto("/etl/captura");
  const nav = page.locator("nav").first();
  const discovery = nav.getByRole("link", { name: "Descubrimiento" });
  await expect(discovery).toBeVisible();
  await expect(discovery).toHaveAttribute("href", "/etl/discovery");
  await discovery.click();
  await expect(page).toHaveURL(/\/etl\/discovery$/);
  await expect(page.getByTestId("discovery-page")).toBeVisible();
});
