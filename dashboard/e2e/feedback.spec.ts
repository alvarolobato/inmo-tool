/**
 * E2E: feedback controls on the candidate list (task 3.1, #20, EC-1).
 *
 * Same rationale/pattern as candidates.spec.ts: a mocked unit test can
 * assert the API's SQL is correct without ever proving a click in a real
 * browser actually reaches it and the resulting state survives a reload —
 * exactly what EC-1 requires. Skips cleanly if no DB is reachable.
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

// Distinct from candidates.spec.ts's/map.spec.ts's coordinates so this
// file's seed can never be picked up by another spec's production-code
// geographic scan when Playwright runs specs concurrently.
const COORDS: [number, number] = [40.20, -3.95];
const NAME_PREFIX = "e2e-feedback-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let propertyId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[feedback.spec] no reachable Postgres - skipping e2e suite.");
    return;
  }

  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: COORDS, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  const propertyResult = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 65, $3) RETURNING id`,
    [COORDS[0], COORDS[1], `${NAME_PREFIX}Calle de prueba`],
  );
  propertyId = propertyResult.rows[0].id;

  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 250000, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`],
  );

  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
  await pool.query("DELETE FROM listing WHERE property_id = $1", [propertyId]);
  await pool.query("DELETE FROM property WHERE id = $1", [propertyId]);
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

test("reject persists and survives reload", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);
  await expect(card).toBeVisible();

  const rejectButton = card.getByTestId("feedback-reject");
  await expect(rejectButton).toBeVisible();
  await expect(rejectButton).toHaveAttribute("aria-pressed", "false");

  // Wait for the persistence POST to actually COMPLETE, not just for the
  // optimistic aria-pressed flip. The button flips to "true" the instant the
  // click handler runs, before the write has committed; reloading in that
  // window occasionally re-fetched state the POST hadn't landed yet, and the
  // reloaded button came back "false". This was a genuine ~1-in-3 flake in CI
  // and locally — the test's bug, not the app's. Gate the reload on the write.
  const [feedbackResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        /\/feedback(\?|$)/.test(new URL(r.url()).pathname) &&
        r.request().method() === "POST",
    ),
    rejectButton.click(),
  ]);
  expect(feedbackResponse.ok()).toBe(true);
  await expect(rejectButton).toHaveAttribute("aria-pressed", "true");

  // Clicking the reject button must not navigate to the property detail
  // page — this is the whole reason FeedbackControls sits outside the
  // card's <Link> rather than nested inside it.
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));

  await page.reload();
  await assertNoErrorSurface(page);
  const rejectButtonAfterReload = page
    .locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`)
    .getByTestId("feedback-reject");
  await expect(rejectButtonAfterReload).toHaveAttribute("aria-pressed", "true");
});

test("submitting a note does not change the accept/reject/star toggle state", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // Set the toggle state within this test rather than relying on a prior
  // test's leftover state (each test should be independently seedable —
  // Playwright doesn't guarantee execution order or isolation between
  // files/workers).
  const card = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);
  await card.getByTestId("feedback-reject").click();
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");

  await card.getByTestId("feedback-note-toggle").click();
  await card.getByTestId("feedback-note-input").fill("revisar estado de la cocina");
  await card.getByTestId("feedback-note-submit").click();

  await expect(card.getByText(/guardada/i)).toBeVisible();
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");
});

test("accept -> star -> reject transitions replace the active toggle each time", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);

  await card.getByTestId("feedback-accept").click();
  await expect(card.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("feedback-star")).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false");

  await card.getByTestId("feedback-star").click();
  await expect(card.getByTestId("feedback-star")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "false");

  await card.getByTestId("feedback-reject").click();
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("feedback-star")).toHaveAttribute("aria-pressed", "false");

  // Survives a reload as the latest of the three transitions, not an
  // earlier one — proves "current state" really reads the most recent event.
  await page.reload();
  await assertNoErrorSurface(page);
  const cardAfterReload = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);
  await expect(cardAfterReload.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");
});
