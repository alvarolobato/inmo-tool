/**
 * E2E: feedback controls on the candidate list (task 3.1, #20, EC-1).
 *
 * Same rationale/pattern as candidates.spec.ts: a mocked unit test can
 * assert the API's SQL is correct without ever proving a click in a real
 * browser actually reaches it and the resulting state survives a reload —
 * exactly what EC-1 requires. Skips cleanly if no DB is reachable.
 */
import { test, expect, type Page, type Locator, type Response as PWResponse } from "@playwright/test";
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
// A second matched candidate (#379): the feed is never empty after the first
// is rejected, so the deferred-removal test proves "the rejected one drops out
// while the others stay" without depending on the zero-candidates diagnostic.
let bystanderPropertyId: number;

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

  // Second candidate — stays in the feed no matter what the first's verdict is.
  const bystanderResult = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 80, $3) RETURNING id`,
    [COORDS[0], COORDS[1], `${NAME_PREFIX}Calle bystander`],
  );
  bystanderPropertyId = bystanderResult.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 260000, NOW())`,
    [bystanderPropertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, bystanderPropertyId],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  const propIds = [propertyId, bystanderPropertyId];
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
  await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [propIds]);
  await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [propIds]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

// Each test should be independently seedable (Playwright doesn't guarantee
// order/isolation). #379 makes this matter more: a test that ends on 'reject'
// now HIDES the card from the default feed, so a following test would find no
// card at all. Reset the verdict before every test so each starts neutral.
test.beforeEach(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
});

// Every UI page is admin-gated (middleware.ts) — see e2e/helpers/admin-session.ts.
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

const isFeedbackPost = (r: PWResponse) =>
  /\/feedback(\?|$)/.test(new URL(r.url()).pathname) && r.request().method() === "POST";

// The candidate FEED fetch (the list itself), not the per-card feedback GET
// (`/candidates/:id/feedback`) nor the sources GET (`/candidate-sources`) —
// only the bare `.../candidates` path, method GET.
const isCandidatesFetch = (r: PWResponse) =>
  /\/candidates(\?|$)/.test(new URL(r.url()).pathname) && r.request().method() === "GET";

/**
 * #457: click a state toggle (accept/reject) and WAIT for its persistence POST
 * to complete before returning. A state click updates optimistically and then
 * reconciles the button against the server's derived state (FeedbackControls);
 * firing several transitions back-to-back WITHOUT awaiting each POST lets the
 * browser deliver the concurrent POSTs — and the server record the events —
 * out of order, so both the optimistic UI and the persisted "latest event" end
 * up wrong. That raced ~1-in-3 on CI and tanked unrelated PRs (#412/#449).
 * Serialising each transition on its POST makes the sequence deterministic
 * without weakening any assertion — the transitions and their outcomes are all
 * still proven, just in a guaranteed order (which is what a human clicking one
 * button at a time actually produces).
 */
async function clickStateAndWait(page: Page, button: Locator) {
  const [res] = await Promise.all([page.waitForResponse(isFeedbackPost), button.click()]);
  expect(res.ok()).toBe(true);
  return res;
}

/**
 * #457: perform an action that triggers a feed REFETCH (reload, or flipping a
 * filter/toggle) and wait for that GET to complete before asserting. Without
 * this gate, a negative assertion (e.g. "the rejected card is gone") can pass
 * against the transient loading state — the old feed cleared, the new one not
 * yet arrived — rather than against the refetched feed it means to check.
 */
async function actAndWaitForFeed(page: Page, action: () => Promise<unknown>) {
  await Promise.all([page.waitForResponse(isCandidatesFetch), action()]);
}

