/**
 * E2E: admin IA consolidation (issue #508), D-041.
 *
 * Drives a real Next.js server against a real Postgres. Asserts the admin strip
 * is rendered from the single shared nav source (lib/admin-nav.ts):
 *
 *   - the strip shows the consolidated, renamed tab set (Captura (admin),
 *     Clasificación, Duplicados, LLM) and no longer the four separate LLM tabs
 *     or the old "Candidatos" label;
 *   - `/admin/candidatos` 301-redirects to `/admin/clasificacion` and the
 *     vocabulary review renders (with its manual-promotion note);
 *   - Duplicados is reachable from the strip;
 *   - visiting an LLM sub-route (`/admin/usage`) highlights the single LLM tab;
 *   - no error surface anywhere (the D-041 bar).
 *
 * Extensión and Descubrimiento remain in the strip on purpose — their removal
 * is owned by #509 / #511. This spec asserts the exact set THIS issue ships.
 *
 * Admin-gated (middleware gates every UI page on the ps_admin cookie), so the
 * test seeds that cookie like /admin/login does. Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset, matching the other admin specs.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

// The tabs THIS issue ships, in strip order. Extensión + Descubrimiento are
// still present pending #509 / #511.
const EXPECTED_STRIP_LABELS = [
  "Monitor ETL",
  "Conectores",
  "Captura (admin)",
  "Descubrimiento",
  "Salud de datos",
  "Extensión",
  "URLs capturadas",
  "Clasificación",
  "Duplicados",
  "LLM",
  "Configuración",
];

// Labels that must NOT appear in the consolidated strip anymore.
const REMOVED_STRIP_LABELS = [
  "Candidatos",
  "Captura guiada",
  "Consultas lentas",
  "Herramientas LLM",
  "Uso LLM",
  "Interacciones",
];

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

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[admin-nav.spec] Postgres unreachable — skipping");
  }
});

test.afterAll(async () => {
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

/** The admin strip (not the global TopBar) — scoped by its aria-label. */
function strip(page: import("@playwright/test").Page) {
  return page.locator('nav[aria-label="Administración"]');
}

test("EC-1: strip renders the consolidated nav from the shared source", async ({ page }) => {
  await page.goto("/admin");

  const links = strip(page).getByRole("link");
  await expect(links).toHaveText(EXPECTED_STRIP_LABELS);

  for (const gone of REMOVED_STRIP_LABELS) {
    await expect(strip(page).getByRole("link", { name: gone, exact: true })).toHaveCount(0);
  }

  // No error surface (D-041 bar).
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-1: /admin index cards match the strip (single source, no drift)", async ({ page }) => {
  await page.goto("/admin");
  // The index grid links (excludes the strip nav) — every strip href appears.
  for (const label of EXPECTED_STRIP_LABELS) {
    await expect(page.getByRole("link", { name: label, exact: true }).first()).toBeVisible();
  }
});

test("EC-2: /admin/candidatos redirects to /admin/clasificacion with the review", async ({
  page,
}) => {
  await page.goto("/admin/candidatos");
  await expect(page).toHaveURL(/\/admin\/clasificacion$/);
  await expect(page.getByTestId("clasificacion-page")).toBeVisible();
  // The manual-promotion note is the page's distinctive content.
  await expect(page.getByText(/La promoción es manual/)).toBeVisible();

  // D-041 bar.
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("Detalles técnicos");
  await expect(body).not.toContainText("there is no parameter");
  await expect(body).not.toContainText("HTTP 500");
  await expect(body).not.toContainText("Error al cargar");
});

test("EC-3: Duplicados is reachable from the strip", async ({ page }) => {
  await page.goto("/admin");
  const dup = strip(page).getByRole("link", { name: "Duplicados", exact: true });
  await expect(dup).toHaveAttribute("href", "/admin/dedup");
  await dup.click();
  await expect(page).toHaveURL(/\/admin\/dedup$/);
  await expect(page.getByRole("heading", { name: "Revisión de duplicados" })).toBeVisible();
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("LLM landing groups the four diagnostics and the strip highlights it on sub-routes", async ({
  page,
}) => {
  await page.goto("/admin/llm");
  await expect(page.getByTestId("admin-llm-page")).toBeVisible();
  // Landing links to the four existing routes.
  for (const href of [
    "/admin/slow-queries",
    "/admin/tool-calls",
    "/admin/usage",
    "/admin/interactions",
  ]) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
  }

  // Visiting a sub-route highlights the single LLM tab (aria-current="page").
  await page.goto("/admin/usage");
  const llmTab = strip(page).getByRole("link", { name: "LLM", exact: true });
  await expect(llmTab).toHaveAttribute("aria-current", "page");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});
