/**
 * E2E: candidate list distress / condition / below-market hard filters
 * (#310, D-059).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the #310 filters
 * (a) render, (b) actually narrow the feed to matching candidates, (c) leave
 * a "Cualquiera" reset that restores the full list, and (d) never surface an
 * error surface. Same DB-availability + admin-session pattern as
 * e2e/source-filter.spec.ts.
 *
 * The seed builds ONE profile with five deduplicated properties, differing in
 * price/m² and in seeded ai_assessment rows:
 *   - P1  occupied (tenanted) + a_reformar (integral), cheap  → the distress deal
 *   - P5  occupied (tenanted), no condition, cheap            → occupied but not a_reformar
 *   - P2  vacant + reformado, at/above market
 *   - P3, P4  never assessed, at/above market                → pool + graceful-degradation set
 *
 * So:
 *   - below-market ≥15% narrows 5 → 2 (P1, P5 — computed from price, works today)
 *   - occupancy=Ocupado narrows 5 → 2 (P1, P5 — from ai_assessment)
 *   - condition=A reformar narrows 5 → 1 (P1)
 * proving each filter AND that they read the same signals the ranking uses.
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

// Deliberately far from the coordinates the other e2e specs use, so a
// concurrent seed can't overlap this file's radius scan.
const MADRID_N: [number, number] = [40.5668, -3.7038];
const NAME_PREFIX = "e2e-distress-filters-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let p1Deal: number; // occupied + a_reformar(integral), cheap
let p5Occupied: number; // occupied (tenanted), cheap
let p2Reformado: number; // vacant + reformado
let p3: number; // unassessed
let p4: number; // unassessed

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[distress-filters.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: MADRID_N, radius_km: 5 },
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
      [MADRID_N[0], MADRID_N[1], m2Built, address],
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
  const occ = (value: string) => ({ occupancy: { value }, caveats: value === "vacant" ? [] : [value] });

  p1Deal = await insertProperty(`${NAME_PREFIX}Calle Ocupada Reforma, Madrid`, 60);
  await insertListing(p1Deal, 200000); // ppm2 3333 — cheap
  await markMatched(p1Deal);
  await insertAssessment(p1Deal, "occupancy", occ("tenanted"), "occupancy/v2");
  await insertAssessment(
    p1Deal,
    "condition",
    { condition: "a_reformar", renovation_severity: "integral" },
    "condition/v2",
  );

  p5Occupied = await insertProperty(`${NAME_PREFIX}Calle Ocupada, Madrid`, 65);
  await insertListing(p5Occupied, 210000); // ppm2 3230 — cheap
  await markMatched(p5Occupied);
  await insertAssessment(p5Occupied, "occupancy", occ("tenanted"), "occupancy/v2");

  p2Reformado = await insertProperty(`${NAME_PREFIX}Calle Reformada, Madrid`, 70);
  await insertListing(p2Reformado, 320000); // ppm2 4571 — above market
  await markMatched(p2Reformado);
  await insertAssessment(p2Reformado, "occupancy", occ("vacant"), "occupancy/v2");
  await insertAssessment(p2Reformado, "condition", { condition: "reformado", renovation_severity: null }, "condition/v2");

  p3 = await insertProperty(`${NAME_PREFIX}Calle Sin Evaluar A, Madrid`, 70);
  await insertListing(p3, 300000); // ppm2 4285
  await markMatched(p3);

  p4 = await insertProperty(`${NAME_PREFIX}Calle Sin Evaluar B, Madrid`, 70);
  await insertListing(p4, 310000); // ppm2 4428
  await markMatched(p4);
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

test("distress filters render, narrow the feed, and reset", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(5);

  // Below-market lives in the primary row (#465); the AI-gated occupancy /
  // condition controls moved into the "Más filtros" popover.
  const discount = page.getByTestId("discount-filter");
  await expect(discount).toBeVisible();

  // Below-market ≥15% (computed from price — works with no assessment data):
  // narrows to the two cheap properties (P1, P5).
  await discount.selectOption("15");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(p1Deal))).toBeVisible();
  await expect(page.locator(card(p5Occupied))).toBeVisible();
  await expect(page.locator(card(p2Reformado))).toHaveCount(0);
  await discount.selectOption(""); // reset
  await expect(cards).toHaveCount(5);

  // Open the popover to reach the occupancy / condition controls (#465).
  await openMoreFilters(page);
  const occupancy = page.getByTestId("occupancy-filter");
  const condition = page.getByTestId("condition-filter");
  await expect(occupancy).toBeVisible();
  await expect(condition).toBeVisible();

  // Occupancy = Ocupado (from ai_assessment): the two tenanted properties.
  await occupancy.selectOption("occupied");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(p1Deal))).toBeVisible();
  await expect(page.locator(card(p5Occupied))).toBeVisible();
  await expect(page.locator(card(p2Reformado))).toHaveCount(0);
  await occupancy.selectOption(""); // reset
  await expect(cards).toHaveCount(5);

  // Condition = A reformar (integral): only the a_reformar property (P1).
  await condition.selectOption("a_reformar:integral");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(p1Deal))).toBeVisible();

  // Reset restores the full list, still no error surface.
  await condition.selectOption("");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(5);
});
