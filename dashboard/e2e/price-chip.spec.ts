/**
 * E2E (D-041): the redesigned below-market price chip (#460), against a real
 * Next.js server + seeded Postgres.
 *
 * The fixture seeds its own priced pool (same 70 m², so price drives €/m²): a few
 * at-market fillers, one clear DEAL (below market → GREEN) and one PREMIUM (above
 * market → RED). No ambient data is relied on.
 *
 * What it proves (#460):
 *   1. the below-market rating chip sits NEXT TO the price (same line), not below;
 *   2. it is GREEN (data-rating="below") for a below-market unit, RED
 *      (data-rating="above") for an above-market one;
 *   3. it shows the SIGNED percent with NO "bajo/sobre mercado" words;
 *   4. the #452 investor-score chip coexists on the same card without crowding;
 *   5. no error surface renders (the SQL-against-real-Postgres regression net).
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
const NAME_PREFIX = "e2e-pricechip-";

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

/** Seeds a matched, scored candidate (fixed 70 m², so price drives €/m²). */
async function seedProp(key: string, price: number, score: number | null): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}${key}, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, NOW() - interval '3 days', NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, score_kind)
     VALUES ($1, $2, true, $3, $4)`,
    [profileId, propertyId, score, score === null ? null : "trained"],
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
      "[price-chip.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  profileId = await seedProfile();
  // At-market fillers establish the pool median (≥ MIN_POOL_SIZE priced).
  for (let i = 0; i < 3; i++) {
    await seedProp(`filler${i}`, 300000, 0.3);
  }
  // A DEAL: ~40% below the 300k pool median → GREEN chip.
  await seedProp("deal", 180000, 0.5);
  // A PREMIUM: above the pool median → RED chip.
  await seedProp("premium", 480000, 0.5);
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

// D-041: assert no error surface is rendered anywhere on the page.
async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos/i),
  ).toHaveCount(0);
}

const cardFor = (page: Page, key: string) =>
  page.locator(`[data-testid="candidate-card"][data-property-id="${ids[key]}"]`);

test("#460: the below-market chip sits next to the price, is green/red with a signed % and no words, and coexists with the score chip", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const deal = cardFor(page, "deal");
  await expect(deal).toBeVisible();

  // (2)+(3): GREEN below-market chip with a signed percent and NO words.
  const dealRating = deal.getByTestId("price-rating");
  await expect(dealRating).toBeVisible();
  await expect(dealRating).toHaveAttribute("data-rating", "below");
  await expect(dealRating).toContainText(/−\d+%/);
  await expect(dealRating).not.toContainText(/bajo mercado/i);

  // (1): the chip is on the SAME line, immediately after the price. We encode
  // that INTENT robustly rather than pinning a brittle exact pixel gap (a tight
  // x-gap threshold flaked under CI render/font timing — seen ~39.5 vs a ~25px
  // bound). Both the price (<p>) and the chip live in one `alignItems:center`
  // flex row that wraps only when they truly don't fit, so "same line" means
  // their vertical centres coincide; a stacked/wrapped chip would sit a full
  // line-height below and fail. The chip must also sit to the RIGHT of the
  // price and be reasonably close (a generous gap, not an exact pixel value).
  await expect(dealRating).toBeVisible();
  const priceBox = await deal.getByTestId("candidate-price").boundingBox();
  const ratingBox = await dealRating.boundingBox();
  expect(priceBox).not.toBeNull();
  expect(ratingBox).not.toBeNull();
  const priceMidY = priceBox!.y + priceBox!.height / 2;
  const ratingMidY = ratingBox!.y + ratingBox!.height / 2;
  // Same line: vertical centres aligned (well within half the price height — a
  // wrapped-below chip would be ~a full line-height away and fail this).
  expect(Math.abs(priceMidY - ratingMidY)).toBeLessThan(priceBox!.height / 2);
  // To the RIGHT of the price, starting at/after its right edge (small epsilon
  // for sub-pixel rounding) and within a generous horizontal gap — "next to the
  // price", not an exact pixel distance.
  const EPSILON = 4;
  const gap = ratingBox!.x - (priceBox!.x + priceBox!.width);
  expect(ratingBox!.x).toBeGreaterThan(priceBox!.x);
  expect(gap).toBeGreaterThan(-EPSILON);
  expect(gap).toBeLessThan(120);

  // (4): the #452 investor-score chip coexists on the same card.
  await expect(deal.getByTestId("investor-score-chip")).toBeVisible();

  // (2): the PREMIUM unit is RED (above market), signed +% and no words.
  const premium = cardFor(page, "premium");
  const premiumRating = premium.getByTestId("price-rating");
  await expect(premiumRating).toHaveAttribute("data-rating", "above");
  await expect(premiumRating).toContainText(/\+\d+%/);
  await expect(premiumRating).not.toContainText(/sobre mercado/i);
});
