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
// P4: the ETL-connector previews section. `pisos` is a tunable HTTP connector
// (a real search page + an override_host_suffix); `cimenta2` is non-tunable
// (national sitemap sweep). Both are seeded into the registry + preview tables
// exactly as etl.orchestrator.sync_connector_registry / publish_search_previews
// would publish them.
const PISOS_PREVIEW_URL = "https://www.pisos.com/venta/pisos-sevilla/";
const CIMENTA2_PREVIEW_URL = "https://inmuebles.cimenta2.com/inmuebles/s/sitemap.xml";
// A hand-tuned pisos URL the test pins on the ETL section.
const NEW_PISOS = "https://www.pisos.com/venta/pisos-sevilla/1-habitacion/";

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

  // P4: stand in for what the ETL publishes — the pisos (tunable) + cimenta2
  // (non-tunable) registry rows and their per-profile previews.
  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters, override_host_suffix, supports_search_override)
     VALUES ('pisos', true, 20, false, true, '[]'::jsonb, 'pisos.com', false),
            ('cimenta2', true, 20, true, true, '[]'::jsonb, NULL, false)
     ON CONFLICT (connector_name) DO UPDATE SET
       registered = true, supports_discovery = true,
       override_host_suffix = EXCLUDED.override_host_suffix,
       supports_search_override = EXCLUDED.supports_search_override`,
  );
  await seedEtlPreviews();
});

/** (Re)seed the pisos + cimenta2 previews for the profile (P4). */
async function seedEtlPreviews(): Promise<void> {
  await pool.query(
    `INSERT INTO connector_search_preview (profile_id, connector, previews)
     VALUES ($1, 'pisos', $2::jsonb), ($1, 'cimenta2', $3::jsonb)
     ON CONFLICT (profile_id, connector) DO UPDATE SET
       previews = EXCLUDED.previews, computed_at = NOW()`,
    [
      profileId,
      JSON.stringify([
        { label: "Pisos.com — sevilla", url: PISOS_PREVIEW_URL, kind: "search_page", tunable: true, notes: null },
      ]),
      JSON.stringify([
        {
          label: "Cimenta2 (Cajamar) — barrido nacional",
          url: CIMENTA2_PREVIEW_URL,
          kind: "sitemap",
          tunable: false,
          notes: "Barrido nacional del sitemap; el scope no entra en la URL — el filtrado es por datos.",
        },
      ]),
    ],
  );
}

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

  // 2c) The transient Phase-2 "abrir sin señal" note is gone (Phase 3); a
  //     permanent validation-mode hint replaces it.
  await expect(page.getByTestId("validar-filtros-open-note")).toHaveCount(0);
  await expect(page.getByTestId("validar-filtros-open-hint")).toBeVisible();

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

test("ETL section: cimenta2 read-only with its note; pisos tunable and saves (P4)", async ({
  page,
}) => {
  await seedEtlPreviews();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  const etl = page.getByTestId("validar-filtros-etl-section");
  await expect(etl).toBeVisible();
  await assertNoErrorSurface(page);

  // cimenta2 → non-tunable: shows its URL + honest note, read-only (no input).
  const cimenta2 = page.locator('[data-testid="etl-connector-row"][data-connector="cimenta2"]');
  await expect(cimenta2).toBeVisible();
  await expect(cimenta2).toHaveAttribute("data-tunable", "false");
  await expect(cimenta2.getByTestId("etl-url")).toHaveText(CIMENTA2_PREVIEW_URL);
  await expect(cimenta2.getByTestId("etl-notes")).toBeVisible();
  await expect(cimenta2.getByTestId("etl-readonly")).toBeVisible();
  await expect(cimenta2.getByTestId("etl-url-input")).toHaveCount(0);

  // pisos → tunable: shows the derived URL + a save affordance; pin persists.
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos).toBeVisible();
  await expect(pisos).toHaveAttribute("data-tunable", "true");
  await expect(pisos.getByTestId("etl-source-badge")).toHaveText("derivada del perfil");
  await expect(pisos.getByTestId("etl-url")).toHaveText(PISOS_PREVIEW_URL);

  await pisos.getByTestId("etl-url-input").fill(NEW_PISOS);
  await pisos.getByTestId("etl-save").click();
  await expect(pisos.getByTestId("etl-source-badge")).toHaveText("URL fijada");
  await expect(pisos.getByTestId("etl-url")).toHaveText(NEW_PISOS);
  await assertNoErrorSurface(page);

  // The pin is a real profile_connector_filter row for the HTTP connector.
  const res = await page.request.get(`/api/profiles/${profileId}/connector-filters`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { rows: { connector: string; url: string }[] };
  expect(body.rows.some((r) => r.connector === "pisos" && r.url === NEW_PISOS)).toBe(true);

  // Clean the pin so the suite can be re-run against a persistent dev DB.
  await pool.query("DELETE FROM profile_connector_filter WHERE profile_id = $1 AND connector = 'pisos'", [profileId]);
});

test("ETL section renders with no seeded previews — pending, no error surface (P4)", async ({
  page,
}) => {
  // Remove this profile's computed previews; the registered connectors still
  // render (LEFT JOIN) in a pending state, and there must be no error surface.
  await pool.query("DELETE FROM connector_search_preview WHERE profile_id = $1", [profileId]);
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("validar-filtros-etl-section")).toBeVisible();
  await assertNoErrorSurface(page);

  // pisos still appears (it's registered), now pending its next ETL computation.
  const pisos = page.locator('[data-testid="etl-connector-row"][data-connector="pisos"]');
  await expect(pisos).toBeVisible();
  await expect(pisos.getByTestId("etl-pending")).toBeVisible();

  // Restore for any later ordering.
  await seedEtlPreviews();
});
