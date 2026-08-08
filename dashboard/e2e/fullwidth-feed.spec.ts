/**
 * E2E (D-041): the candidate feed `/profiles/[id]` is full-width.
 *
 * Feed UX F1 (#464): the feed page dropped its `maxWidth: 960` reading column
 * for a full-viewport `<div>` (also fixing an invalid nested `<main>` — the root
 * layout already renders `main.main-content`), and the candidate grid uses
 * `repeat(auto-fill, minmax(280px, 1fr))`. On a wide viewport that must resolve
 * to several columns instead of the ~3 the old 960px cap allowed.
 *
 * This is the regression net for that behaviour: it seeds enough candidates to
 * fill more than one row, loads the feed at 1920×1080, and asserts the FIRST
 * ROW of cards holds ≥4 columns (grouped by bounding-box y, distinct x). Under
 * the old capped layout the first row could hold at most 3 (960 / 280), so this
 * fails if the full-width change is reverted. It also asserts no error surface
 * and that at least one card renders.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the schema applied. Skips
 * cleanly if no DB is reachable, matching candidates.spec.ts.
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
const NAME_PREFIX = "e2e-fullwidth-";
// 12 cards comfortably overflow the first row at 1920px wide
// (≈6 columns of minmax(280px,1fr)), leaving a second row to prove wrapping.
const CANDIDATE_COUNT = 12;

let pool: Pool;
let dbAvailable = false;
let profileId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[fullwidth-feed.spec] no reachable Postgres - skipping e2e suite. " +
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

  async function insertCandidate(index: number): Promise<void> {
    const property = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], 60 + index, `${NAME_PREFIX}Piso ${index}, Madrid`],
    );
    const propertyId = property.rows[0].id;
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', $3, NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, 300000 + index * 1000],
    );
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    await insertCandidate(i);
  }
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
  await expect(
    page.getByText(
      /ErrorDisplay|Detalles técnicos|there is no parameter|http 500|Error al cargar/i,
    ),
  ).toHaveCount(0);
}

// A wide desktop viewport — the whole point of the feature.
test.use({ viewport: { width: 1920, height: 1080 } });

test("the candidate feed renders ≥4 columns on a 1920px viewport", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThanOrEqual(CANDIDATE_COUNT);

  // Bounding boxes of every card. Group by top (y) into rows — cards sharing a
  // row have near-equal y — then take the row with the smallest y (the first
  // row) and count its distinct x positions: that's the visible column count.
  const boxes: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const box = await cards.nth(i).boundingBox();
    if (box) boxes.push({ x: box.x, y: box.y });
  }
  expect(boxes.length).toBeGreaterThan(0);

  const firstRowY = Math.min(...boxes.map((b) => b.y));
  const rowTolerance = 20; // px — same-row cards align within a few px
  const firstRowXs = new Set(
    boxes
      .filter((b) => Math.abs(b.y - firstRowY) <= rowTolerance)
      .map((b) => Math.round(b.x)),
  );

  // Old capped layout (maxWidth 960 / 280px min) fit at most 3 columns; the
  // full-width grid must fit at least 4.
  expect(firstRowXs.size).toBeGreaterThanOrEqual(4);
});
