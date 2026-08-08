/**
 * E2E: candidate list "⚠ Con alertas" UNION filter (#466, Feed UX F3).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the new toggle
 * (a) renders on the primary filter row, (b) actually narrows the feed to the
 * UNION of candidates with ≥1 red flag OR ≥1 warn occupancy caveat — reading
 * the SAME per-axis arrays the ranking CTE derives (D-059), (c) deep-loads from
 * `?alerts=1` already active (toggle pressed + active chip shown), and (d) never
 * surfaces an error surface. Same DB-availability + admin-session pattern as
 * e2e/caveat-redflag-filters.spec.ts.
 *
 * The seed builds ONE profile with three deduplicated properties, each carrying
 * a seeded ai_assessment (or none):
 *   - P1  occupancy caveat `venta_deuda`   → an alert (warn caveat)
 *   - P2  redflag `embargo`                → an alert (red flag)
 *   - P3  no assessment at all             → NOT an alert (excluded)
 *
 * So the ⚠ toggle narrows 3 → 2 (P1 + P2), proving the UNION reads the derived
 * caveats[]/redflag_types[] the ranking uses, and that a never-assessed property
 * is excluded (unknown, never a false pass).
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

// Deliberately far from the coordinates the other e2e specs use, so a
// concurrent seed can't overlap this file's radius scan.
const MADRID_SE: [number, number] = [40.3401, -3.6011];
const NAME_PREFIX = "e2e-alerts-filter-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let pDebt: number; // caveat venta_deuda → alert
let pEmbargo: number; // redflag embargo → alert
let pClean: number; // no assessment → not an alert

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[alerts-filter.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: MADRID_SE, radius_km: 5 },
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
      [MADRID_SE[0], MADRID_SE[1], address],
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

  const redflag = (type: string) => ({
    flags: [{ type, description: `check ${type}`, evidence: `menciona ${type}`, evidence_source: "fotocasa" }],
  });

  // Same price on every property so the below-market signal is uniform and the
  // only thing distinguishing the feed is the alerts toggle under test.
  pDebt = await insertProperty(`${NAME_PREFIX}Calle Venta Deuda, Madrid`);
  await insertListing(pDebt, 300000);
  await markMatched(pDebt);
  await insertAssessment(
    pDebt,
    "occupancy",
    { occupancy: { value: "vacant" }, caveats: ["venta_deuda"] },
    "occupancy/v2",
  );

  pEmbargo = await insertProperty(`${NAME_PREFIX}Calle Embargo, Madrid`);
  await insertListing(pEmbargo, 300000);
  await markMatched(pEmbargo);
  await insertAssessment(pEmbargo, "redflags", redflag("embargo"), "redflags/v3");

  // Never assessed → not an alert.
  pClean = await insertProperty(`${NAME_PREFIX}Calle Limpia, Madrid`);
  await insertListing(pClean, 300000);
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

test("⚠ toggle narrows the feed to the flagged properties, and resets", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(3);

  // The toggle lives on the primary row (not the popover).
  const toggle = page.getByTestId("alerts-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Turn it on → narrows to the UNION of caveat + redflag properties (2), never
  // the assessed-clean/never-assessed one.
  await toggle.click();
  await assertNoErrorSurface(page);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pDebt))).toBeVisible();
  await expect(page.locator(card(pEmbargo))).toBeVisible();
  await expect(page.locator(card(pClean))).toHaveCount(0);

  // An active chip appears for it.
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();

  // Turn it off → the full list is restored, still no error surface.
  await toggle.click();
  await assertNoErrorSurface(page);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(cards).toHaveCount(3);
});

test("deep-loading ?alerts=1 activates the filter and shows the chip", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}?alerts=1`);
  await assertNoErrorSurface(page);

  // The toggle reflects the URL state, the chip is shown, and the feed is
  // already narrowed to the two flagged properties.
  await expect(page.getByTestId("alerts-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pClean))).toHaveCount(0);
});
