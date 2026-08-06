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
    // Delete FK children first: search_profile is referenced by
    // profile_listing_state (profile_listing_state_profile_id_fkey). A plain
    // DELETE FROM search_profile fails if any listing-state rows point at a
    // seeded profile — which happens whenever a background matcher attaches
    // one to the profile the search-and-select test creates. Clear the
    // children by the same name prefix, then the profiles themselves, so
    // teardown is robust and can't mask a test body's real result.
    await pool.query(
      `DELETE FROM profile_listing_state WHERE profile_id IN (
         SELECT id FROM search_profile WHERE name LIKE $1
       )`,
      [`${NAME_PREFIX}%`],
    );
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  }
  await pool?.end();
});

// Every UI page is admin-gated (middleware.ts) — see e2e/helpers/admin-session.ts.
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
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
  // The first (and only legitimate) geocode request has necessarily already
  // fired and resolved by now — the result option is only rendered from that
  // response — so the count is 1 at this point.
  expect(geocodeRequestCount).toBe(1);
  await firstResult.click();

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
  // regression's other visible symptom): if selecting had re-triggered the
  // search effect (Opus review, PR #103: setQuery(result.label) inside
  // selectResult firing a second Nominatim request a debounce-interval
  // later), that second response would call setShowResults(true) and reopen
  // this dropdown over the map.
  await expect(page.getByTestId("location-search-results")).not.toBeVisible();

  // Submit and confirm the real stored value in Postgres matches what the
  // picker showed — proves the whole path end to end, not just the UI state.
  await page.getByRole("button", { name: "Crear perfil" }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

  // #165: selecting a result must not re-trigger a second geocode request.
  // The old guard was `waitForTimeout(600); expect(count).toBe(1)` — a fixed
  // real-clock sleep giving only a 200ms margin over the 400ms search
  // debounce, which could lose the race under load. Assert the count only
  // now: the profile has been POSTed and rendered back from the list (a real
  // server + DB round-trip), an observable event that is causally well past
  // the 400ms window in which a re-triggered debounce would have fired and
  // bumped the count. This keeps the regression guard strong (a second
  // request would have landed by now) without racing a fixed sleep against
  // the debounce.
  expect(geocodeRequestCount).toBe(1);

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
  // #178: the container getting a layout box (visible + a bounding box) does
  // NOT mean Leaflet has finished initializing the map instance and attaching
  // its click handler (ClickToMove's useMapEvents in LocationPickerMap.tsx).
  // react-leaflet only mounts the map's child layers — the marker AND the
  // click handler, siblings mounted together after the map instance exists —
  // once init completes, so the marker appearing in the DOM is a real
  // "Leaflet is initialized and listening for clicks" signal. It is also
  // network-independent (unlike `.leaflet-tile-loaded`, which needs the OSM
  // tile server to respond and may never load in CI). Under full-suite load
  // the window between "container visible" and "Leaflet actually wired up"
  // widens; waiting on the marker before reading the box and clicking closes
  // that race deterministically instead of inferring readiness from the
  // container's visibility alone.
  await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({ timeout: 10_000 });
  // page.mouse.click takes VIEWPORT coordinates, so the box must be scrolled
  // into view before it is read. Running alone this test passes either way —
  // the dialog opens at the top of a short page. In a full-suite run earlier
  // specs leave more profiles behind, the list is longer, and the map sits
  // partly below the fold: the click then lands somewhere else entirely and
  // the coordinate inputs never change. That made this the only spec in the
  // suite whose result depended on which other specs ran first.
  await mapContainer.scrollIntoViewIfNeeded();
  const box = await mapContainer.boundingBox();
  if (!box) throw new Error("map container has no bounding box");
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);

  await expect
    .poll(async () => page.getByTestId("location-lat-input").inputValue())
    .not.toBe(latBefore);
  const lonAfter = await page.getByTestId("location-lon-input").inputValue();
  expect(lonAfter).not.toBe(lonBefore);
});
