/**
 * E2E: property detail page's buy-to-flip metrics section (issue #45).
 * Same real-server/real-Postgres pattern as e2e/investment-metrics.spec.ts.
 *
 * Covers issue #45 EC-2 (the renovation/ARV/margin breakdown shows each input
 * as a separate visible number) and EC-3 (the section is thesis-gated — hidden
 * for a non-flip profile). Requires a reachable Postgres + ADMIN_API_KEY;
 * skips cleanly otherwise, like every other spec here.
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

// Distinct coordinate cluster (Bilbao) from every other spec's point — see
// docs/skills/testing-patterns.md's gotcha note: these fixtures assert exact
// area-price sample counts, which a shared coordinate would perturb.
const TEST_CENTER: [number, number] = [43.263, -2.935];
const NAME_PREFIX = "e2e-flip-";

let pool: Pool;
let dbAvailable = false;
let flipProfileId: number;
let rentProfileId: number;
let flipPropertyId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[flip-metrics.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  async function makeProfile(thesisParams: Record<string, unknown>): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO search_profile (name, scope, thesis_params) VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
      [
        `${NAME_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
        JSON.stringify({
          geography: { type: "radius", center: TEST_CENTER, radius_km: 5 },
          property_types: ["piso"],
          hard_exclusions: {},
        }),
        JSON.stringify(thesisParams),
      ],
    );
    return result.rows[0].id;
  }

  // A flip-thesis profile (renders the flip section) and a rental-thesis one
  // (must NOT). Both carry a rent assumption so the yield block renders for
  // both, isolating the flip section as the only thing that differs.
  flipProfileId = await makeProfile({ thesis_type: "flip", rent_assumption: { eur_per_m2_month: 12 } });
  rentProfileId = await makeProfile({ thesis_type: "rent", rent_assumption: { eur_per_m2_month: 12 } });

  async function insertProperty(address: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address, province)
       VALUES ($1, $2, 'piso', 80, $3, 'Bizkaia') RETURNING id`,
      [TEST_CENTER[0], TEST_CENTER[1], address],
    );
    return result.rows[0].id;
  }

  async function insertSaleListing(propertyId: number, price: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, operation)
       VALUES ($1, 'fotocasa', $2, 'active', $3, NOW(), 'sale')`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
    );
  }

  // Target fixer-upper: 80 m², priced 200,000 (2,500 €/m² — below the zone).
  flipPropertyId = await insertProperty(`${NAME_PREFIX}Calle Reforma, Bilbao`);
  await insertSaleListing(flipPropertyId, 200000);
  for (const profileId of [flipProfileId, rentProfileId]) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, flipPropertyId],
    );
  }

  // A condition assessment: "a reformar", light reform → 400 €/m² × 80 =
  // 32,000 refurb. renovation_severity is the #313 sub-axis #45 keys off.
  await pool.query(
    `INSERT INTO ai_assessment
       (property_id, assessment_type, result, confidence, model, prompt_version, generated_at)
     VALUES ($1, 'condition', $2::jsonb, 0.8, 'e2e-seed', 'condition/v2', NOW())`,
    [
      flipPropertyId,
      JSON.stringify({
        condition: "a_reformar",
        renovation_severity: "leve",
        confidence: 0.8,
        evidence: "necesita una reforma de actualización",
        evidence_source: "fotocasa",
        issues: [],
        reasoning: "e2e seed",
      }),
    ],
  );

  // 5 renovated sale comparables at 3,500 €/m² (280,000 for 80 m²) → zone
  // median 3,500 → ARV ≈ 280,000. Enough to clear area-price's MIN_SAMPLE_SIZE.
  for (let i = 0; i < 5; i++) {
    const compId = await insertProperty(`${NAME_PREFIX}comp-${i}`);
    await insertSaleListing(compId, 280000);
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM ai_assessment WHERE property_id IN (SELECT id FROM property WHERE address LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
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
    page.getByText(/error|hubo un problema|there is no parameter|http 500|error al cargar/i),
  ).toHaveCount(0);
}

test("shows renovation/ARV breakdown for flip-thesis profile", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${flipProfileId}/properties/${flipPropertyId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  // Non-blocking fetch — the flip section loads in behind the core page.
  await expect(page.getByTestId("flip-section-content")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);

  // Refurb cost + ARV each render a real figure (not "sin estimación").
  const refurb = page.getByTestId("flip-refurb-cost");
  await expect(refurb).toBeVisible();
  await expect(refurb).toHaveAttribute("data-tier", "leve");
  await expect(page.getByTestId("flip-arv")).toBeVisible();

  // EC-2: the margin breaks out ARV, purchase price, and refurb as separate
  // visible numbers, not just a final figure.
  await expect(page.getByTestId("flip-margin")).toHaveAttribute("data-computable", "true");
  await expect(page.getByTestId("flip-margin-arv")).toBeVisible();
  await expect(page.getByTestId("flip-margin-price")).toBeVisible();
  await expect(page.getByTestId("flip-margin-refurb")).toBeVisible();
  await expect(page.getByTestId("flip-margin-buffer")).toBeVisible();
  await expect(page.getByTestId("flip-margin-total")).toBeVisible();

  // Buy-to-rent comparison shown alongside (issue #45).
  await expect(page.getByTestId("flip-vs-rent")).toBeVisible();

  // EC-4: framed as a rough estimate, never a quote.
  await expect(page.getByTestId("flip-disclaimer")).toContainText(/no es una tasaci[oó]n/i);
});

test("renovation/ARV section hidden for non-flip profiles", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${rentProfileId}/properties/${flipPropertyId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  // Wait for the investment (yield) section to load — proves the investment
  // fetch completed, so the flip section's absence is real, not just "not
  // loaded yet".
  await expect(page.getByTestId("yield-section-content")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);

  // EC-3: flip section not rendered at all for a rental-thesis profile.
  await expect(page.getByTestId("flip-section-content")).toHaveCount(0);
});
