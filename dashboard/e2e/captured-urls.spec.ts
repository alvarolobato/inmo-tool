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
// All-portals generalization (#510): captured rows for aliseda + altamira so the
// portal filter chips have ≥2 portals to switch between (EC-1).
const ALISEDA_URL =
  "https://www.alisedainmobiliaria.com/comprar-viviendas/malaga/E2E-475-aliseda/";
const ALTAMIRA_URL =
  "https://www.altamirainmuebles.com/venta-viviendas/pontevedra/E2E-475-altamira/";

// Observed URLs (issue #488): a plain listado + an areas/shape drawn zone.
// The shape encodes Google's documented 3-vertex example polyline.
const OBS_SHAPE_ENC = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const OBS_SHAPE_URL = `https://www.idealista.com/areas/venta-viviendas/E2E-488-obs/?shape=${encodeURIComponent(
  `((${OBS_SHAPE_ENC}))`,
)}`;
const OBS_PLAIN_URL =
  "https://www.idealista.com/venta-viviendas/malaga/E2E-488-obs-plain/";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();
const seededIds: number[] = [];

async function purge(): Promise<void> {
  await pool.query("DELETE FROM captured_search_urls WHERE url LIKE '%E2E-475-%'");
  await pool.query("DELETE FROM observed_search_urls WHERE url LIKE '%E2E-488-%'");
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
  for (const { portal, url, title } of [
    { portal: "idealista", url: SHAPE_URL, title: "Zona dibujada E2E" },
    { portal: "idealista", url: PLAIN_URL, title: "Búsqueda E2E" },
    { portal: "aliseda", url: ALISEDA_URL, title: "Aliseda E2E" },
    { portal: "altamira", url: ALTAMIRA_URL, title: "Altamira E2E" },
  ]) {
    const res = await pool.query<{ id: number }>(
      `INSERT INTO captured_search_urls (portal, url, title)
       VALUES ($1, $2, $3) RETURNING id`,
      [portal, url, title],
    );
    seededIds.push(res.rows[0].id);
  }

  // Observed URLs (issue #488) — a shape/areas row (3 vertices) + a plain row.
  for (const { url, norm, title } of [
    { url: OBS_SHAPE_URL, norm: "idealista.com/areas/venta-viviendas/e2e-488-obs?shape=obs-a", title: "Zona observada E2E" },
    { url: OBS_PLAIN_URL, norm: "idealista.com/venta-viviendas/malaga/e2e-488-obs-plain", title: "Listado observado E2E" },
  ]) {
    await pool.query(
      `INSERT INTO observed_search_urls (portal, url, norm_key, title, seen_count)
       VALUES ('idealista', $1, $2, $3, 4)`,
      [url, norm, title],
    );
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

test("portal chips filter rows across portals (#510, EC-1)", async ({ page }) => {
  await page.goto("/admin/captured-urls");
  await expect(page.getByTestId("captured-urls-page")).toBeVisible();

  // The seeded data spans ≥2 portals, so a chip exists for each + "Todos".
  const filter = page.getByTestId("portal-filter");
  await expect(filter).toBeVisible();
  await expect(page.getByTestId("portal-chip").filter({ hasText: "aliseda" })).toBeVisible();
  await expect(page.getByTestId("portal-chip").filter({ hasText: "altamira" })).toBeVisible();

  // Unfiltered: both an idealista and an aliseda captured row are present.
  await expect(
    page.getByTestId("captured-url-link").filter({ hasText: "E2E-475-shape" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("captured-url-link").filter({ hasText: "E2E-475-aliseda" }),
  ).toBeVisible();

  // Filter to aliseda: the aliseda row stays, the idealista rows drop out.
  await page.getByTestId("portal-chip").filter({ hasText: "aliseda" }).click();
  await expect(
    page.getByTestId("captured-url-link").filter({ hasText: "E2E-475-aliseda" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("captured-url-link").filter({ hasText: "E2E-475-shape" }),
  ).toHaveCount(0);

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("lists observed URLs with type badge and decoded vertex count (#488)", async ({ page }) => {
  await page.goto("/admin/captured-urls");
  await expect(page.getByTestId("observed-urls-section")).toBeVisible();

  // Real content: at least the two seeded observed rows and a non-empty total.
  const rows = page.getByTestId("observed-url-row");
  await expect(rows.first()).toBeVisible();
  const total = Number((await page.getByTestId("observed-urls-total").textContent())?.trim());
  expect(total).toBeGreaterThanOrEqual(2);

  // The areas/shape row renders its type badge and the decoded vertex count (3).
  const shapeRow = rows.filter({ hasText: "E2E-488-obs/" }).first();
  await expect(shapeRow.getByTestId("observed-url-type")).toHaveText("areas");
  await expect(shapeRow.getByTestId("observed-url-vertices")).toHaveText("3");

  // The plain listado row is badged "plana" with no vertex count.
  const plainRow = rows.filter({ hasText: "E2E-488-obs-plain" }).first();
  await expect(plainRow.getByTestId("observed-url-type")).toHaveText("plana");

  // The empty state is NOT shown when there is data.
  await expect(page.getByTestId("observed-urls-empty")).toHaveCount(0);

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
