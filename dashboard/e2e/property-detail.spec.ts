/**
 * E2E: property detail page (task 2.8, #44).
 *
 * Same real-server/real-Postgres pattern as e2e/candidates.spec.ts and
 * e2e/map.spec.ts. Requires a reachable Postgres with task 1.2's schema
 * applied; skips cleanly if none is reachable.
 */
import { test, expect, type Page } from "@playwright/test";
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

const MADRID_SOL: [number, number] = [40.4168, -3.7038];
const NAME_PREFIX = "e2e-property-detail-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let dedupedPropertyId: number;
let singleListingPropertyId: number;
let fotocasaListingId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[property-detail.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  async function insertProperty(address: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, rooms, bathrooms, address)
       VALUES ($1, $2, 'piso', 70, 2, 1, $3) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], address],
    );
    return result.rows[0].id;
  }

  async function insertListing(
    propId: number,
    source: string,
    price: number,
    status: string,
    photoUrls: string[],
  ): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, photo_urls)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6) RETURNING id`,
      [propId, source, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, status, price, photoUrls],
    );
    return result.rows[0].id;
  }

  async function markMatched(propId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propId],
    );
  }

  // Deduplicated property: 2 listings, different sources, one withdrawn on
  // one site while still active on the other (a real, expected post-dedup
  // state per EC-1) — plus price history across both so the combined
  // timeline actually has two categories to plot, and photos on each side
  // (different photos per site) so the gallery union (EC-2) has something
  // real to union.
  dedupedPropertyId = await insertProperty(`${NAME_PREFIX}Calle Trafalgar, Chamberí, Madrid`);
  fotocasaListingId = await insertListing(
    dedupedPropertyId,
    "fotocasa",
    285000,
    "active",
    [`https://example.com/${NAME_PREFIX}fotocasa-1.jpg`, `https://example.com/${NAME_PREFIX}fotocasa-2.jpg`],
  );
  const milanunciosListingId = await insertListing(
    dedupedPropertyId,
    "milanuncios",
    279000,
    "withdrawn",
    [`https://example.com/${NAME_PREFIX}milanuncios-1.jpg`],
  );
  await pool.query(
    `INSERT INTO listing_price_history (listing_id, observed_at, price) VALUES
       ($1, NOW() - INTERVAL '10 days', 300000),
       ($1, NOW() - INTERVAL '2 days', 285000),
       ($2, NOW() - INTERVAL '9 days', 279000)`,
    [fotocasaListingId, milanunciosListingId],
  );
  await pool.query(
    `INSERT INTO listing_status_event (listing_id, observed_at, status) VALUES ($1, NOW() - INTERVAL '1 day', 'withdrawn')`,
    [milanunciosListingId],
  );
  await markMatched(dedupedPropertyId);

  // Not-yet-deduplicated property: exactly one listing (EC-3).
  singleListingPropertyId = await insertProperty(`${NAME_PREFIX}Calle Goya, Madrid`);
  await insertListing(singleListingPropertyId, "fotocasa", 400000, "active", []);
  await markMatched(singleListingPropertyId);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query(
    "DELETE FROM listing_status_event WHERE listing_id IN (SELECT id FROM listing WHERE external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM listing_price_history WHERE listing_id IN (SELECT id FROM listing WHERE external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

// Every UI page is admin-gated (middleware.ts) — see e2e/helpers/admin-session.ts.
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

test("shows all linked listings and combined history for deduplicated property", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${dedupedPropertyId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  const listings = page.locator('[data-testid="linked-listing-item"]');
  await expect(listings).toHaveCount(2);
  await expect(page.locator('[data-testid="linked-listing-item"][data-source="fotocasa"]')).toHaveAttribute(
    "data-status",
    "active",
  );
  await expect(
    page.locator('[data-testid="linked-listing-item"][data-source="milanuncios"]'),
  ).toHaveAttribute("data-status", "withdrawn");

  // Combined chart: both sources' price history contribute to one chart,
  // not two separate ones. Assert real connected lines were drawn, not just
  // "some svg exists" — that assertion previously passed even when the
  // chart rendered zero-length paths and a single dot with nothing joining
  // them (#73 review: forward-fill bug, chart was silently empty).
  const lineCurves = page.locator(".recharts-line-curve");
  await expect(lineCurves).toHaveCount(2); // one per source: fotocasa, milanuncios
  const pathData = await lineCurves.evaluateAll((els) => els.map((el) => el.getAttribute("d") ?? ""));
  for (const d of pathData) {
    expect(d, `line path should contain a real line-to command, got: ${d}`).toMatch(/L\s*[\d.]/);
  }
  await expect(page.getByTestId("status-event-timeline")).toContainText(/retirado/i);
});

test("gallery shows photos from all linked listings", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${dedupedPropertyId}`);
  await assertNoErrorSurface(page);

  // 2 fotocasa photos + 1 milanuncios photo = 3 thumbnails, the union.
  await expect(page.locator('[data-testid="photo-gallery-thumb"]')).toHaveCount(3);
});

test("renders correctly for non-deduplicated property", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${singleListingPropertyId}`);
  await assertNoErrorSurface(page);
  await expect(page.locator('[data-testid="linked-listing-item"]')).toHaveCount(1);
});

test("no error surface on property detail page", async ({ page }) => {
  skipIfNoDb(test);
  await page.goto(`/profiles/${profileId}/properties/${dedupedPropertyId}`);
  await assertNoErrorSurface(page);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
});

test("candidate list card links through to the property detail page", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(`[data-testid="candidate-card"][data-property-id="${dedupedPropertyId}"]`);
  await expect(card).toBeVisible();
  await card.click();

  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${dedupedPropertyId}$`));
  await expect(page.getByTestId("property-detail-page")).toBeVisible();

  await page.getByText(/volver al perfil/i).click();
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
});
