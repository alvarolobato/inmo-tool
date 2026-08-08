/**
 * E2E (D-041): clickable "N con alertas" count on the Perfiles list (#467,
 * Feed UX F4).
 *
 * F4 makes the profile-overview "N con alertas" metric a link that lands on
 * that profile's feed with the "Con alertas" filter already active (?alerts=1,
 * the F2 URL-state / F3 filter). It also broadened the count to the SAME UNION
 * predicate the filter uses (≥1 redflag OR ≥1 warn occupancy caveat), so the N
 * the row shows equals the number of flagged cards the link lands on
 * (count⇔filter invariant).
 *
 * This spec drives a real Next.js server against a real (seeded, synthetic)
 * Postgres and proves: (a) the row shows "2 con alertas" for a profile with one
 * caveat + one redflag property (and one clean, uncounted), (b) clicking it
 * navigates to /profiles/[id]?alerts=1 with the toggle pressed and the chip
 * shown, (c) the feed is narrowed to exactly those 2 flagged properties, and
 * (d) no error surface renders anywhere. Same DB-availability + admin-session
 * pattern as e2e/alerts-filter.spec.ts / e2e/profiles.spec.ts.
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

// Deliberately far from every other e2e spec's coordinate cluster so a
// concurrent seed can't overlap this file's radius scan.
const ALMERIA: [number, number] = [36.834, -2.4637];
const NAME_PREFIX = "e2e-alerts-count-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let pCaveat: number; // occupancy warn caveat → alert
let pRedflag: number; // redflag → alert (was UNCOUNTED before #467)
let pClean: number; // no assessment → not an alert

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[profile-alerts-count-clickable.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, last_materialized_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, NOW()) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: ALMERIA, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  async function insertProperty(address: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
      [ALMERIA[0], ALMERIA[1], address],
    );
    return result.rows[0].id;
  }

  async function insertListing(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', 300000, NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`],
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

  // Occupancy warn caveat → alert.
  pCaveat = await insertProperty(`${NAME_PREFIX}Calle Caveat, Almería`);
  await insertListing(pCaveat);
  await markMatched(pCaveat);
  await insertAssessment(pCaveat, "occupancy", { occupancy: { value: "vacant" }, caveats: ["venta_deuda"] }, "occupancy/v2");

  // Redflag → alert. This is the case #467 fixes: before F4 the overview count
  // read ONLY occupancy caveats, so a redflags-only property was uncounted.
  pRedflag = await insertProperty(`${NAME_PREFIX}Calle Redflag, Almería`);
  await insertListing(pRedflag);
  await markMatched(pRedflag);
  await insertAssessment(
    pRedflag,
    "redflags",
    { flags: [{ type: "embargo", description: "check embargo", evidence: "menciona embargo", evidence_source: "fotocasa" }] },
    "redflags/v3",
  );

  // Never assessed → not an alert.
  pClean = await insertProperty(`${NAME_PREFIX}Calle Limpia, Almería`);
  await insertListing(pClean);
  await markMatched(pClean);
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
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
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
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos|hubo un problema|no válid/i),
  ).toHaveCount(0);
  await expect(page.locator('[data-testid="error-display"]')).toHaveCount(0);
}

const card = (id: number) => `[data-testid="candidate-card"][data-property-id="${id}"]`;

test("clicking 'N con alertas' on /profiles lands on the profile feed filtered by ?alerts=1", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(row).toBeVisible();

  // #467: the count is the UNION (caveat + redflag), so it reads "2", not "1"
  // (the pre-F4 caveats-only count would have missed the redflag property).
  const flags = row.getByTestId("profile-metric-flags");
  await expect(flags).toContainText("2");
  await expect(flags).toHaveAttribute("href", `/profiles/${profileId}?alerts=1`);

  // Click the count → land on the filtered feed.
  await flags.click();
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}\\?alerts=1`));
  await assertNoErrorSurface(page);

  // The F2 URL-state activates the filter on first fetch: toggle pressed, chip
  // shown, feed narrowed to exactly the 2 flagged properties.
  await expect(page.getByTestId("alerts-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pCaveat))).toBeVisible();
  await expect(page.locator(card(pRedflag))).toBeVisible();
  await expect(page.locator(card(pClean))).toHaveCount(0);
});
