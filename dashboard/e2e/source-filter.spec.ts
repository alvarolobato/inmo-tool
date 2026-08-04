/**
 * E2E: candidate list source (portal) filter (#265).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the filter (a) is
 * present, (b) actually narrows the list to the selected portal, (c) leaves
 * a "Todas las fuentes" reset that restores the full list, and (d) never
 * surfaces an error surface. Same DB-availability skip pattern as
 * e2e/candidates.spec.ts.
 *
 * The seed builds ONE profile with three deduplicated properties:
 *   - idealista-only
 *   - fotocasa-only
 *   - a multi-source property (idealista + fotocasa) — the dedup case, which
 *     must appear under EITHER portal filter, never disappear.
 * So "filter by idealista" narrows 3 → 2 (idealista-only + multi), proving
 * both the narrowing AND that a deduped card survives on ANY matching source.
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

const MADRID_SOL: [number, number] = [40.4168, -3.7038];
const NAME_PREFIX = "e2e-source-filter-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let idealistaOnlyId: number;
let fotocasaOnlyId: number;
let multiSourceId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[source-filter.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
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
      [MADRID_SOL[0], MADRID_SOL[1], m2Built, address],
    );
    return result.rows[0].id;
  }

  async function insertListing(propertyId: number, source: string, price: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
       VALUES ($1, $2, $3, 'active', 'sale', $4, NOW())`,
      [propertyId, source, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
    );
  }

  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  idealistaOnlyId = await insertProperty(`${NAME_PREFIX}Calle Idealista, Madrid`, 60);
  await insertListing(idealistaOnlyId, "idealista", 300000);
  await markMatched(idealistaOnlyId);

  fotocasaOnlyId = await insertProperty(`${NAME_PREFIX}Calle Fotocasa, Madrid`, 70);
  await insertListing(fotocasaOnlyId, "fotocasa", 320000);
  await markMatched(fotocasaOnlyId);

  multiSourceId = await insertProperty(`${NAME_PREFIX}Calle Dedup, Madrid`, 80);
  await insertListing(multiSourceId, "idealista", 285000);
  await insertListing(multiSourceId, "fotocasa", 279000);
  await markMatched(multiSourceId);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
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
    page.getByText(/error|hubo un problema|there is no parameter|http 500|no válida/i),
  ).toHaveCount(0);
}

const card = (id: number) => `[data-testid="candidate-card"][data-property-id="${id}"]`;

test("source filter is present, narrows the list to one portal, and resets", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // All three seeded candidates render before filtering.
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(3);

  // The filter control is present, offering the sources actually in the feed.
  const filter = page.getByTestId("source-filter");
  await expect(filter).toBeVisible();
  await expect(filter.locator("option")).toContainText([
    "Todas las fuentes",
    "fotocasa",
    "idealista",
  ]);

  // Filter to idealista → narrows to the idealista-only card AND the
  // deduplicated multi-source card (which has an idealista listing), but NOT
  // the fotocasa-only card.
  await filter.selectOption("idealista");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(idealistaOnlyId))).toBeVisible();
  await expect(page.locator(card(multiSourceId))).toBeVisible();
  await expect(page.locator(card(fotocasaOnlyId))).toHaveCount(0);

  // Switching portals combines correctly (not additively): fotocasa shows the
  // fotocasa-only card and the multi-source card, but not idealista-only.
  await filter.selectOption("fotocasa");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(fotocasaOnlyId))).toBeVisible();
  await expect(page.locator(card(multiSourceId))).toBeVisible();
  await expect(page.locator(card(idealistaOnlyId))).toHaveCount(0);

  // Reset restores the full list.
  await filter.selectOption("");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(3);
});
