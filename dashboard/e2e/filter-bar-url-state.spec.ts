/**
 * E2E: candidate feed filter bar reorg + URL state (#465, Feed UX F2, D-041).
 *
 * Drives a real Next.js server against a real (seeded, synthetic) Postgres and
 * proves the reorganized filter bar:
 *   (a) hides the AI-gated filters behind the "Más filtros" popover;
 *   (b) setting one (Ocupación) surfaces an active-filter chip AND refetches the
 *       feed with the matching API param (occupancy=occupied);
 *   (c) the filter state lives in the URL — a deep-load of
 *       /profiles/[id]?occupancy=occupied restores the control + chip;
 *   (d) the bar still renders (with its empty-state message) when a filter
 *       narrows the feed to nothing;
 *   (e) no error surface ever renders.
 *
 * Same DB-availability + admin-session self-seed pattern as
 * e2e/distress-filters.spec.ts. Seeds ONE profile with two properties:
 *   - P1 occupied (tenanted, assessed) → the only occupancy=occupied match
 *   - P2 never assessed                → pool member, drops out under the filter
 */
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";
import { openMoreFilters } from "./helpers/filter-bar";

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

// Deliberately distinct coordinates so a concurrent seed can't overlap this
// file's radius scan.
const CENTER: [number, number] = [40.6112, -3.6688];
const NAME_PREFIX = "e2e-filter-url-state-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let p1Occupied: number;
let p2Unassessed: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[filter-bar-url-state.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: CENTER, radius_km: 5 },
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
      [CENTER[0], CENTER[1], m2Built, address],
    );
    return result.rows[0].id;
  }

  async function insertListing(propertyId: number, price: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
    );
  }

  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  async function insertAssessment(
    propertyId: number,
    assessmentType: string,
    result: Record<string, unknown>,
    promptVersion: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())`,
      [propertyId, assessmentType, JSON.stringify(result), promptVersion],
    );
  }

  // occupancy is a NESTED Verdict: the CTE reads ->'occupancy'->>'value'.
  const occ = (value: string) => ({
    occupancy: { value },
    caveats: value === "vacant" ? [] : [value],
  });

  p1Occupied = await insertProperty(`${NAME_PREFIX}Calle Ocupada, Getafe`, 60);
  await insertListing(p1Occupied, 220000);
  await markMatched(p1Occupied);
  await insertAssessment(p1Occupied, "occupancy", occ("tenanted"), "occupancy/v2");

  p2Unassessed = await insertProperty(`${NAME_PREFIX}Calle Sin Evaluar, Getafe`, 65);
  await insertListing(p2Unassessed, 230000);
  await markMatched(p2Unassessed);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM ai_assessment WHERE property_id IN (SELECT id FROM property WHERE address LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
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

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/error|hubo un problema|there is no parameter|http 500|no válid/i),
  ).toHaveCount(0);
}

const card = (id: number) => `[data-testid="candidate-card"][data-property-id="${id}"]`;

test("popover filter → chip + feed refetch carries the API param", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(2);

  // The AI-gated occupancy control is NOT in the primary row — it lives behind
  // the "Más filtros" popover (progressive disclosure).
  await expect(page.getByTestId("occupancy-filter")).toHaveCount(0);
  await openMoreFilters(page);
  const occupancy = page.getByTestId("occupancy-filter");
  await expect(occupancy).toBeVisible();

  // Setting Ocupación=Ocupado refetches the feed with occupancy=occupied.
  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.url().includes(`/api/profiles/${profileId}/candidates`) &&
        req.url().includes("occupancy=occupied"),
    ),
    occupancy.selectOption("occupied"),
  ]);
  expect(request.url()).toContain("occupancy=occupied");
  await assertNoErrorSurface(page);

  // Feed narrows to the single occupied match; the chip surfaces the active
  // filter (nothing active is invisible inside the popover).
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(p1Occupied))).toBeVisible();
  await expect(page.locator(card(p2Unassessed))).toHaveCount(0);
  await expect(page.getByTestId("filter-chip-occupancy")).toContainText(
    "Ocupación: Ocupado",
  );

  // The state is mirrored into the URL (deep-linkable).
  await expect(page).toHaveURL(/occupancy=occupied/);

  // The chip's ✕ clears exactly this filter → feed restores to the full pool.
  await page.getByTestId("filter-chip-clear-occupancy").click();
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page).not.toHaveURL(/occupancy=/);
});

test("deep-load restores the control + chip from the URL", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}?occupancy=occupied`);
  await assertNoErrorSurface(page);

  // The URL param drove the fetch: only the occupied match is shown.
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(p1Occupied))).toBeVisible();

  // The chip is restored (control state came from the URL, not a click).
  await expect(page.getByTestId("filter-chip-occupancy")).toContainText(
    "Ocupación: Ocupado",
  );

  // Opening the popover shows the restored select value.
  await openMoreFilters(page);
  await expect(page.getByTestId("occupancy-filter")).toHaveValue("occupied");
});

test("bar (and its empty-state) still renders when a filter matches nothing", async ({
  page,
}) => {
  skipIfNoDb(test);

  // No property is assessed as `free`, so occupancy=free narrows to zero — the
  // AI-assessment empty state. The bar must still render so the user can clear.
  await page.goto(`/profiles/${profileId}?occupancy=free`);
  await assertNoErrorSurface(page);

  await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(0);
  await expect(page.getByTestId("candidate-filter-bar")).toBeVisible();
  await expect(page.getByTestId("no-candidates-needs-assessment")).toBeVisible();
  // The active chip is still shown so the narrowing filter is never invisible.
  await expect(page.getByTestId("filter-chip-occupancy")).toBeVisible();
});
