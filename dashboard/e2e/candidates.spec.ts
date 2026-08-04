/**
 * E2E: candidate list UI (task 2.5, #19).
 *
 * Re-establishes the e2e-required-for-user-facing-dashboard-surfaces gate
 * (see docs/decisions/archive/D-041-e2e-required-for-features.md,
 * docs/skills/e2e-testing.md) at the first task it applies to since the
 * source project's fixtures/specs were removed in task 1.1 as PowerShop-
 * specific. This drives a real Next.js server against a real (seeded,
 * synthetic) Postgres database — the exact thing three consecutive prior
 * tasks in this project needed and didn't have, each shipping a bug only a
 * real running container/browser caught.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with task 1.2's schema already
 * applied. Skips cleanly if no DB is reachable, matching the pattern used by
 * lib/filtering/__tests__/materialize.integration.test.ts and
 * lib/__tests__/candidates.integration.test.ts.
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
const NAME_PREFIX = "e2e-candidates-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let multiListingPropertyId: number;
// Dedicated profile for the staleness indicator (#243) — kept separate from
// the pagination-sensitive main profile above so its exact card counts stay
// stable.
let stalenessProfileId: number;
let freshPropertyId: number;
let stalePropertyId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[candidates.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // Deterministic, synthetic seed data — never real scraped listings (this
  // is a public repo). Cleaned up in afterAll regardless of pass/fail.
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

  async function insertProperty(address: string, m2Built: number): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], m2Built, address],
    );
    return result.rows[0].id;
  }

  async function insertListing(
    propertyId: number,
    source: string,
    price: number,
    status = "active",
    lastSeenAt: string | null = null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [propertyId, source, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, status, price, lastSeenAt],
    );
  }

  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  // The UI has no page-size override (CandidateList always uses the API's
  // default page size, 30) — so triggering a *real* second page means
  // seeding past that default rather than asking for a smaller one.
  // 30 single-listing matched properties, inserted first (lowest ids):
  // one full first page (30) plus room for exactly one item on a genuine
  // second page once the 31st property below is added.
  for (let i = 0; i < 30; i++) {
    const id = await insertProperty(`${NAME_PREFIX}Calle Goya ${i}, Madrid`, 60 + i);
    await insertListing(id, "fotocasa", 400000 + i * 1000);
    await markMatched(id);
  }

  // One deduplicated property with two source listings — the case this
  // whole task exists to render correctly as a single card with two badges.
  // Inserted LAST (highest id) so it sorts first under listCandidates'
  // `ORDER BY p.id DESC` and lands on page 1, not page 2 — a property
  // inserted before the 30 above would otherwise only ever appear once
  // "Cargar más" is clicked, defeating the point of asserting it on load.
  multiListingPropertyId = await insertProperty(`${NAME_PREFIX}Calle Trafalgar, Chamberí, Madrid`, 70);
  await insertListing(multiListingPropertyId, "fotocasa", 285000);
  await insertListing(multiListingPropertyId, "milanuncios", 279000);
  await markMatched(multiListingPropertyId);

  // Staleness indicator (#243), on its own profile so the counts above stay
  // fixed: one freshly-confirmed property (seen 2 days ago) and one stale one
  // (seen 30 days ago). The e2e proves the band actually renders end-to-end
  // against real data — a fresh card must NOT read as stale and vice versa.
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const stalenessProfile = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}staleness-${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  stalenessProfileId = stalenessProfile.rows[0].id;

  async function markMatchedFor(propId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [stalenessProfileId, propId],
    );
  }

  freshPropertyId = await insertProperty(`${NAME_PREFIX}Fresh, Calle Nueva, Madrid`, 80);
  await insertListing(freshPropertyId, "fotocasa", 250000, "active", daysAgo(2));
  await markMatchedFor(freshPropertyId);

  stalePropertyId = await insertProperty(`${NAME_PREFIX}Stale, Calle Vieja, Madrid`, 85);
  await insertListing(stalePropertyId, "fotocasa", 260000, "active", daysAgo(30));
  await markMatchedFor(stalePropertyId);
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
  await pool.query(
    "DELETE FROM property WHERE id NOT IN (SELECT property_id FROM listing) AND address LIKE $1",
    [`${NAME_PREFIX}%`],
  );
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

test("renders real candidate cards for a matched profile, grouping a deduplicated property under one card", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // Real content, not an empty/skeleton state: the first (30-item) page.
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(30);

  // The multi-listing property must render as ONE card carrying both
  // source badges ("fotocasa" + "milanuncios"), never as two cards.
  const multiCard = page.locator(`[data-testid="candidate-card"][data-property-id="${multiListingPropertyId}"]`);
  await expect(multiCard).toBeVisible();
  await expect(multiCard.getByText(/fotocasa/i)).toBeVisible();
  await expect(multiCard.getByText(/milanuncios/i)).toBeVisible();
});

test("surfaces per-listing staleness bands on the cards (#243)", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${stalenessProfileId}`);
  await assertNoErrorSurface(page);

  // Both cards render real content, each with its own staleness band derived
  // from last_seen_at — the fresh property (seen 2 days ago) must read fresh,
  // the stale one (seen 30 days ago) must read stale. A regression that stopped
  // surfacing last_seen_at (the whole point of #243) would drop these badges.
  const freshBadge = page.locator(
    `[data-testid="candidate-card"][data-property-id="${freshPropertyId}"] [data-testid="candidate-staleness"]`,
  );
  await expect(freshBadge).toBeVisible();
  await expect(freshBadge).toHaveAttribute("data-staleness-band", "fresh");
  await expect(freshBadge).toContainText(/visto hace 2 días/i);

  const staleBadge = page.locator(
    `[data-testid="candidate-card"][data-property-id="${stalePropertyId}"] [data-testid="candidate-staleness"]`,
  );
  await expect(staleBadge).toBeVisible();
  await expect(staleBadge).toHaveAttribute("data-staleness-band", "stale");
  await expect(staleBadge).toContainText(/visto hace 30 días/i);
});

test("advances to a real second page and stops offering more once exhausted", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);
  await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(30);

  const loadMore = page.getByRole("button", { name: /cargar más/i });
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  // The 31st (real) candidate appears — not a duplicate from the first page.
  await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(31);

  // Exactly 31 matched properties were seeded; the button must not persist
  // once the real last page has been reached (the pagination bug this task
  // fixed would have shown it here and fetched nothing on click).
  await expect(loadMore).toHaveCount(0);
});
