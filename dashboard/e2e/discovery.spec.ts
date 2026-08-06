/**
 * E2E: URL-building discovery admin page + drift detection (issue #336/#339,
 * reframed by issue #371, D-089).
 *
 * Per D-041, an admin surface ships a Playwright e2e that loads a seeded
 * Postgres row, navigates the page under a real server, and asserts (1) no error
 * surface renders and (2) real content renders. The load-bearing assertions here
 * are the DRIFT flag: a captured `portal_filter_catalog` that DIVERGES from the
 * connector's code mapping raises the flag ("actualiza el mapeo del código"),
 * and a catalog that MATCHES the code mapping raises no false flag ("sin
 * deriva"). Discovery no longer drives URL building (that self-healing was
 * removed in #371) — it only detects drift for the owner to fix in code.
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

// A catalog that MATCHES the Aliseda code mapping exactly (pisos→36,
// chalets-adosados→31, plus every non-residential category) → no drift.
const MATCHING_AXES = {
  property_type: [
    { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
    { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
    { label: "Local", urlFragment: "/comprar-locales" },
    { label: "Nave", urlFragment: "/comprar-naves" },
    { label: "Garaje", urlFragment: "/comprar-garajes" },
    { label: "Terreno", urlFragment: "/comprar-terrenos" },
    { label: "Edificio", urlFragment: "/comprar-edificios" },
  ],
};

// A catalog that DIVERGES: the portal exposes a real `aticos` option the code
// folds into `pisos`, and omits the non-residential categories the code maps.
const DRIFTING_AXES = {
  property_type: [
    { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
    { label: "Ático", urlFragment: "/comprar-viviendas/aticos", subtipo: 40 },
    { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
  ],
};

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();

async function seedCatalog(axes: unknown): Promise<void> {
  await pool.query("DELETE FROM portal_filter_catalog WHERE connector = $1", [CONNECTOR]);
  await pool.query(
    `INSERT INTO portal_filter_catalog (connector, source, axes, captured_at)
       VALUES ($1, $2, $3::jsonb, NOW())`,
    [CONNECTOR, "embedded-config", JSON.stringify(axes)],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[discovery.spec] Postgres unreachable — skipping");
  }
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

test("renders the discovered catalog and FLAGS drift vs. the code mapping", async ({ page }) => {
  await seedCatalog(DRIFTING_AXES);
  await page.goto("/etl/discovery");
  await expect(page.getByTestId("discovery-page")).toBeVisible();

  // The seeded catalog loads (not the empty state, not a skeleton).
  await expect(page.getByTestId("discovery-catalog")).toBeVisible();
  await expect(page.getByTestId("discovery-empty")).toHaveCount(0);
  await expect(page.getByTestId("catalog-source")).toContainText("embedded-config");

  // The property-type options render, mapped to canonical types (real content).
  const table = page.getByTestId("property-type-table");
  await expect(table).toBeVisible();
  await expect(table).toContainText("Ático");
  await expect(table).toContainText("/comprar-viviendas/aticos");

  // Drift is FLAGGED — the load-bearing assertion for this reframe.
  const drift = page.getByTestId("discovery-drift");
  await expect(drift).toBeVisible();
  await expect(drift).toHaveAttribute("data-drift", "true");
  await expect(page.getByTestId("discovery-drift-flag")).toBeVisible();
  // The added `aticos` option and a removed non-residential category are named.
  await expect(page.getByTestId("drift-added").first()).toContainText("aticos");
  await expect(page.getByTestId("drift-removed").first()).toBeVisible();

  // No error surface — the bar every admin/user-facing page in this repo meets.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

test("shows NO drift flag when the catalog matches the code mapping", async ({ page }) => {
  await seedCatalog(MATCHING_AXES);
  await page.goto("/etl/discovery");
  await expect(page.getByTestId("discovery-catalog")).toBeVisible();

  // The drift panel renders the green "sin deriva" state, no false flag.
  const drift = page.getByTestId("discovery-drift");
  await expect(drift).toBeVisible();
  await expect(drift).toHaveAttribute("data-drift", "false");
  await expect(page.getByTestId("discovery-drift-none")).toBeVisible();
  await expect(page.getByTestId("discovery-drift-flag")).toHaveCount(0);
  await expect(page.getByTestId("drift-added")).toHaveCount(0);
  await expect(page.getByTestId("drift-removed")).toHaveCount(0);

  // Still no error surface.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

test("shows the connector picker and the start-discovery action", async ({ page }) => {
  await seedCatalog(MATCHING_AXES);
  await page.goto("/etl/discovery");
  await expect(page.getByTestId("discovery-connector-select")).toBeVisible();
  await expect(page.getByTestId("start-discovery")).toBeEnabled();
});

test("is reachable from the admin nav, next to Captura guiada", async ({ page }) => {
  // The page was unreachable from the UI before this — only by typing the URL.
  // NB: /etl/* renders two <nav>s (global TopBar + the AdminChrome admin strip),
  // so select the link directly — "Descubrimiento" is unique to the admin strip.
  await page.goto("/etl/captura");
  const discovery = page.getByRole("link", { name: "Descubrimiento" });
  await expect(discovery).toBeVisible();
  await expect(discovery).toHaveAttribute("href", "/etl/discovery");
  await discovery.click();
  await expect(page).toHaveURL(/\/etl\/discovery$/);
  await expect(page.getByTestId("discovery-page")).toBeVisible();
});
