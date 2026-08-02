/**
 * E2E: search profile location picker (issue #95) — replaces raw lat/lon
 * number inputs with a Nominatim-backed address search + Leaflet map.
 *
 * This test makes a real, single, respectful request to the live Nominatim
 * API (no API key, low volume, matching the established pattern of other
 * e2e specs in this project exercising real external services rather than
 * mocking them at this layer) — see lib/geocode.ts's docstring for the
 * usage-policy rationale.
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

test("searching a real place and selecting it sets the profile's coordinates", async ({ page }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  const name = `${NAME_PREFIX}${Date.now()}`;

  await page.goto("/profiles");
  await page.getByRole("button", { name: "Nuevo perfil" }).click();
  await page.getByPlaceholder("Ej: Alquiler alto rendimiento, bajo coste").fill(name);

  const searchInput = page.getByTestId("location-search-input");
  await searchInput.fill("Chamberí, Madrid");

  // Real Nominatim request — wait for a result to actually appear rather
  // than a fixed sleep, since the request time isn't guaranteed.
  const firstResult = page.getByTestId("location-search-result").first();
  await expect(firstResult).toBeVisible({ timeout: 10_000 });
  await firstResult.click();

  // The search dropdown closes on selection; open the advanced/manual panel
  // to read back the coordinates the selection actually set, rather than
  // asserting against Leaflet's internal DOM (brittle) — this proves the
  // search selection really updated the form's underlying state.
  await page.getByRole("button", { name: "Introducir coordenadas manualmente" }).click();
  const lat = await page.getByTestId("location-lat-input").inputValue();
  const lon = await page.getByTestId("location-lon-input").inputValue();
  // Chamberí, Madrid — real-world coordinates, loosely bounded rather than
  // exact-matched since Nominatim's precise value could shift slightly.
  expect(Number(lat)).toBeGreaterThan(40.4);
  expect(Number(lat)).toBeLessThan(40.5);
  expect(Number(lon)).toBeGreaterThan(-3.8);
  expect(Number(lon)).toBeLessThan(-3.6);

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
