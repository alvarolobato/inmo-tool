/**
 * E2E (D-041): like-for-like below-market segmentation (#461), against a real
 * Next.js server + seeded Postgres.
 *
 * The fixture seeds a WHOLE pool dominated by small cheap flats plus a
 * like-for-like SEGMENT (3-hab / 90 m² / upper floor). The target sits below its
 * segment median but would look ABOVE the small-flat-dominated whole-pool median
 * — so the two bases give opposite verdicts, proving the segment (not the pool)
 * drives the number.
 *
 * What it proves (#461):
 *   1. the feed card's below-market rating is GREEN (data-rating="below") because
 *      the target is measured against its like-for-like segment;
 *   2. the property-detail "Puntuación inversora" breakdown names the comparison
 *      base as the segment (below-market-base-note data-base="segment");
 *   3. no error surface renders (the SQL-against-real-Postgres regression net).
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the schema applied. Skips
 * cleanly if none is reachable, matching price-change-badge.spec.ts.
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
const NAME_PREFIX = "e2e-l4l-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
const ids: Record<string, number> = {};

async function seedProfile(): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, NOW() - interval '3 days', NOW() - interval '2 hours') RETURNING id`,
    [
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  return res.rows[0].id;
}

async function seedProp(
  key: string,
  opts: { price: number; rooms: number; m2: number; floor: string; score: number },
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, rooms, floor, address)
     VALUES ($1, $2, 'piso', $3, $4, $5, $6) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], opts.m2, opts.rooms, opts.floor, `${NAME_PREFIX}${key}, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, NOW() - interval '3 days', NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, opts.price],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, score_kind)
     VALUES ($1, $2, true, $3, 'trained')`,
    [profileId, propertyId, opts.score],
  );
  ids[key] = propertyId;
  return propertyId;
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[likeforlike-below-market.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  profileId = await seedProfile();
  // Small, cheap 1-hab/40m² flats (2.500 €/m²) dominate the whole-pool median.
  for (let i = 0; i < 5; i++) {
    await seedProp(`filler${i}`, { price: 100000, rooms: 1, m2: 40, floor: "2", score: 0.2 });
  }
  // Like-for-like segment: 3-hab / 90 m² / upper floor at 3.333 €/m².
  for (let i = 0; i < 3; i++) {
    await seedProp(`comp${i}`, { price: 300000, rooms: 3, m2: 90, floor: "3", score: 0.4 });
  }
  // Target: 2.222 €/m² → ~33% below its SEGMENT median, but ABOVE the
  // small-flat-dominated whole-pool median.
  await seedProp("target", { price: 200000, rooms: 3, m2: 90, floor: "3", score: 0.5 });
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos/i),
  ).toHaveCount(0);
}

test("#461: the target is rated below-market against its like-for-like segment, and the detail breakdown names the segment base", async ({
  page,
}) => {
  skipIfNoDb(test);

  // Feed card: below-market against the SEGMENT (not the small-flat pool).
  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);
  const card = page.locator(
    `[data-testid="candidate-card"][data-property-id="${ids.target}"]`,
  );
  await expect(card).toBeVisible();
  const rating = card.getByTestId("price-rating");
  await expect(rating).toBeVisible();
  await expect(rating).toHaveAttribute("data-rating", "below");

  // Detail: the "Puntuación inversora" breakdown names the segment base.
  await page.goto(`/profiles/${profileId}/properties/${ids.target}`);
  await assertNoErrorSurface(page);
  const section = page.getByTestId("investor-score-section");
  await expect(section).toBeVisible();
  const note = section.getByTestId("below-market-base-note");
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("data-base", "segment");
  await expect(note).toContainText(/similares/i);
});
