/**
 * E2E (D-041): the feed's price-change signal + BAJADA/SUBIDA badges (#420,
 * plan #415 §3.2/§3.3) against a real Next.js server + seeded Postgres.
 *
 * The fixture SEEDS ITS OWN multi-point price history — the plan (§2.0a) notes
 * only ~10 demo listings have more than one recorded price, so this suite never
 * relies on ambient data. Each property gets a listing first-seen well before
 * the visit anchor (so it is NOT "new" — this isolates the price signal from the
 * NUEVO mark), plus a `listing_price_history` whose LATEST observation lands
 * after the anchor with a known delta.
 *
 * What it proves:
 *   1. a mid-range DROP renders a BAJADA badge (data-novelty="price_drop");
 *   2. a mid-range RISE renders a SUBIDA badge (data-novelty="price_up");
 *   3. a <1% move (noise) does NOT badge;
 *   4. a >60% move (a data artifact) does NOT badge;
 *   5. a move that happened BEFORE the anchor does NOT badge (anchored to
 *      "changed since my last visit", not the cumulative drop);
 *   6. no error surface renders (the `there is no parameter $1` class of bug the
 *      SQL-against-real-Postgres run is here to catch).
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the schema applied. Skips
 * cleanly if none is reachable, matching novelty-badge.spec.ts / candidates.spec.ts.
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
const NAME_PREFIX = "e2e-pricechg-";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

let pool: Pool;
let dbAvailable = false;
let profileId: number;
const ids: Record<string, number> = {};

async function seedProfile(prevViewedAt: string, lastViewedAt: string): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      prevViewedAt,
      lastViewedAt,
    ],
  );
  return res.rows[0].id;
}

/**
 * Seeds one matched property with a two-point price history. `curr`/`currAgo`
 * is the latest observation (the one the badge measures); `prev`/`prevAgo` is
 * the one before it. `firstSeenAgo` defaults to 3 days so the listing is NOT new
 * against the ~2h anchor — the price badge shows on its own.
 */
async function seedPriceMove(
  key: string,
  prev: number,
  prevAgo: number,
  curr: number,
  currAgo: number,
  firstSeenAgo = 3 * DAYS,
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}${key}, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  const listing = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4::timestamptz, NOW()) RETURNING id`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, curr, iso(firstSeenAgo)],
  );
  const listingId = listing.rows[0].id;
  await pool.query(
    `INSERT INTO listing_price_history (listing_id, observed_at, price) VALUES
       ($1, $2::timestamptz, $3),
       ($1, $4::timestamptz, $5)`,
    [listingId, iso(prevAgo), prev, iso(currAgo), curr],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
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
      "[price-change-badge.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // Anchored 2h ago (outside the 30-min session debounce, so the page-GET touch
  // shifts previous_viewed_at to 2h ago and holds there for the visit).
  profileId = await seedProfile(iso(3 * DAYS), iso(2 * HOURS));

  // Latest observation 1h ago (> the 2h anchor); previous one 5 days ago.
  await seedPriceMove("bajada", 300000, 5 * DAYS, 274200, 1 * HOURS); // -8.6% → BAJADA
  await seedPriceMove("subida", 300000, 5 * DAYS, 323100, 1 * HOURS); // +7.7% → SUBIDA
  await seedPriceMove("noise", 300000, 5 * DAYS, 299700, 1 * HOURS); // -0.1% → no badge
  await seedPriceMove("suspect", 300000, 5 * DAYS, 12000, 1 * HOURS); // -96%  → no badge
  // Both observations BEFORE the anchor: the move is real but stale, so it must
  // NOT badge (the signal is "changed since my last visit", not cumulative).
  await seedPriceMove("preanchor", 300000, 10 * DAYS, 274200, 5 * DAYS); // -8.6% but pre-anchor
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM listing_price_history WHERE listing_id IN (SELECT id FROM listing WHERE external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
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
const priceBadge = (page: Page, key: string) =>
  cardFor(page, key).getByTestId("candidate-price-change");

test("BAJADA / SUBIDA badge for band-clearing drops and rises; noise, suspect and pre-anchor moves do NOT badge", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // Real content rendered (not a skeleton/empty state): every seeded card shows.
  await expect(cardFor(page, "bajada")).toBeVisible();

  // (1) A -8.6% drop → BAJADA, positive --up tone, price_drop hook.
  const bajada = priceBadge(page, "bajada");
  await expect(bajada).toBeVisible();
  await expect(bajada).toHaveText(/BAJADA/);
  await expect(bajada).toHaveText(/8,6\s*%/);
  await expect(bajada).toHaveAttribute("data-novelty", "price_drop");

  // (2) A +7.7% rise → SUBIDA, --down tone, price_up hook.
  const subida = priceBadge(page, "subida");
  await expect(subida).toBeVisible();
  await expect(subida).toHaveText(/SUBIDA/);
  await expect(subida).toHaveText(/7,7\s*%/);
  await expect(subida).toHaveAttribute("data-novelty", "price_up");

  // (3) -0.1% noise → no badge. (4) -96% suspect → no badge.
  await expect(priceBadge(page, "noise")).toHaveCount(0);
  await expect(priceBadge(page, "suspect")).toHaveCount(0);

  // (5) A real -8.6% move, but both observations predate the anchor → no badge.
  await expect(cardFor(page, "preanchor")).toBeVisible();
  await expect(priceBadge(page, "preanchor")).toHaveCount(0);
});
