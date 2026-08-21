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

/**
 * Seeds a matched, scored candidate (fixed 70 m², so price drives €/m²).
 *
 * `dropFrom` (optional): seeds a price history that drops from that price to
 * `price` AFTER the profile's visit anchor, so the card also shows a BAJADA
 * direction chip. Used to stress the price line with THREE elements (price +
 * below-market chip + direction chip) at the min card width — the exact #460
 * wrap scenario, where the below-market chip must stay on the price line.
 */
async function seedProp(
  key: string,
  price: number,
  score: number | null,
  dropFrom?: number,
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}${key}, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  const listing = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, NOW() - interval '3 days', NOW()) RETURNING id`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
  );
  if (dropFrom !== undefined) {
    // A drop from `dropFrom` → `price`, both observations RECENT (last hour) so
    // the move lands AFTER the visit anchor and produces a badge-worthy BAJADA
    // (within the 1%–60% band). The anchor is `previous_viewed_at`, which the
    // first page visit shifts to `last_viewed_at` (seeded at -2h) and the 30-min
    // debounce then holds stable — so a sub-2h move stays visible across every
    // repeat-each run (a -1d move would fall before the shifted anchor).
    await pool.query(
      `INSERT INTO listing_price_history (listing_id, observed_at, price) VALUES
         ($1, NOW() - interval '90 minutes', $2),
         ($1, NOW() - interval '30 minutes', $3)`,
      [listing.rows[0].id, dropFrom, price],
    );
  }
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
  // 7-digit prices (millones) so the price LABEL is wide — the #460 wrap only
  // bites when the price + chips genuinely can't share one line at the min card
  // width, and a wide price is what makes that reproducible & deterministic.
  // At-market fillers establish the pool median (≥ MIN_POOL_SIZE priced).
  for (let i = 0; i < 3; i++) {
    await seedProp(`filler${i}`, 3000000, 0.3);
  }
  // A DEAL: ~40% below the 3M pool median → GREEN chip. Also dropped from 3.2M
  // → BAJADA direction chip, so its price line carries THREE elements (price +
  // below-market chip + direction chip): the exact narrow-width wrap scenario.
  await seedProp("deal", 1800000, 0.5, 3200000);
  // A PREMIUM: above the pool median → RED chip.
  await seedProp("premium", 4800000, 0.5);
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

  // #460: render at the TRUE min card width. The feed grid is
  // `repeat(auto-fill, minmax(280px, 1fr))` (CandidateList) — a hard 280px
  // minimum. A narrow viewport forces exactly one 280px column, the worst case
  // where the price + below-market chip + direction chip must share one line.
  // At the default 1280px viewport cards are wide and the wrap never bites, so
  // the bug was invisible here; this pins the real narrow width deterministically.
  await page.setViewportSize({ width: 340, height: 900 });

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

  // The deal ALSO carries a BAJADA direction chip, so its price line has THREE
  // elements (price + below-market chip + direction chip). At the min card width
  // that no longer fits on one line — the exact #460 wrap. The below-market chip
  // must still stay WITH the price (only the less-critical direction chip may
  // wrap): this is what the pre-fix layout got wrong (the whole signals group
  // wrapped below the price), and what the nowrap price+chip group fixes.
  await expect(deal.getByTestId("price-direction")).toBeVisible();

  // (1): the chip is on the SAME line, immediately after the price. We encode
  // that INTENT robustly rather than pinning a brittle exact pixel gap (a tight
  // x-gap threshold flaked under CI render/font timing — seen ~39.5 vs a ~25px
  // bound, deflaked in #499). The price (<p>) and the below-market chip live
  // in one `flex-wrap: nowrap` group (PriceSignals price mode), so they can
  // never land on different lines — "same line" means their vertical centres
  // coincide; a stacked/wrapped chip would sit a full line-height below and
  // fail. The chip must also sit to the RIGHT of the price and be reasonably
  // close (a generous gap, not an exact pixel value).
  //
  // #539: reading `priceBox`/`ratingBox` via two SEPARATE, sequential
  // `.boundingBox()` calls (each its own CDP round trip) let a reflow ABOVE
  // this card — most plausibly the `next/font` `display:"swap"` fallback→real
  // swap, whose metric-matched fallback prevents CLS for THIS card's own
  // single-line text but does not guarantee zero shift page-wide — land in
  // the gap between the two reads on a loaded CI runner, comparing two
  // DIFFERENT paint frames instead of one. Forcing that exact race locally
  // (an artificial reflow injected between the two old calls) reproduced the
  // reported numbers bit for bit: diff 38 vs threshold 12.75. The nowrap
  // grouping itself is not in question — reproducing an actual wrap (reverting
  // PriceSignals.tsx's inner `flexWrap: "nowrap"` to `"wrap"`) still fails
  // this assertion below, confirming it still guards #460's real invariant.
  //
  // Fix: read both rects in ONE `evaluate()` — a single JS execution against a
  // single committed layout/paint, so no reflow can land between them.
  await expect(dealRating).toBeVisible();
  const boxes = await deal.evaluate((cardEl) => {
    const price = cardEl.querySelector('[data-testid="candidate-price"]');
    const rating = cardEl.querySelector('[data-testid="price-rating"]');
    if (!price || !rating) return null;
    const p = price.getBoundingClientRect();
    const r = rating.getBoundingClientRect();
    return {
      price: { x: p.x, y: p.y, width: p.width, height: p.height },
      rating: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  });
  expect(boxes).not.toBeNull();
  const { price: priceBox, rating: ratingBox } = boxes!;
  const priceMidY = priceBox.y + priceBox.height / 2;
  const ratingMidY = ratingBox.y + ratingBox.height / 2;
  // Same line: vertical centres aligned (well within half the price height — a
  // wrapped-below chip would be ~a full line-height away and fail this).
  expect(Math.abs(priceMidY - ratingMidY)).toBeLessThan(priceBox.height / 2);
  // To the RIGHT of the price, starting at/after its right edge (small epsilon
  // for sub-pixel rounding) and within a generous horizontal gap — "next to the
  // price", not an exact pixel distance.
  const EPSILON = 4;
  const gap = ratingBox.x - (priceBox.x + priceBox.width);
  expect(ratingBox.x).toBeGreaterThan(priceBox.x);
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