test("reject defers removal: card stays this session, is gone on reload, and the show-rejected toggle un-rejects it (#379)", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cardSel = `[data-testid="candidate-card"][data-property-id="${propertyId}"]`;
  const card = page.locator(cardSel);
  await expect(card).toBeVisible();

  const rejectButton = card.getByTestId("feedback-reject");
  await expect(rejectButton).toHaveAttribute("aria-pressed", "false");

  // Reject. Wait for the persistence POST to COMPLETE (not just the optimistic
  // flip) so the reload below observes committed state — a genuine ~1-in-3
  // flake otherwise (the test's bug, not the app's).
  await clickStateAndWait(page, rejectButton);

  // Deferred removal (#379): the card does NOT vanish on click — it stays this
  // session, visibly marked (reject pressed + the "Descartada" badge), so the
  // user keeps their place.
  await expect(rejectButton).toHaveAttribute("aria-pressed", "true");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("candidate-rejected-badge")).toBeVisible();
  // Clicking reject must not navigate (FeedbackControls sits outside the Link).
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));

  // Next browse: the reject is now excluded server-side, so the rejected card
  // is gone from the default feed — while the bystander candidate stays, so
  // this proves targeted removal, not an emptied feed. Gate on the feed refetch
  // (#457) so the "gone" assertion below runs against the reloaded feed, not the
  // transient loading state.
  await actAndWaitForFeed(page, () => page.reload());
  await assertNoErrorSurface(page);
  await expect(
    page.locator(`[data-testid="candidate-card"][data-property-id="${bystanderPropertyId}"]`),
  ).toBeVisible();
  await expect(page.locator(cardSel)).toHaveCount(0);

  // Show-rejected toggle: the rejected card reappears, still marked. Flipping it
  // triggers a feed refetch (includeRejected=true) — wait for it before
  // asserting the card is back (#457).
  await actAndWaitForFeed(page, () =>
    page.getByTestId("view-segment-descartadas").click(),
  );
  const cardAgain = page.locator(cardSel);
  await expect(cardAgain).toBeVisible();
  await expect(cardAgain.getByTestId("candidate-rejected-badge")).toBeVisible();
  await expect(cardAgain.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");

  // Un-reject: clicking the active reject clears the verdict. The card stays
  // (show-rejected is on) but is no longer marked.
  await clickStateAndWait(page, cardAgain.getByTestId("feedback-reject"));
  await expect(cardAgain.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false");
  await expect(cardAgain.getByTestId("candidate-rejected-badge")).toHaveCount(0);

  // The un-reject persists: with the toggle off, the property is back in the
  // default feed, unmarked. The toggle-off triggers a feed refetch — wait for
  // it before asserting the card reappears (#457).
  await actAndWaitForFeed(page, () =>
    page.getByTestId("view-segment-todas").click(),
  );
  const cardDefault = page.locator(cardSel);
  await expect(cardDefault).toBeVisible();
  await expect(cardDefault.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false");
});

test("submitting a note does not change the seguir/descartar toggle state", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // Set the toggle state within this test rather than relying on a prior
  // test's leftover state (each test should be independently seedable —
  // Playwright doesn't guarantee execution order or isolation between
  // files/workers).
  const card = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);
  // Wait for the reject to persist (#457) so its reconciliation can't land
  // during — and clobber — the note submission below.
  await clickStateAndWait(page, card.getByTestId("feedback-reject"));
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");

  await card.getByTestId("feedback-note-toggle").click();
  await card.getByTestId("feedback-note-input").fill("revisar estado de la cocina");
  await card.getByTestId("feedback-note-submit").click();

  await expect(card.getByText(/guardada/i)).toBeVisible();
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");
});

test("seguir(accept) <-> descartar(reject) transitions replace the active toggle each time; the star button is gone (#422)", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);

  // #422: only two state buttons exist now — accept ("Seguir") and reject.
  await expect(card.getByTestId("feedback-star")).toHaveCount(0);

  // Each transition waits for its own POST to commit before the next click
  // (#457) — un-awaited back-to-back clicks let the concurrent POSTs, and the
  // recorded events, land out of order, flipping the toggle back and tanking
  // this assertion ~1-in-3 on CI. Serialising proves every transition in a
  // guaranteed order without weakening what's asserted.
  await clickStateAndWait(page, card.getByTestId("feedback-accept"));
  await expect(card.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false");
  // Accepting a property marks it "en seguimiento".
  await expect(card.getByTestId("candidate-tracked-badge")).toBeVisible();
  await expect(card).toHaveAttribute("data-tracked", "true");

  await clickStateAndWait(page, card.getByTestId("feedback-reject"));
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByTestId("candidate-tracked-badge")).toHaveCount(0);

  // Land on 'accept' (a state the default feed still shows — #379 hides only
  // 'reject' on reload) and gate the reload on its write committing, so the
  // reload observes the latest event, not an earlier one.
  await clickStateAndWait(page, card.getByTestId("feedback-accept"));
  await expect(card.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false");

  // Survives a reload as the latest of the transitions, not an earlier one —
  // proves "current state" really reads the most recent event. Gate on the feed
  // refetch (#457) so the assertion runs against the reloaded feed.
  await actAndWaitForFeed(page, () => page.reload());
  await assertNoErrorSurface(page);
  const cardAfterReload = page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);
  await expect(cardAfterReload.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");
});

test("#422: accepting a property adds it to the 'En seguimiento' view; the star button no longer exists", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cardSel = `[data-testid="candidate-card"][data-property-id="${propertyId}"]`;
  const card = page.locator(cardSel);
  await expect(card).toBeVisible();

  // The star ("destacar") toggle is gone — only seguir/descartar remain.
  await expect(card.getByTestId("feedback-star")).toHaveCount(0);

  // Follow (accept) the property, waiting for the write to commit so the
  // seguimiento view below reads committed state.
  await clickStateAndWait(page, card.getByTestId("feedback-accept"));
  await expect(card.getByTestId("candidate-tracked-badge")).toBeVisible();

  // Turn on the "En seguimiento" preset: only the tracked property remains,
  // the (untracked) bystander drops out. The preset triggers a feed refetch
  // (state=accept) — wait for it before asserting the narrowed feed (#457).
  await actAndWaitForFeed(page, () =>
    page.getByTestId("view-segment-seguimiento").click(),
  );
  await assertNoErrorSurface(page);
  const trackedCard = page.locator(cardSel);
  await expect(trackedCard).toBeVisible();
  await expect(trackedCard.getByTestId("candidate-tracked-badge")).toBeVisible();
  await expect(
    page.locator(`[data-testid="candidate-card"][data-property-id="${bystanderPropertyId}"]`),
  ).toHaveCount(0);
  // Still no star button in the tracked view.
  await expect(trackedCard.getByTestId("feedback-star")).toHaveCount(0);
});
