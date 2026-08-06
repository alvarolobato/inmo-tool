/**
 * E2E: location axis (#388) — beach proximity (graded) + heritage zone.
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves that a property with a
 * seeded `location` assessment (a) surfaces the "Primera línea" / "Casco
 * histórico" badges on the candidate card, and (b) never renders an error
 * surface. A `terreno` seeded WITHOUT a location row (owner-decision exclusion)
 * simply carries no location badge. Same real-server/real-Postgres pattern as
 * e2e/problem-flags.spec.ts.
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

// Málaga coast — deliberately far from the coordinates the other e2e specs use,
// so a concurrent seed can't overlap this file's radius scan.
const MALAGA_BEACH: [number, number] = [36.715, -4.42];
const NAME_PREFIX = "e2e-location-axis-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let beachPropertyId: number; // frontline + heritage location assessment
let terrenoPropertyId: number; // terreno, excluded → no location assessment

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[location-axis.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: MALAGA_BEACH, radius_km: 5 },
        // `terreno` included so the excluded property is still a candidate,
        // proving the exclusion is at the assessment axis, not the feed.
        property_types: ["piso", "terreno"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  async function insertProperty(propertyType: string, address: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, $3, 90, $4) RETURNING id`,
      [MALAGA_BEACH[0], MALAGA_BEACH[1], propertyType, address],
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

  async function insertLocation(
    propertyId: number,
    result: Record<string, unknown>,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, 'location', $2::jsonb, 'location/v1', NOW())`,
      [propertyId, JSON.stringify(result)],
    );
  }

  // Beachfront + casco histórico flat.
  beachPropertyId = await insertProperty("piso", `${NAME_PREFIX}Paseo Marítimo, Málaga`);
  await insertListing(beachPropertyId, 320000);
  await markMatched(beachPropertyId);
  await insertLocation(beachPropertyId, {
    beach_proximity: "frontline",
    beach_evidence: "piso en primera línea de playa, a pie de arena",
    beach_evidence_source: "fotocasa",
    heritage_zone: true,
    heritage_evidence: "en pleno casco histórico de Málaga",
    heritage_evidence_source: "fotocasa",
    confidence: 0.9,
    reasoning: "El anuncio declara primera línea y casco histórico.",
  });

  // A terreno: matched candidate, but the location axis does not apply, so it
  // has NO location row — the card must carry no location badge.
  terrenoPropertyId = await insertProperty("terreno", `${NAME_PREFIX}Solar junto a la playa`);
  await insertListing(terrenoPropertyId, 150000);
  await markMatched(terrenoPropertyId);
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

test("candidate card surfaces the graded beach badge and the heritage badge", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(
    `[data-testid="candidate-card"][data-property-id="${beachPropertyId}"]`,
  );
  await expect(card).toBeVisible();

  const beachBadge = card.locator(
    '[data-testid="candidate-flag"][data-flag-kind="location:beach:frontline"]',
  );
  await expect(beachBadge).toBeVisible();
  await expect(beachBadge).toContainText("Primera línea");

  const heritageBadge = card.locator(
    '[data-testid="candidate-flag"][data-flag-kind="location:heritage_zone"]',
  );
  await expect(heritageBadge).toBeVisible();
  await expect(heritageBadge).toContainText("Casco histórico");
});

test("an excluded terreno candidate carries no location badge", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const card = page.locator(
    `[data-testid="candidate-card"][data-property-id="${terrenoPropertyId}"]`,
  );
  await expect(card).toBeVisible();
  await expect(
    card.locator('[data-testid="candidate-flag"][data-flag-kind^="location:"]'),
  ).toHaveCount(0);
});
