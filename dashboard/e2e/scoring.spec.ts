/**
 * E2E: cold-start ordering + scoring pipeline wiring (task 3.4, #23).
 *
 * EC-1: a fresh profile shows a non-empty, sensibly-ordered candidate list
 * (highest score first) rather than an empty or arbitrarily-ordered one —
 * seeds pre-computed cold-start-style scores directly (matching
 * pipeline.test.ts's already-unit-tested computeColdStartScore formula)
 * rather than re-deriving them here, since what this test needs to prove is
 * that the UI actually *renders* candidates in score order (candidates.ts's
 * new per-page sort), not re-prove the formula itself.
 *
 * EC-4: recording feedback on one candidate updates *other*, unrelated
 * candidates' scores too — proof that a feedback-triggered retrain rescores
 * the whole matched pool (task 3.2's design), not just the one candidate
 * that received feedback. This one goes through the real feedback API route
 * (not a direct DB write) since the whole point is exercising the real
 * retrain trigger.
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

// Distinct coordinates from every other e2e spec's seed, same reasoning as
// feedback.spec.ts: specs can run concurrently and each production-code
// geographic scan must only ever see its own file's data.
const COLD_START_COORDS: [number, number] = [40.05, -3.55];
const RESCORE_COORDS: [number, number] = [39.90, -3.40];
const NAME_PREFIX = "e2e-scoring-";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[scoring.spec] no reachable Postgres - skipping e2e suite.");
  }
});

test.afterAll(async () => {
  if (dbAvailable) await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

async function insertProperty(coords: [number, number], m2Built = 70): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
    [coords[0], coords[1], m2Built, `${NAME_PREFIX}Calle de prueba`],
  );
  return result.rows[0].id;
}

async function insertListing(propertyId: number, price = 250000): Promise<void> {
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', $3, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
  );
}

async function createProfile(coords: [number, number]): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center: coords, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  return result.rows[0].id;
}

async function markMatched(profileId: number, propertyId: number, score: number | null, explanation: string | null) {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, rank_explanation)
     VALUES ($1, $2, true, $3, $4)`,
    [profileId, propertyId, score, explanation],
  );
}

test.describe("cold-start ordering (EC-1)", () => {
  let profileId: number;
  const propertyIds: number[] = [];

  test.beforeAll(async () => {
    if (!dbAvailable) return;
    profileId = await createProfile(COLD_START_COORDS);

    // Three candidates with distinct, pre-computed cold-start-style scores
    // (highest = best per computeColdStartScore's "cheaper wins" direction)
    // — deliberately not the actual property_id insertion order, so a test
    // passing would prove the UI really sorts by score, not just that it
    // happens to preserve whatever order they were inserted in.
    const best = await insertProperty(COLD_START_COORDS);
    await insertListing(best, 100000);
    await markMatched(profileId, best, 0.8, "Sin personalizar todavía");
    propertyIds.push(best);

    const worst = await insertProperty(COLD_START_COORDS);
    await insertListing(worst, 500000);
    await markMatched(profileId, worst, 0.2, "Sin personalizar todavía");
    propertyIds.push(worst);

    const middle = await insertProperty(COLD_START_COORDS);
    await insertListing(middle, 250000);
    await markMatched(profileId, middle, 0.5, "Sin personalizar todavía");
    propertyIds.push(middle);
  });

  test.afterAll(async () => {
    if (!dbAvailable) return;
    await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
    await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
    if (propertyIds.length > 0) {
      await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [propertyIds]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [propertyIds]);
    }
  });

  test("new profile shows cold-start ordering", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}`);
    await assertNoErrorSurface(page);

    const cards = page.getByTestId("candidate-card");
    await expect(cards).toHaveCount(3);

    // Seeded (insertion order) as [best=0.8, worst=0.2, middle=0.5] —
    // deliberately not score order, so a passing assertion proves the UI
    // actually sorts by score (candidates.ts's new per-page sort), not that
    // it happens to preserve insertion/id order. Expected render order,
    // highest score first: best, middle, worst.
    const [bestId, worstId, middleId] = propertyIds;
    const renderedIds = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-property-id")));
    expect(renderedIds).toEqual([String(bestId), String(middleId), String(worstId)]);

    // Every candidate has a real, non-blank explanation — none sat at
    // score=NULL with a missing/blank rank-explanation, which is the actual
    // "sensibly ordered, not blank" failure mode EC-1 guards against.
    await expect(page.getByTestId("rank-explanation")).toHaveCount(3);
  });
});

test.describe("feedback rescoring the whole pool (EC-4)", () => {
  let profileId: number;
  const fillerIds: number[] = [];
  let bystanderId: number;
  let clickedId: number;

  test.beforeAll(async () => {
    if (!dbAvailable) return;
    profileId = await createProfile(RESCORE_COORDS);

    // MIN_TRAINING_EXAMPLES is 32 at the current 8-feature model
    // (pipeline.test.ts asserts this directly) — seed 31 filler
    // accept/reject examples directly (fast; the point of this test is
    // "does one more click rescore everyone", not re-proving the training
    // loop itself, which task 3.2/3.3's own tests already cover) so a
    // single real UI click provides the 32nd example and crosses the
    // threshold for real, through the real feedback route.
    for (let i = 0; i < 15; i++) {
      const acceptId = await insertProperty(RESCORE_COORDS);
      await insertListing(acceptId, 150000);
      await markMatched(profileId, acceptId, null, null);
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'accept')`,
        [profileId, acceptId],
      );
      fillerIds.push(acceptId);

      const rejectId = await insertProperty(RESCORE_COORDS);
      await insertListing(rejectId, 450000);
      await markMatched(profileId, rejectId, null, null);
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'reject')`,
        [profileId, rejectId],
      );
      fillerIds.push(rejectId);
    }
    // 30 filler examples so far (15 accept + 15 reject) — one more reject
    // filler brings it to 31, still below the 32 threshold.
    const lastFillerReject = await insertProperty(RESCORE_COORDS);
    await insertListing(lastFillerReject, 480000);
    await markMatched(profileId, lastFillerReject, null, null);
    await pool.query(`INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'reject')`, [
      profileId,
      lastFillerReject,
    ]);
    fillerIds.push(lastFillerReject);

    // The bystander: matched, unlabeled, no feedback of its own — this is
    // what EC-4 actually checks. It must still be at a cold-start (or null)
    // score before the click below, and change afterward.
    bystanderId = await insertProperty(RESCORE_COORDS, 90);
    await insertListing(bystanderId, 120000);
    await markMatched(profileId, bystanderId, null, null);

    // The candidate the test will actually click "accept" on — this is
    // example #32, crossing the threshold for real.
    clickedId = await insertProperty(RESCORE_COORDS);
    await insertListing(clickedId, 200000);
    await markMatched(profileId, clickedId, null, null);
  });

  test.afterAll(async () => {
    if (!dbAvailable) return;
    await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
    await pool.query("DELETE FROM profile_scoring_model WHERE profile_id = $1", [profileId]);
    await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
    await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
    const allIds = [...fillerIds, bystanderId, clickedId];
    await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [allIds]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [allIds]);
  });

  test("feedback on one candidate updates others' scores", async ({ page }) => {
    skipIfNoDb(test);

    const before = await pool.query<{ score: string | null }>(
      "SELECT score FROM profile_listing_state WHERE profile_id = $1 AND property_id = $2",
      [profileId, bystanderId],
    );
    const scoreBefore = before.rows[0].score;

    await page.goto(`/profiles/${profileId}`);
    await assertNoErrorSurface(page);

    const clickedCard = page.locator(`[data-testid="candidate-card"][data-property-id="${clickedId}"]`);
    await expect(clickedCard).toBeVisible();
    // Explicitly wait for the feedback POST's response (not just the
    // resulting UI state) — the retrain that matters for this test's
    // assertion runs server-side inside that same request/response cycle,
    // so waiting on the network response is the real signal, not a proxy.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/feedback") && r.request().method() === "POST"),
      clickedCard.getByTestId("feedback-accept").click(),
    ]);
    expect(response.status()).toBe(201);
    await expect(clickedCard.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");

    const after = await pool.query<{ score: string | null }>(
      "SELECT score FROM profile_listing_state WHERE profile_id = $1 AND property_id = $2",
      [profileId, bystanderId],
    );
    const scoreAfter = after.rows[0].score;

    expect(scoreAfter).not.toBeNull();
    expect(scoreAfter).not.toBe(scoreBefore);
  });
});
