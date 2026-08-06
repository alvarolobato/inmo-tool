/**
 * E2E: property problem flags (#361) — unfinished/halted construction and
 * other physical problems surfaced from the broadened `redflags` axis.
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves that a property with
 * a seeded `unfinished_construction` redflags assessment (a) renders the
 * problem-flags section with the "Obra inacabada" badge and the model's
 * description + evidence on the detail page, (b) surfaces the same badge on
 * the candidate card, and (c) never renders an error surface. Same
 * real-server/real-Postgres pattern as e2e/property-detail.spec.ts and
 * e2e/distress-filters.spec.ts.
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
const MADRID_NE: [number, number] = [40.4781, -3.6688];
const NAME_PREFIX = "e2e-problem-flags-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let unfinishedPropertyId: number; // has an unfinished_construction redflag
let cleanPropertyId: number; // no redflags → no problem-flags section

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[problem-flags.spec] no reachable Postgres - skipping e2e suite. " +
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
       VALUES ($1, $2, 'piso', 90, $3) RETURNING id`,
      [MADRID_NE[0], MADRID_NE[1], address],
    );
    return result.rows[0].id;
  }

  async function insertListing(propertyId: number, price: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
       VALUES ($1, 'idealista', $2, 'active', 'sale', $3, NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
    );
  }

  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  async function insertRedflags(
    propertyId: number,
    result: Record<string, unknown>,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, 'redflags', $2::jsonb, 'redflags/v3', NOW())`,
      [propertyId, JSON.stringify(result)],
    );
  }

  // Property 796-style advert: unfinished / partially-executed construction.
  unfinishedPropertyId = await insertProperty(`${NAME_PREFIX}Calle Obra Parada, Madrid`);
  await insertListing(unfinishedPropertyId, 180000);
  await markMatched(unfinishedPropertyId);
  await insertRedflags(unfinishedPropertyId, {
    flags: [
      {
        type: "unfinished_construction",
        description: "Comprobar cuánto falta por terminar la obra y si tiene licencia en vigor.",
        evidence:
          "inmueble en construcción, parcialmente ejecutada, con algunos tabiques ya levantados",
        evidence_source: "idealista",
      },
    ],
    confidence: 0.85,
    reasoning: "El anuncio declara que la obra está a medio ejecutar.",
  });

  // Clean property: an assessed-but-empty redflags row → no problem-flags
  // section (the "absent, not a placeholder" rule).
  cleanPropertyId = await insertProperty(`${NAME_PREFIX}Calle Sin Problemas, Madrid`);
  await insertListing(cleanPropertyId, 250000);
  await markMatched(cleanPropertyId);
  await insertRedflags(cleanPropertyId, { flags: [], confidence: 0.8, reasoning: "Sin señales." });
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

// Every UI page is admin-gated (middleware.ts) — see e2e/helpers/admin-session.ts.
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/error|hubo un problema|there is no parameter|http 500|error al cargar/i),
  ).toHaveCount(0);
}

test("detail page renders the unfinished-construction problem flag with its description and evidence", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${unfinishedPropertyId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  const section = page.getByTestId("property-problem-flags");
  await expect(section).toBeVisible();

  const flag = page.locator('[data-testid="property-problem-flag"][data-flag-type="unfinished_construction"]');
  await expect(flag).toBeVisible();
  await expect(flag).toContainText("Obra inacabada");
  await expect(flag).toContainText(/cuánto falta por terminar la obra/i);
  await expect(flag).toContainText(/parcialmente ejecutada/i);
});

test("detail page shows NO problem-flags section for an assessed-but-clean property", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}/properties/${cleanPropertyId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);
  await expect(page.getByTestId("property-problem-flags")).toHaveCount(0);
});

test("candidate card surfaces the unfinished-construction badge", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(
    `[data-testid="candidate-card"][data-property-id="${unfinishedPropertyId}"]`,
  );
  await expect(card).toBeVisible();
  const badge = card.locator('[data-testid="candidate-flag"][data-flag-kind="redflag:unfinished_construction"]');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Obra inacabada");
});
