/**
 * E2E (D-041): the "Validar filtros" page + ⋮ menu entry (issue #478 P2).
 *
 * Drives a real Next.js server against a real Postgres. Seeds ONE search
 * profile and ONE idealista override (profile_connector_filter, the Phase-1
 * tier-0 store). Then:
 *   - navigates to the page from the profile's ⋮ menu (the P2 entry point);
 *   - asserts the idealista row shows an "URL fijada" badge and the seeded URL
 *     VERBATIM, and the aliseda row shows a "derivada del perfil" badge;
 *   - pins a new URL on the aliseda row and asserts it persists + re-renders
 *     (badge flips to "URL fijada", URL updated);
 *   - asserts no error surface (D-041 bar);
 *   - asserts that on /captura the idealista task now uses the pinned URL —
 *     via GET /api/profiles/[id]/search-urls (the task's url), i.e. on the
 *     task URL itself, not window.open.
 *
 * Admin-gated like every page (middleware.ts). Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset — matching the other specs.
 */
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { seedAdminSession, adminKey } from "./helpers/admin-session";

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

const PROFILE_NAME = "E2E-478P2 Validar filtros";
const SCOPE = {
  geography: { type: "radius", center: [37.3891, -5.9845], radius_km: 5 },
  property_types: ["piso"],
  price_max: 200000,
};
// A hand-tuned idealista URL pinned as this profile's idealista filter (tier 0).
const PINNED_IDEALISTA =
  "https://www.idealista.com/venta-viviendas/sevilla-sevilla/con-precio-hasta_175000/";
// A hand-tuned aliseda URL the test pins during the run.
const NEW_ALISEDA =
  "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/sevilla/?precio=0-175000";

let pool: Pool;
let dbAvailable = false;
let profileId: number;

async function purge(): Promise<void> {
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM search_profile WHERE name = $1",
    [PROFILE_NAME],
  );
  for (const { id } of existing.rows) {
    // profile_connector_filter cascades on profile delete, but clear the other
    // FK children a running dev server may have materialized first.
    await pool.query("DELETE FROM profile_connector_filter WHERE profile_id = $1", [id]).catch(() => undefined);
    for (const table of ["capture_task_run", "profile_listing_state", "feedback_event"]) {
      await pool.query(`DELETE FROM ${table} WHERE profile_id = $1`, [id]).catch(() => undefined);
    }
  }
  await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[validar-filtros.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [PROFILE_NAME, JSON.stringify(SCOPE)],
  );
  profileId = r.rows[0].id;
  // Seed a whole-connector ('') idealista override so the idealista task is
  // governed by it (tier 0) — the "URL fijada" case.
  await pool.query(
    `INSERT INTO profile_connector_filter (profile_id, connector, section_key, url, source)
     VALUES ($1, 'idealista', '', $2, 'manual')`,
    [profileId, PINNED_IDEALISTA],
  );
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
}

test("navigate from ⋮ menu; pinned + derived rows; save persists; captura uses the pin", async ({
  page,
}) => {
  // 1) Reach the page from the profile row's ⋮ menu.
  await page.goto("/profiles");
  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /más acciones/i }).click();
  await page.getByRole("menuitem", { name: "Validar filtros" }).click();
  // The filtros route is brand-new, so `npm run dev` compiles it on-demand on
  // first hit; App Router only commits the URL once the RSC payload resolves,
  // which can exceed the default 5s expect timeout on a cold compile in CI.
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/filtros`), { timeout: 30_000 });
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await assertNoErrorSurface(page);

  // 2) Idealista row → "URL fijada" + the seeded URL verbatim.
  const ideaRow = page.locator('[data-testid="filter-validation-row"][data-connector="idealista"]');
  await expect(ideaRow).toBeVisible();
  await expect(ideaRow.getByTestId("filter-source-badge")).toHaveText("URL fijada");
  await expect(ideaRow.getByTestId("filter-url")).toHaveText(PINNED_IDEALISTA);

  // 2b) Aliseda row → derived (no pin yet).
  const aliRow = page.locator('[data-testid="filter-validation-row"][data-connector="aliseda"]');
  await expect(aliRow).toBeVisible();
  await expect(aliRow.getByTestId("filter-source-badge")).toHaveText("derivada del perfil");

  // 2c) The Phase-2 "abrir sin señal" transient note is present.
  await expect(page.getByTestId("validar-filtros-open-note")).toBeVisible();

  // 3) Pin a new URL on the aliseda row → persists + re-renders.
  await aliRow.getByTestId("filter-url-input").fill(NEW_ALISEDA);
  await aliRow.getByTestId("filter-save").click();
  // After router.refresh() the aliseda row is now pinned with the new URL.
  await expect(aliRow.getByTestId("filter-source-badge")).toHaveText("URL fijada");
  await expect(aliRow.getByTestId("filter-url")).toHaveText(NEW_ALISEDA);
  await assertNoErrorSurface(page);

  // 4) /captura uses the pinned idealista URL — assert on the task's URL itself
  //    (via the search-urls API), not window.open.
  const res = await page.request.get(`/api/profiles/${profileId}/search-urls`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { tasks: { portal: string; url: string; overridden?: boolean }[] };
  const ideaTask = body.tasks.find((t) => t.portal === "idealista");
  expect(ideaTask).toBeDefined();
  expect(ideaTask!.url).toBe(PINNED_IDEALISTA);
  expect(ideaTask!.overridden).toBe(true);
  const aliTask = body.tasks.find((t) => t.portal === "aliseda");
  expect(aliTask!.url).toBe(NEW_ALISEDA);
  expect(aliTask!.overridden).toBe(true);

  // The captura page renders without an error surface and shows the pinned URL
  // on the idealista task's launch button (title = task.url).
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();
  await assertNoErrorSurface(page);
  const ideaConn = page.getByTestId(`captura-connector-${profileId}-idealista`);
  await expect(ideaConn).toBeVisible();
  await expect(ideaConn.locator(`[title="${PINNED_IDEALISTA}"]`).first()).toBeVisible();
});
