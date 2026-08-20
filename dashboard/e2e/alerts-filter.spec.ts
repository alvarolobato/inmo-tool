/**
 * E2E: candidate list tri-state "alertas" filter (#593, extending #466's
 * one-way "⚠ Con alertas" UNION toggle).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the segmented
 * control (a) renders on the primary filter row with exactly one of its 3
 * states highlighted at all times, (b) "Con alertas" narrows the feed to the
 * UNION of candidates with ≥1 red flag OR ≥1 warn occupancy caveat — reading
 * the SAME per-axis arrays the ranking CTE derives (D-059), (c) "Sin alertas"
 * is the TRUE COMPLEMENT of that same set (never-assessed EXCLUDED from
 * both, per the issue's D-059-consistent judgement call), (d) both states
 * deep-load from the URL (`?alerts=1` / `?alerts=0`) already active, and
 * (e) never surfaces an error surface. Same DB-availability + admin-session
 * pattern as e2e/caveat-redflag-filters.spec.ts.
 *
 * The seed builds ONE profile with four deduplicated properties, each
 * carrying a seeded ai_assessment (or none):
 *   - P1  occupancy caveat `venta_deuda`         → an alert (warn caveat)
 *   - P2  redflag `embargo`                      → an alert (red flag)
 *   - P3  assessed on BOTH axes, nothing found    → "sin alertas" (clean)
 *   - P4  no assessment at all                    → excluded from BOTH states
 *
 * So "Con alertas" narrows 4 → 2 (P1 + P2); "Sin alertas" narrows 4 → 1 (P3);
 * P4 never appears under either — proving the negative excludes an
 * unassessed property rather than treating it as a false "verified clean".
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
let pClean: number; // assessed both axes, nothing found → "sin alertas"
let pUnassessed: number; // no assessment → excluded from BOTH states

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

  // Review #597: every test in this file also skips without ADMIN_API_KEY
  // (checked in beforeEach) — don't pay for seeding when nothing downstream
  // will use it.
  if (!adminKey) return;

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
  // only thing distinguishing the feed is the alerts filter under test.
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

  // Assessed on BOTH axes, nothing found — the genuine "sin alertas" case.
  pClean = await insertProperty(`${NAME_PREFIX}Calle Limpia, Madrid`);
  await insertListing(pClean, 300000);
  await markMatched(pClean);
  await insertAssessment(
    pClean,
    "occupancy",
    { occupancy: { value: "vacant" }, caveats: [] },
    "occupancy/v2",
  );
  await insertAssessment(pClean, "redflags", { flags: [] }, "redflags/v3");

  // Never assessed → excluded from BOTH "con alertas" and "sin alertas".
  pUnassessed = await insertProperty(`${NAME_PREFIX}Calle Sin Evaluar, Madrid`);
  await insertListing(pUnassessed, 300000);
  await markMatched(pUnassessed);
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

test("the segmented control cycles off → con alertas → sin alertas → off, exactly one state highlighted at a time", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(4);

  const off = page.getByTestId("alerts-segment-off");
  const withAlerts = page.getByTestId("alerts-segment-with");
  const withoutAlerts = page.getByTestId("alerts-segment-without");
  await expect(off).toHaveAttribute("aria-pressed", "true");
  await expect(withAlerts).toHaveAttribute("aria-pressed", "false");
  await expect(withoutAlerts).toHaveAttribute("aria-pressed", "false");

  // "Con alertas" → narrows to the UNION of caveat + redflag properties (2),
  // never the clean or never-assessed ones.
  await withAlerts.click();
  await assertNoErrorSurface(page);
  await expect(withAlerts).toHaveAttribute("aria-pressed", "true");
  await expect(off).toHaveAttribute("aria-pressed", "false");
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pDebt))).toBeVisible();
  await expect(page.locator(card(pEmbargo))).toBeVisible();
  await expect(page.locator(card(pClean))).toHaveCount(0);
  await expect(page.locator(card(pUnassessed))).toHaveCount(0);
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();

  // "Sin alertas" → the TRUE COMPLEMENT: only the assessed-clean property,
  // NOT the never-assessed one (D-059: unassessed excluded from a hard
  // filter, never a false "verified clean").
  await withoutAlerts.click();
  await assertNoErrorSurface(page);
  await expect(withoutAlerts).toHaveAttribute("aria-pressed", "true");
  await expect(withAlerts).toHaveAttribute("aria-pressed", "false");
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(pClean))).toBeVisible();
  await expect(page.locator(card(pUnassessed))).toHaveCount(0);
  await expect(page.locator(card(pDebt))).toHaveCount(0);
  await expect(page.locator(card(pEmbargo))).toHaveCount(0);
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();

  // Back to "Todas" → the full list is restored, still no error surface.
  await off.click();
  await assertNoErrorSurface(page);
  await expect(off).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId("filter-chip-alerts")).toHaveCount(0);
});

test("deep-loading ?alerts=1 activates 'con alertas' and shows the chip", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}?alerts=1`);
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("alerts-segment-with")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pClean))).toHaveCount(0);
  await expect(page.locator(card(pUnassessed))).toHaveCount(0);
});

test("deep-loading ?alerts=0 activates 'sin alertas' — the complement, not the never-assessed property", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}?alerts=0`);
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("alerts-segment-without")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("filter-chip-alerts")).toBeVisible();
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(pClean))).toBeVisible();
  await expect(page.locator(card(pUnassessed))).toHaveCount(0);
});
