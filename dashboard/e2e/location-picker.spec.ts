/**
 * E2E: search profile location picker (issue #95) — replaces raw lat/lon
 * number inputs with a Nominatim-backed address search + Leaflet map.
 *
 * The search step stubs `/api/geocode` (via page.route) with a fixed,
 * realistic response rather than hitting the live Nominatim API on every
 * test run (Opus review, PR #103): this is both a repeat of the same
 * rate-limit-abuse-risk the server-side throttle in lib/geocode.ts guards
 * against, and a source of flakiness (a real network dependency in a test
 * that should be deterministic). The map-click test never called Nominatim
 * to begin with (it only exercises the map's own click-to-move handler) and
 * is unchanged.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if no DB is
 * reachable, matching every other spec in this suite.
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

const NAME_PREFIX = "e2e-location-picker-";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[location-picker.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
  }
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  }
  await pool?.end();
});

test("searching a place and selecting it sets the profile's coordinates", async ({ page }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  const name = `${NAME_PREFIX}${Date.now()}`;

  // Real Chamberí, Madrid coordinates from a prior live Nominatim lookup —
  // stubbed here to keep this test deterministic and to avoid hitting the
  // real API on every run (see file docstring).
  const STUB_LAT = 40.4356;
  const STUB_LON = -3.7036;
  let geocodeRequestCount = 0;
  await page.route("**/api/geocode*", async (route) => {
    geocodeRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          { label: "Chamberí, Madrid, Comunidad de Madrid, España", lat: STUB_LAT, lon: STUB_LON },
        ],
      }),
    });
  });

  await page.goto("/profiles");
  await page.getByRole("button", { name: "Nuevo perfil" }).click();
  await page.getByPlaceholder("Ej: Alquiler alto rendimiento, bajo coste").fill(name);

  const searchInput = page.getByTestId("location-search-input");
  await searchInput.fill("Chamberí, Madrid");

  const firstResult = page.getByTestId("location-search-result").first();
  await expect(firstResult).toBeVisible({ timeout: 10_000 });
  await firstResult.click();

  // Selecting a result must not re-trigger a search (Opus review, PR #103:
  // setQuery(result.label) inside selectResult previously re-triggered the
  // search effect, firing a second Nominatim request behind the scenes).
  // Wait past the debounce window, then assert the route was only ever hit
  // once — a direct proof, not just the dropdown-visibility proxy below.
  await page.waitForTimeout(600);
  expect(geocodeRequestCount).toBe(1);

  // The search dropdown closes on selection; open the advanced/manual panel
  // to read back the coordinates the selection actually set, rather than
  // asserting against Leaflet's internal DOM (brittle) — this proves the
  // search selection really updated the form's underlying state.
  await page.getByRole("button", { name: "Introducir coordenadas manualmente" }).click();
  const lat = await page.getByTestId("location-lat-input").inputValue();
  const lon = await page.getByTestId("location-lon-input").inputValue();
  expect(Number(lat)).toBeCloseTo(STUB_LAT, 4);
  expect(Number(lon)).toBeCloseTo(STUB_LON, 4);

  // Also confirms the dropdown itself stays closed after selection (the
  // regression's other visible symptom, alongside the extra request above).
  await expect(page.getByTestId("location-search-results")).not.toBeVisible();

  // Submit and confirm the real stored value in Postgres matches what the
  // picker showed — proves the whole path end to end, not just the UI state.
  await page.getByRole("button", { name: "Crear perfil" }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

  const { rows } = await pool.query<{ scope: { geography: { center: [number, number] } } }>(
    "SELECT scope FROM search_profile WHERE name = $1",
    [name],
  );
  expect(rows).toHaveLength(1);
  const [storedLat, storedLon] = rows[0].scope.geography.center;
  expect(storedLat).toBeCloseTo(Number(lat), 3);
  expect(storedLon).toBeCloseTo(Number(lon), 3);
});

test("clicking the map moves the marker and updates the manual coordinate fields", async ({ page }) => {
  test.skip(!dbAvailable, "no reachable Postgres");

  await page.goto("/profiles");
  await page.getByRole("button", { name: "Nuevo perfil" }).click();
  await page.getByRole("button", { name: "Introducir coordenadas manualmente" }).click();

  const latBefore = await page.getByTestId("location-lat-input").inputValue();
  const lonBefore = await page.getByTestId("location-lon-input").inputValue();

  // Click well off-center on the Leaflet map to force a real coordinate
  // change (ClickToMove in LocationPickerMap.tsx) — proves the map is a
  // real, interactive Leaflet instance, not a static image.
  const mapContainer = page.locator(".leaflet-container");
  await expect(mapContainer).toBeVisible({ timeout: 10_000 });
  const box = await mapContainer.boundingBox();
  if (!box) throw new Error("map container has no bounding box");
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);

  await expect
    .poll(async () => page.getByTestId("location-lat-input").inputValue())
    .not.toBe(latBefore);
  const lonAfter = await page.getByTestId("location-lon-input").inputValue();
  expect(lonAfter).not.toBe(lonBefore);
});
