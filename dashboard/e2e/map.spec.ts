/**
 * E2E: map view (task 2.7, #43).
 *
 * Same fixture/skip pattern as e2e/candidates.spec.ts (task 2.5, #19) — a
 * real Next.js server against a real (seeded, synthetic) Postgres database.
 * Leaflet is a classic "works in a component test, breaks in the real
 * browser" source (SSR touches `window`, default marker icons resolve to
 * broken bundler paths) — exactly the bug class three prior dashboard tasks
 * each shipped once before real e2e coverage existed, so this suite drives
 * an actual browser, not just a component render.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with task 1.2's schema applied.
 * Skips cleanly if no DB is reachable.
 */
import { test, expect, type Page } from "@playwright/test";
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

const MADRID_SOL: [number, number] = [40.4168, -3.7038];
// Far enough from MADRID_SOL (and from each other) to land in distinct
// on-screen clusters at whatever zoom the map's fitBounds settles on for
// this spread-out set — this suite asserts individual markers, not
// clustering behavior, so each seeded property must resolve to its own
// marker. (Clustering itself is asserted separately, below, with points
// deliberately meters apart instead of kilometers.)
const PLOTTABLE_POINTS: [number, number][] = [
  [40.4168, -3.7038],
  [40.45, -3.68],
  [40.38, -3.75],
];
const NAME_PREFIX = "e2e-map-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let plottablePropertyIds: number[] = [];
let unplottablePropertyId: number;
let interestedPropertyId: number;

async function insertProperty(
  address: string,
  coords: [number, number] | null,
  m2Built: number,
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
    [coords?.[0] ?? null, coords?.[1] ?? null, m2Built, address],
  );
  // `id` is a bigint column — node-postgres returns bigint as a string, not
  // a number, regardless of what a hopeful type annotation claims. The
  // exact bug class task 2.5 shipped once already (property_id-as-string).
  return Number(result.rows[0].id);
}

async function insertListing(propertyId: number, source: string, price: number): Promise<void> {
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
     VALUES ($1, $2, $3, 'active', $4, NOW())`,
    [propertyId, source, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
  );
}

async function insertProfile(center: [number, number]): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center, radius_km: 15 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  return Number(result.rows[0].id);
}

async function markMatched(matchProfileId: number, propertyId: number, stage = "new"): Promise<void> {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, pipeline_stage)
     VALUES ($1, $2, true, $3)`,
    [matchProfileId, propertyId, stage],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[map.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  profileId = await insertProfile(MADRID_SOL);

  // Three plottable candidates, each far enough apart to render as
  // separate markers.
  for (let i = 0; i < PLOTTABLE_POINTS.length; i++) {
    const id = await insertProperty(`${NAME_PREFIX}Calle ${i}, Madrid`, PLOTTABLE_POINTS[i], 60 + i * 5);
    await insertListing(id, "fotocasa", 300000 + i * 10000);
    await markMatched(profileId, id, i === 0 ? "interested" : "new");
    plottablePropertyIds.push(id);
    if (i === 0) interestedPropertyId = id;
  }

  // One matched candidate with no usable coordinates (EC-2).
  unplottablePropertyId = await insertProperty(`${NAME_PREFIX}Sin coordenadas, Madrid`, null, 55);
  await insertListing(unplottablePropertyId, "milanuncios", 250000);
  await markMatched(profileId, unplottablePropertyId);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN " +
      "(SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query(
    "DELETE FROM property WHERE id NOT IN (SELECT property_id FROM listing) AND address LIKE $1",
    [`${NAME_PREFIX}%`],
  );
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

test("renders pins for candidates with coordinates at their correct identity", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/map`);

  // Wait for the dynamically-imported (ssr:false) map to mount before
  // asserting no error surface — asserting immediately after goto races
  // the dynamic import and can pass even when it would otherwise fail.
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await assertNoErrorSurface(page);

  const markers = page.locator('[data-testid="map-marker"]');
  await expect(markers).toHaveCount(PLOTTABLE_POINTS.length);

  const renderedIds = (await markers.evaluateAll((els) => els.map((el) => el.getAttribute("data-property-id"))))
    .map(Number)
    .sort((a, b) => a - b);
  expect(renderedIds).toEqual([...plottablePropertyIds].sort((a, b) => a - b));
});

test("shows count of unplottable candidates", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/map`);
  await expect(page.locator(".leaflet-container")).toBeVisible();

  await expect(page.locator('[data-testid="map-unplottable-count"]')).toHaveText(/1 candidato/);
});

test("pin click opens popover with correct data and detail-link affordance", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/map`);
  await expect(page.locator(".leaflet-container")).toBeVisible();

  const markers = page.locator('[data-testid="map-marker"]');
  await expect(markers).toHaveCount(PLOTTABLE_POINTS.length);
  await markers.first().click();

  const popup = page.locator('[data-testid="map-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup.getByText(/€/)).toBeVisible();

  // Property detail page now exists (task 2.8, #44) — the popup links to it.
  const detailLink = popup.locator('[data-testid="map-popup-detail-link"]');
  await expect(detailLink).toBeVisible();
  await expect(detailLink).toHaveAttribute("href", new RegExp(`^/profiles/${profileId}/properties/\\d+$`));
});

test("stage filter narrows the visible pins to the correct candidate", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/map`);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator('[data-testid="map-marker"]')).toHaveCount(PLOTTABLE_POINTS.length);

  await page.locator('[data-testid="map-stage-filter"]').selectOption("interested");
  const remaining = page.locator('[data-testid="map-marker"]');
  await expect(remaining).toHaveCount(1);
  await expect(remaining.first()).toHaveAttribute("data-property-id", String(interestedPropertyId));
});

test("no error surface on map view", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/map`);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await assertNoErrorSurface(page);
});

test.describe("clustering", () => {
  let clusterProfileId: number;
  const CLOSE_TOGETHER: [number, number][] = [
    [40.1, -3.9],
    [40.10003, -3.90004],
  ];

  test.beforeAll(async () => {
    if (!dbAvailable) return;
    clusterProfileId = await insertProfile(CLOSE_TOGETHER[0]);
    for (let i = 0; i < CLOSE_TOGETHER.length; i++) {
      const id = await insertProperty(`${NAME_PREFIX}Cluster ${i}, Madrid`, CLOSE_TOGETHER[i], 65);
      await insertListing(id, "fotocasa", 280000 + i * 1000);
      await markMatched(clusterProfileId, id);
    }
  });

  test("two candidates meters apart render as a single cluster, not two markers", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${clusterProfileId}/map`);
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await assertNoErrorSurface(page);

    await expect(page.locator('[data-testid="map-marker"]')).toHaveCount(0);
    const cluster = page.locator('[data-testid="map-cluster"]');
    await expect(cluster).toHaveCount(1);
    await expect(cluster).toHaveText("2");
  });
});
