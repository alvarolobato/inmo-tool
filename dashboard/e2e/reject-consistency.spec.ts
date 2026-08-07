/**
 * E2E: reject consistency (feed phase 6, #417 / D-094).
 *
 * The reject UX itself (#379/#383/#405) is already covered by feedback.spec.ts.
 * This suite closes the three consistency gaps #417 fixes, end-to-end against a
 * real Next.js server + real Postgres (same fixture/skip pattern as
 * feedback.spec.ts / map.spec.ts):
 *
 *   1. Rejecting from the PROPERTY DETAIL PAGE (FeedbackControls now mounted
 *      there) drops the property's pin from the MAP by default.
 *   2. With "Mostrar descartadas" ON, the detail page's prev/next steps THROUGH
 *      rejected candidates in the same order as the list, and the flag survives
 *      the whole chain.
 *   3. Default (toggle OFF) prev/next still skips rejected neighbours.
 *
 * Skips cleanly if no DB is reachable.
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

// Distinct coordinates from the other specs so concurrent runs can't pick up
// each other's seed via a production geographic scan. Points are ~14 km apart
// so the map renders three individual markers, never a cluster.
const CENTER: [number, number] = [37.5, -5.5];
const POINTS: [number, number][] = [
  [37.5, -5.5], // top
  [37.6, -5.4], // middle (the one we reject)
  [37.4, -5.6], // bottom
];
const NAME_PREFIX = "e2e-reject-consistency-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let topId: number;
let middleId: number;
let bottomId: number;

async function insertProperty(coords: [number, number], m2: number): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
    [coords[0], coords[1], m2, `${NAME_PREFIX}Calle ${m2}`],
  );
  return Number(result.rows[0].id);
}

async function insertListing(propertyId: number, price: number): Promise<void> {
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', $3, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
  );
}

// score fixes the feed ordering deterministically: top > middle > bottom.
async function markMatched(propertyId: number, score: number): Promise<void> {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score)
     VALUES ($1, $2, true, $3)`,
    [profileId, propertyId, score],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[reject-consistency.spec] no reachable Postgres - skipping e2e suite.");
    return;
  }

  const profileResult = await pool.query<{ id: string }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: CENTER, radius_km: 25 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = Number(profileResult.rows[0].id);

  topId = await insertProperty(POINTS[0], 61);
  middleId = await insertProperty(POINTS[1], 62);
  bottomId = await insertProperty(POINTS[2], 63);

  await insertListing(topId, 250000);
  await insertListing(middleId, 260000);
  await insertListing(bottomId, 270000);

  await markMatched(topId, 0.9);
  await markMatched(middleId, 0.5);
  await markMatched(bottomId, 0.1);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  const ids = [topId, middleId, bottomId];
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
  await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [ids]);
  await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [ids]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

// Each test starts from a neutral verdict — an earlier test that ends on
// 'reject' would otherwise change what the next one sees.
test.beforeEach(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/error al cargar|hubo un problema|detalles técnicos|there is no parameter|http 500/i),
  ).toHaveCount(0);
}

async function rejectFromDb(propertyId: number): Promise<void> {
  await pool.query(
    `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'reject')`,
    [profileId, propertyId],
  );
}

test("reject from the property detail page, and the map drops that property's pin (#417 gaps 1+2)", async ({
  page,
}) => {
  skipIfNoDb(test);

  // Gap 2: the detail page now mounts FeedbackControls, so you can reject the
  // property you're reading.
  await page.goto(`/profiles/${profileId}/properties/${middleId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  const controls = page.getByTestId("detail-feedback-controls");
  await expect(controls).toBeVisible();
  const rejectButton = controls.getByTestId("feedback-reject");
  await expect(rejectButton).toHaveAttribute("aria-pressed", "false");

  const [feedbackResponse] = await Promise.all([
    page.waitForResponse(
      (r) => /\/feedback(\?|$)/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
    ),
    rejectButton.click(),
  ]);
  expect(feedbackResponse.ok()).toBe(true);
  await expect(rejectButton).toHaveAttribute("aria-pressed", "true");

  // Gap 1: the map is the same candidate feed, so the rejected property drops
  // no pin by default — only top and bottom remain.
  await page.goto(`/profiles/${profileId}/map`);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await assertNoErrorSurface(page);

  const markers = page.locator('[data-testid="map-marker"]');
  await expect(markers).toHaveCount(2);
  const renderedIds = await markers.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-property-id")),
  );
  expect(renderedIds.sort()).toEqual([String(bottomId), String(topId)].sort());
  expect(renderedIds).not.toContain(String(middleId));
});

test("prev/next skips a rejected candidate by default, matching the default feed (#417 gap 3)", async ({
  page,
}) => {
  skipIfNoDb(test);
  await rejectFromDb(middleId);

  // No toggle: from top, "Siguiente" jumps straight to bottom (middle hidden),
  // exactly like the default feed.
  await page.goto(`/profiles/${profileId}/properties/${topId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${bottomId}`,
  );
});

test("with includeRejected the prev/next chain steps THROUGH rejected candidates in list order (#417 gap 3)", async ({
  page,
}) => {
  skipIfNoDb(test);
  await rejectFromDb(middleId);

  // Toggle ON (the flag the feed's "Mostrar descartadas" carries into the link):
  // from top, "Siguiente" now points at the rejected middle, in list order.
  await page.goto(`/profiles/${profileId}/properties/${topId}?includeRejected=true`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  const nextFromTop = page.getByTestId("candidate-next");
  await expect(nextFromTop).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${middleId}?includeRejected=true`,
  );

  // Following the chain lands on the rejected middle, still carrying the flag,
  // and from there prev=top, next=bottom — the same order as the show-rejected
  // list, proving the flag survives the whole chain.
  await nextFromTop.click();
  await expect(page).toHaveURL(
    new RegExp(`/profiles/${profileId}/properties/${middleId}\\?includeRejected=true$`),
  );
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("candidate-prev")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${topId}?includeRejected=true`,
  );
  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${bottomId}?includeRejected=true`,
  );
});
