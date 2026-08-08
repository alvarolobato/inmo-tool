/**
 * E2E: candidate list caveat / redflag-type hard filters (#386, Fase 1 of
 * #385).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the two new #386
 * filters (a) render, (b) actually narrow the feed to matching candidates via
 * the SAME per-axis columns the ranking CTE derives (D-059), (c) leave a
 * "Cualquiera" reset that restores the full list, and (d) never surface an
 * error surface. Same DB-availability + admin-session pattern as
 * e2e/distress-filters.spec.ts.
 *
 * These two signals already existed in the model and rendered as badges; #386
 * only adds the filter. The seed builds ONE profile with four deduplicated
 * properties, each carrying a seeded ai_assessment:
 *   - P1  occupancy caveat `venta_deuda`          → the owner's "venta de deuda"
 *   - P2  redflag `unfinished_construction`       → the owner's "obra sin terminar"
 *   - P3  redflag `embargo` (a different type)    → present but not the target
 *   - P4  no caveat, no redflag                    → clean control
 *
 * So:
 *   - Situación jurídica = Venta de deuda narrows 4 → 1 (P1)
 *   - Alerta = Obra inacabada narrows 4 → 1 (P2)
 * proving each filter reads the derived caveats[]/redflag_types[] the ranking
 * uses, not a separate JOIN.
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
const MADRID_NE: [number, number] = [40.5701, -3.6011];
const NAME_PREFIX = "e2e-caveat-redflag-filters-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let pDebt: number; // caveat venta_deuda
let pUnfinished: number; // redflag unfinished_construction
let pEmbargo: number; // redflag embargo
let pClean: number; // no caveat, no redflag

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[caveat-redflag-filters.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: MADRID_NE, radius_km: 5 },
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
      [MADRID_NE[0], MADRID_NE[1], address],
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
  // only thing distinguishing the feed is the caveat/redflag filter under test.
  pDebt = await insertProperty(`${NAME_PREFIX}Calle Venta Deuda, Madrid`);
  await insertListing(pDebt, 300000);
  await markMatched(pDebt);
  await insertAssessment(
    pDebt,
    "occupancy",
    { occupancy: { value: "vacant" }, caveats: ["venta_deuda"] },
    "occupancy/v2",
  );

  pUnfinished = await insertProperty(`${NAME_PREFIX}Calle Obra Inacabada, Madrid`);
  await insertListing(pUnfinished, 300000);
  await markMatched(pUnfinished);
  await insertAssessment(pUnfinished, "redflags", redflag("unfinished_construction"), "redflags/v3");

  pEmbargo = await insertProperty(`${NAME_PREFIX}Calle Embargo, Madrid`);
  await insertListing(pEmbargo, 300000);
  await markMatched(pEmbargo);
  await insertAssessment(pEmbargo, "redflags", redflag("embargo"), "redflags/v3");

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

test("caveat + redflag filters render, narrow the feed, and reset", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(4);

  // Both controls live in the "Más filtros" popover (#465) — open it first.
  await openMoreFilters(page);
  const caveat = page.getByTestId("caveat-filter");
  const redflag = page.getByTestId("redflag-filter");
  await expect(caveat).toBeVisible();
  await expect(redflag).toBeVisible();

  // Situación jurídica = Venta de deuda (owner's ask): narrows to P1 only.
  await caveat.selectOption("venta_deuda");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(pDebt))).toBeVisible();
  await expect(page.locator(card(pUnfinished))).toHaveCount(0);
  await expect(page.locator(card(pEmbargo))).toHaveCount(0);
  await expect(page.locator(card(pClean))).toHaveCount(0);
  await caveat.selectOption(""); // reset
  await expect(cards).toHaveCount(4);

  // Alerta = Obra inacabada (owner's ask): narrows to P2 only — NOT the embargo
  // one, proving the filter targets the specific redflag type.
  await redflag.selectOption("unfinished_construction");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(pUnfinished))).toBeVisible();
  await expect(page.locator(card(pEmbargo))).toHaveCount(0);
  await expect(page.locator(card(pDebt))).toHaveCount(0);

  // Reset restores the full list, still no error surface.
  await redflag.selectOption("");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(4);
});
