/**
 * E2E: candidate list beach-proximity + casco-histórico hard filters and the
 * soft beach boost (#392, Fase 4 of #385).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the new #392 controls
 * (a) render, (b) the beach filter is a MINIMUM grade that actually narrows the
 * feed via the SAME per-axis `location` column the ranking CTE derives (D-059),
 * (c) the casco-histórico toggle narrows to heritage-zone candidates, (d) the
 * SOFT boost lifts a sea-view candidate above an equal-base non-beach one
 * WITHOUT filtering it out, (e) a "Cualquiera"/off reset restores the list, and
 * (f) no error surface ever renders. Same DB-availability + admin-session
 * pattern as e2e/caveat-redflag-filters.spec.ts.
 *
 * The seed builds ONE profile with four deduplicated properties, each carrying a
 * seeded `location` ai_assessment (same price on every one, so beach grade is the
 * only differentiator) and NO learned score (null → the beach boost alone orders
 * them):
 *   - P1  beach_proximity `frontline`               → owner's "primera línea" ask
 *   - P2  beach_proximity `sea_view`                 → lifted by the soft boost
 *   - P3  beach_proximity `none`, heritage_zone true → casco-histórico control
 *   - P4  beach_proximity `none`                     → no beach signal at all
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

// Deliberately far from the coordinates the other e2e specs use, so a concurrent
// seed can't overlap this file's radius scan.
const COAST_NE: [number, number] = [36.9012, -4.1211];
const NAME_PREFIX = "e2e-beach-filters-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let pFrontline: number;
let pSeaView: number;
let pHeritage: number; // beach none, heritage true
let pNone: number; // beach none, no heritage

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[beach-filters.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: COAST_NE, radius_km: 5 },
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
      [COAST_NE[0], COAST_NE[1], address],
    );
    // property.id is bigint → pg returns it as a string; the card renders it as
    // a number in data-property-id, so coerce here for the numeric DOM-order
    // comparison in `orderedIds` (indexOf is strict-equality).
    return Number(result.rows[0].id);
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
    beach: string,
    heritage: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, 'location', $2::jsonb, 'location/v1', NOW())`,
      [
        propertyId,
        JSON.stringify({
          beach_proximity: beach,
          beach_evidence: beach !== "none" ? `menciona ${beach}` : "",
          heritage_zone: heritage,
          heritage_evidence: heritage ? "casco histórico" : "",
        }),
      ],
    );
  }

  // Same price on every property (300k) so the below-market signal is uniform and
  // the only order-differentiator is the beach boost.
  pFrontline = await insertProperty(`${NAME_PREFIX}Primera Linea, Costa`);
  await insertListing(pFrontline, 300000);
  await markMatched(pFrontline);
  await insertLocation(pFrontline, "frontline", false);

  pSeaView = await insertProperty(`${NAME_PREFIX}Vistas al Mar, Costa`);
  await insertListing(pSeaView, 300000);
  await markMatched(pSeaView);
  await insertLocation(pSeaView, "sea_view", false);

  pHeritage = await insertProperty(`${NAME_PREFIX}Casco Historico, Costa`);
  await insertListing(pHeritage, 300000);
  await markMatched(pHeritage);
  await insertLocation(pHeritage, "none", true);

  pNone = await insertProperty(`${NAME_PREFIX}Interior, Costa`);
  await insertListing(pNone, 300000);
  await markMatched(pNone);
  await insertLocation(pNone, "none", false);
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

/** DOM-order list of the rendered cards' property ids (the feed's visible order). */
async function orderedIds(page: Page): Promise<number[]> {
  return page
    .locator('[data-testid="candidate-card"]')
    .evaluateAll((els) =>
      els.map((el) => Number((el as HTMLElement).getAttribute("data-property-id"))),
    );
}

test("beach filter narrows by minimum grade, heritage toggle narrows, and the boost lifts sea_view", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(4);

  const beach = page.getByTestId("beach-filter");
  const heritage = page.getByTestId("heritage-filter");
  await expect(beach).toBeVisible();
  await expect(heritage).toBeVisible();

  // SOFT boost (no filter): frontline (+0.09) and sea_view (+0.06) outrank the
  // two zero-boost (`none`) candidates, and sea_view is NOT filtered out. Proves
  // the boost lifts order without excluding the rest.
  const order = await orderedIds(page);
  expect(order.indexOf(pSeaView)).toBeLessThan(order.indexOf(pNone));
  expect(order.indexOf(pSeaView)).toBeLessThan(order.indexOf(pHeritage));
  expect(order.indexOf(pFrontline)).toBeLessThan(order.indexOf(pSeaView));

  // Hard filter, minimum grade = frontline (owner's ask): narrows 4 → 1 (P1).
  await beach.selectOption("frontline");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(pFrontline))).toBeVisible();
  await expect(page.locator(card(pSeaView))).toHaveCount(0);
  await expect(page.locator(card(pNone))).toHaveCount(0);

  // Minimum grade = sea_view keeps frontline AND sea_view, but not the `none` ones.
  await beach.selectOption("sea_view");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pFrontline))).toBeVisible();
  await expect(page.locator(card(pSeaView))).toBeVisible();
  await expect(page.locator(card(pNone))).toHaveCount(0);
  await expect(page.locator(card(pHeritage))).toHaveCount(0);

  // Reset restores the full list.
  await beach.selectOption("");
  await expect(cards).toHaveCount(4);

  // Casco-histórico toggle narrows to the single heritage-zone candidate (P3).
  await heritage.check();
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(pHeritage))).toBeVisible();
  await expect(page.locator(card(pFrontline))).toHaveCount(0);

  // Turning it off restores the full list, still no error surface.
  await heritage.uncheck();
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(4);
});
