/**
 * E2E (D-041): the "En seguimiento" price-drop alerting surfaces (#428, plan
 * #415 §3.5) against a real Next.js server + seeded Postgres.
 *
 * The fixture SEEDS ITS OWN multi-point price history AND its own feedback
 * (accept = "en seguimiento") — the plan (§2.0a) notes only ~10 demo listings
 * have more than one recorded price and ZERO accept rows ever exist, so this
 * suite never relies on ambient data.
 *
 * What it proves:
 *   1. the in-app indicator counts ONLY tracked (accept) properties with a
 *      recent sanity-banded DROP — a tracked property with no drop, and an
 *      un-tracked property WITH a drop, are both excluded (count = 1);
 *   2. the "En seguimiento" working-set view shows the tracked properties and
 *      hides the un-tracked drop — i.e. a non-tracked drop never triggers a
 *      seguimiento alert;
 *   3. a drop on a tracked property still renders its BAJADA badge (the #420
 *      per-card drill-down behind the count);
 *   4. no error surface renders (the `there is no parameter $1` class of bug the
 *      SQL-against-real-Postgres run exists to catch).
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is reachable,
 * matching price-change-badge.spec.ts / candidates.spec.ts.
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
const NAME_PREFIX = "e2e-seguim-";

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
 * Seeds one matched property. When `prev`/`curr` differ, a two-point price
 * history is written (latest observation `currAgo`). When `track` is true, an
 * `accept` feedback_event marks the property "en seguimiento".
 */
async function seedProperty(
  key: string,
  opts: { prev: number; curr: number; currAgo?: number; track: boolean },
): Promise<number> {
  const currAgo = opts.currAgo ?? 1 * HOURS;
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}${key}, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  // first_seen 2 days ago — clearly BEFORE the visit anchor (≤6h), so nothing
  // is "new" and the novelty tier is driven only by the price move. This keeps
  // is_new deterministic regardless of the profile-GET anchor shift race.
  const listing = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4::timestamptz, NOW()) RETURNING id`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, opts.curr, iso(2 * DAYS)],
  );
  const listingId = listing.rows[0].id;
  if (opts.prev !== opts.curr) {
    await pool.query(
      `INSERT INTO listing_price_history (listing_id, observed_at, price) VALUES
         ($1, $2::timestamptz, $3),
         ($1, $4::timestamptz, $5)`,
      [listingId, iso(5 * DAYS), opts.prev, iso(currAgo), opts.curr],
    );
  } else {
    await pool.query(
      `INSERT INTO listing_price_history (listing_id, observed_at, price) VALUES ($1, $2::timestamptz, $3)`,
      [listingId, iso(5 * DAYS), opts.curr],
    );
  }
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
  );
  if (opts.track) {
    await pool.query(
      `INSERT INTO feedback_event (profile_id, property_id, listing_id, feedback_type)
       VALUES ($1, $2, $3, 'accept')`,
      [profileId, propertyId, listingId],
    );
  }
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
      "[seguimiento-alerts.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // Visited profile (anchor ≤6h ago), so nothing is cold-start on "never
  // visited" grounds. The GET-shift makes the effective anchor ~3h ago.
  profileId = await seedProfile(iso(6 * HOURS), iso(3 * HOURS));

  // Tracked (accept) + a -8.6% drop 1h ago → COUNTS toward the indicator.
  await seedProperty("tracked-drop", { prev: 300000, curr: 274200, track: true });
  // Tracked (accept) but price stable → tracked, but NO drop → must NOT count.
  await seedProperty("tracked-nodrop", { prev: 300000, curr: 300000, track: true });
  // Un-tracked but with the same -8.6% drop → a drop, but not tracked → must
  // NOT count and must NOT appear in the seguimiento view.
  await seedProperty("untracked-drop", { prev: 300000, curr: 274200, track: false });
  // Stable, un-tracked padding so the two price-moved rows stay well under the
  // 60% cold-start coverage threshold (#425) — otherwise the tier is suppressed
  // and non-tracked drop badges would be hidden. 2 moved / 5 total = 40%.
  await seedProperty("pad-1", { prev: 300000, curr: 300000, track: false });
  await seedProperty("pad-2", { prev: 300000, curr: 300000, track: false });
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM listing_price_history WHERE listing_id IN (SELECT id FROM listing WHERE external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM feedback_event WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
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

test("in-app indicator counts only tracked drops; seguimiento view hides untracked drops", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // Real content rendered (not a skeleton / empty state): the tracked drop card shows.
  await expect(cardFor(page, "tracked-drop")).toBeVisible();

  // (1) The in-app indicator counts exactly ONE: the tracked property with a
  // recent banded drop. The tracked-no-drop and the untracked-drop are excluded.
  const count = page.getByTestId("seguimiento-alert-count");
  await expect(count).toBeVisible();
  await expect(count).toHaveText("1");

  // (3) A tracked drop still shows its BAJADA badge (the per-card drill-down).
  await expect(cardFor(page, "tracked-drop").getByTestId("candidate-price-change")).toHaveText(/BAJADA/);
  // The untracked drop is visible in the default feed with its own BAJADA badge
  // (drops are always visible in-feed; only the ALERT is tracked-only).
  await expect(cardFor(page, "untracked-drop").getByTestId("candidate-price-change")).toHaveText(/BAJADA/);

  // (2) Switch to the "En seguimiento" working set: only tracked (accept)
  // properties remain; the untracked drop drops out → a non-tracked drop never
  // becomes a seguimiento alert.
  await page.getByTestId("view-segment-seguimiento").click();
  await expect(cardFor(page, "tracked-drop")).toBeVisible();
  await expect(cardFor(page, "tracked-nodrop")).toBeVisible();
  await expect(cardFor(page, "untracked-drop")).toHaveCount(0);
  await assertNoErrorSurface(page);
});
