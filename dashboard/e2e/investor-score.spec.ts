/**
 * E2E (D-041): the #452 investor score — the 0–100 + colour band chip on the
 * feed card and the "Puntuación inversora" breakdown on the property detail
 * page, against a real Next.js server + seeded Postgres.
 *
 * The fixture SEEDS ITS OWN scored candidates (base `profile_listing_state.score`),
 * days-on-market (a past `first_seen_at`), a net price drop (`listing_price_history`),
 * and a warn-tone occupancy caveat (an `ai_assessment` row) — so it never relies
 * on ambient data.
 *
 * What it proves:
 *   1. a scored card shows the investor-score chip with a 0–100 value + band, and
 *      its tooltip carries the (already-computed) ranking_boost_reason;
 *   2. a never-scored card shows "Sin puntuar" (grade none), never a number;
 *   3. the detail "Puntuación inversora" section renders, and its per-term points
 *      sum EXACTLY to the shown total;
 *   4. the detail shows a risk chip (never subtracted);
 *   5. no error surface renders (the SQL-against-real-Postgres regression guard).
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the split POSTGRES_* vars) with
 * the schema applied. Skips cleanly if none is reachable, matching
 * price-change-badge.spec.ts / candidates.spec.ts.
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
const NAME_PREFIX = "e2e-invscore-";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAYS = 24 * 60 * 60 * 1000;

let pool: Pool;
let dbAvailable = false;
let profileId: number;
const ids: Record<string, number> = {};

async function seedProfile(): Promise<number> {
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
      // Anchored well in the past so nothing tiers as "new" — isolates the score.
      iso(30 * DAYS),
      iso(29 * DAYS),
    ],
  );
  return res.rows[0].id;
}

/**
 * Seeds one matched candidate. `score` null → never-scored ("Sin puntuar").
 * `firstSeenDaysAgo` drives days-on-market; `priceHistory` a net drop; `caveat`
 * a warn-tone occupancy caveat (a risk chip + a distress boost).
 */
async function seedCandidate(
  key: string,
  opts: {
    price: number;
    score: number | null;
    firstSeenDaysAgo?: number;
    priceHistory?: { price: number; daysAgo: number }[];
    caveat?: string;
  },
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}${key}, Madrid`],
  );
  const propertyId = Number(prop.rows[0].id);
  const listing = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4::timestamptz, NOW()) RETURNING id`,
    [
      propertyId,
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      opts.price,
      iso((opts.firstSeenDaysAgo ?? 3) * DAYS),
    ],
  );
  const listingId = Number(listing.rows[0].id);
  for (const p of opts.priceHistory ?? []) {
    await pool.query(
      `INSERT INTO listing_price_history (listing_id, observed_at, price)
       VALUES ($1, $2::timestamptz, $3)`,
      [listingId, iso(p.daysAgo * DAYS), p.price],
    );
  }
  if (opts.caveat) {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, 'occupancy', $2::jsonb, 'occupancy/v1', NOW())`,
      [propertyId, JSON.stringify({ caveats: [opts.caveat] })],
    );
  }
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, score_kind, rank_explanation)
     VALUES ($1, $2, true, $3, $4, NULL)`,
    [profileId, propertyId, opts.score, opts.score === null ? null : "trained"],
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
      "[investor-score.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  profileId = await seedProfile();

  // A high-scoring "deal": below-market price, long on market, a net drop, and a
  // debt-sale caveat → a top-band score with a rich, summing breakdown + a chip.
  await seedCandidate("deal", {
    price: 150000, // well below the 300k pool median → below-market boost
    score: 0.85,
    firstSeenDaysAgo: 300,
    priceHistory: [
      { price: 220000, daysAgo: 200 },
      { price: 150000, daysAgo: 5 },
    ],
    caveat: "venta_deuda",
  });
  // Pool fillers at market to establish the ~300k median.
  await seedCandidate("mid1", { price: 300000, score: 0.4 });
  await seedCandidate("mid2", { price: 300000, score: 0.4 });
  // A never-scored candidate → "Sin puntuar".
  await seedCandidate("unscored", { price: 300000, score: null });
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM ai_assessment WHERE property_id IN (SELECT id FROM property WHERE address LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
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

// D-041: assert no error surface is rendered anywhere on the page.
async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(
      /there is no parameter|http 500|error al cargar|detalles técnicos/i,
    ),
  ).toHaveCount(0);
}

const cardFor = (page: Page, key: string) =>
  page.locator(`[data-testid="candidate-card"][data-property-id="${ids[key]}"]`);

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("feed card shows the 0–100 investor-score chip with a band; never-scored shows 'Sin puntuar'", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // Real content rendered (not a skeleton/empty state).
  await expect(cardFor(page, "deal")).toBeVisible();

  // (1) The deal card carries a numeric score chip with a band grade.
  const dealChip = cardFor(page, "deal").getByTestId("investor-score-chip");
  await expect(dealChip).toBeVisible();
  const grade = await dealChip.getAttribute("data-grade");
  expect(["A", "B", "C", "D"]).toContain(grade);
  const scoreStr = await dealChip.getAttribute("data-score");
  const scoreNum = Number(scoreStr);
  expect(Number.isInteger(scoreNum)).toBe(true);
  expect(scoreNum).toBeGreaterThanOrEqual(0);
  expect(scoreNum).toBeLessThanOrEqual(100);
  // Tooltip = the already-computed ranking_boost_reason (the deal has boosts).
  const title = await dealChip.getAttribute("title");
  expect(title && title.length > 0).toBeTruthy();

  // (2) The never-scored card shows "Sin puntuar" (grade none), never a number.
  const unscoredChip = cardFor(page, "unscored").getByTestId("investor-score-chip");
  await expect(unscoredChip).toBeVisible();
  await expect(unscoredChip).toHaveText(/Sin puntuar/);
  await expect(unscoredChip).toHaveAttribute("data-grade", "none");
});

test("detail 'Puntuación inversora' breakdown sums to the score and shows risk chips (never subtracted)", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${ids.deal}`);
  await assertNoErrorSurface(page);

  const section = page.getByTestId("investor-score-section");
  await expect(section).toBeVisible();

  // (3) The per-term points sum EXACTLY to the shown total.
  const total = Number(await section.getByTestId("investor-score-total").innerText());
  const termLoc = section.getByTestId("investor-score-term");
  const count = await termLoc.count();
  expect(count).toBeGreaterThan(0);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += Number(await termLoc.nth(i).getAttribute("data-points"));
  }
  expect(sum).toBe(total);
  expect(total).toBeGreaterThan(0);

  // (4) A risk chip is shown (the venta_deuda caveat), and the section labels it
  // as not subtracting from the score.
  await expect(section.getByTestId("investor-score-risk-chip").first()).toBeVisible();
  await expect(section.getByText(/no restan/i)).toBeVisible();
});

test("detail of a never-scored property shows 'Sin puntuar' without an error surface", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${ids.unscored}`);
  await assertNoErrorSurface(page);

  const section = page.getByTestId("investor-score-section");
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute("data-grade", "none");
  await expect(section.getByText(/Sin puntuar/)).toBeVisible();
});
