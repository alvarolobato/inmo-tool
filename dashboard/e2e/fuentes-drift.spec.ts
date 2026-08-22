/**
 * E2E: portal filter-drift on Fuentes/<name> (issue #511, D-041; repointed by
 * #642 P2, which deleted `/etl/salud`).
 *
 * The Descubrimiento tab was retired (#511) and the aliseda static drift check
 * moved to a "Deriva de portales" section on Salud de datos; #676 moved that
 * section to the per-source Fuentes detail, and P2 deleted the page it came
 * from. Same section, same testids, one route further along. This spec seeds a
 * `portal_filter_catalog` row and asserts the section renders the green "sin
 * deriva" state when the catalog matches the code mapping and the red drift
 * report when it diverges — plus that no error surface renders.
 *
 * D-093's location clause is superseded by this move; its semantics are not.
 *
 * Admin-gated; the section is fetched independently of the main health payload
 * (a failure just hides the section), so this only needs the seeded catalog +
 * an admin session. Skips cleanly when Postgres is unreachable / key unset.
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

const CONNECTOR = "aliseda";

// Matches the Aliseda code mapping exactly → no drift.
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

// Diverges: adds `aticos`, omits the non-residential categories → drift.
const DRIFTING_AXES = {
  property_type: [
    { label: "Piso", urlFragment: "/comprar-viviendas/pisos", subtipo: 36 },
    { label: "Ático", urlFragment: "/comprar-viviendas/aticos", subtipo: 40 },
    { label: "Chalet adosado", urlFragment: "/comprar-viviendas/chalets-adosados", subtipo: 31 },
  ],
};

let pool: Pool;
let dbAvailable = false;

async function seedCatalog(axes: unknown): Promise<void> {
  await pool.query("DELETE FROM portal_filter_catalog WHERE connector = $1", [CONNECTOR]);
  await pool.query(
    `INSERT INTO portal_filter_catalog (connector, source, axes, captured_at)
       VALUES ($1, $2, $3::jsonb, NOW())`,
    [CONNECTOR, "static-asset", JSON.stringify(axes)],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[salud-drift.spec] Postgres unreachable — skipping");
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
  await seedAdminSession(page, baseURL);
});

test("drift section renders the green 'sin deriva' state from a matching catalog", async ({
  page,
}) => {
  await seedCatalog(MATCHING_AXES);
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await expect(page.getByTestId("fuente-detail-page")).toBeVisible();

  const section = page.getByTestId("fuente-drift");
  await expect(section).toBeVisible();
  const drift = page.getByTestId("discovery-drift");
  await expect(drift).toBeVisible();
  await expect(drift).toHaveAttribute("data-drift", "false");
  await expect(page.getByTestId("discovery-drift-none")).toBeVisible();

  // No error surface (D-041 bar).
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("drift section flags drift from a diverging catalog", async ({ page }) => {
  await seedCatalog(DRIFTING_AXES);
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await expect(page.getByTestId("fuente-drift")).toBeVisible();

  const drift = page.getByTestId("discovery-drift");
  await expect(drift).toBeVisible();
  await expect(drift).toHaveAttribute("data-drift", "true");
  await expect(page.getByTestId("discovery-drift-flag")).toBeVisible();
  await expect(page.getByTestId("drift-added").first()).toContainText("aticos");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("the admin strip no longer lists Descubrimiento", async ({ page }) => {
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  const strip = page.locator('nav[aria-label="Administración"]');
  await expect(strip.getByRole("link", { name: "Descubrimiento", exact: true })).toHaveCount(0);
});
