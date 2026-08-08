/**
 * E2E: candidate list VPO hard filter (bidirectional) + tourist-licence soft
 * boost and the opportunity badges (#398, Fase 5 of #385).
 *
 * D-041 gate for a user-facing surface change: drives a real Next.js server
 * against a real (seeded, synthetic) Postgres and proves the new #398 controls
 * (a) render, (b) the VPO filter is BIDIRECTIONAL — "Solo VPO" narrows to VPO
 * candidates and "Sin VPO" narrows to non-VPO, both reading the SAME per-axis
 * `opportunity` column the ranking CTE derives (D-059), (c) the SOFT tourist
 * boost lifts a licensed candidate above an equal-base one WITHOUT filtering it
 * out (its absence is never a filter), (d) the VPO / Licencia turística badges
 * render, (e) a "Cualquiera"/off reset restores the list, and (f) no error
 * surface ever renders. Same DB-availability + admin-session pattern as
 * e2e/beach-filters.spec.ts.
 *
 * The seed builds ONE profile with four deduplicated properties, each carrying a
 * seeded `opportunity` ai_assessment (same price on every one) and NO learned
 * score (null → the tourist boost alone orders them):
 *   - P1  is_vpo true                       → owner's "buscar VPO" hard-filter target
 *   - P2  is_vpo false, tourist_license true → lifted by the soft boost, excluded by "Solo VPO"
 *   - P3  is_vpo false                       → plain non-VPO
 *   - P4  is_vpo true, tourist_license true  → VPO + licence (both badges)
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

// Deliberately far from the coordinates the other e2e specs use, so a concurrent
// seed can't overlap this file's radius scan.
const COORDS: [number, number] = [37.3891, -5.9845];
const NAME_PREFIX = "e2e-opportunity-axis-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let pVpo: number; // is_vpo true, no licence
let pLicensed: number; // is_vpo false, tourist_license true
let pPlain: number; // is_vpo false, no licence
let pVpoLicensed: number; // is_vpo true, tourist_license true

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[opportunity-axis.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: COORDS, radius_km: 5 },
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
      [COORDS[0], COORDS[1], address],
    );
    // property.id is bigint → pg returns it as a string; the card renders it as
    // a number in data-property-id, so coerce for the numeric DOM-order compare.
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

  async function insertOpportunity(
    propertyId: number,
    vpo: boolean,
    tourist: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
       VALUES ($1, 'opportunity', $2::jsonb, 'opportunity/v1', NOW())`,
      [
        propertyId,
        JSON.stringify({
          is_vpo: vpo,
          vpo_evidence: vpo ? "vivienda de protección oficial" : "",
          tourist_license: tourist,
          tourist_license_evidence: tourist ? "licencia turística concedida" : "",
        }),
      ],
    );
  }

  // Same price on every property (300k) so the below-market signal is uniform
  // and the only order-differentiator is the tourist-licence boost.
  pVpo = await insertProperty(`${NAME_PREFIX}VPO, Sevilla`);
  await insertListing(pVpo, 300000);
  await markMatched(pVpo);
  await insertOpportunity(pVpo, true, false);

  pLicensed = await insertProperty(`${NAME_PREFIX}Licencia Turistica, Sevilla`);
  await insertListing(pLicensed, 300000);
  await markMatched(pLicensed);
  await insertOpportunity(pLicensed, false, true);

  pPlain = await insertProperty(`${NAME_PREFIX}Normal, Sevilla`);
  await insertListing(pPlain, 300000);
  await markMatched(pPlain);
  await insertOpportunity(pPlain, false, false);

  pVpoLicensed = await insertProperty(`${NAME_PREFIX}VPO con Licencia, Sevilla`);
  await insertListing(pVpoLicensed, 300000);
  await markMatched(pVpoLicensed);
  await insertOpportunity(pVpoLicensed, true, true);
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

test("VPO filter narrows bidirectionally, the tourist boost lifts without filtering, and badges render", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(4);

  // The VPO control lives in the "Más filtros" popover (#465) — open it first.
  await openMoreFilters(page);
  const vpo = page.getByTestId("vpo-filter");
  await expect(vpo).toBeVisible();

  // Badges render: at least one VPO and one Licencia turística badge exist.
  await expect(page.locator('[data-flag-kind="opportunity:is_vpo"]').first()).toBeVisible();
  await expect(
    page.locator('[data-flag-kind="opportunity:tourist_license"]').first(),
  ).toBeVisible();

  // SOFT boost (no filter): the two licensed candidates (+0.04) outrank the two
  // unlicensed ones, and NONE is filtered out. Proves the boost lifts order
  // without excluding the rest (tourist_license is never a filter).
  const order = await orderedIds(page);
  expect(order.indexOf(pLicensed)).toBeLessThan(order.indexOf(pPlain));
  expect(order.indexOf(pVpoLicensed)).toBeLessThan(order.indexOf(pVpo));
  expect(order).toContain(pPlain);

  // "Solo VPO" → keeps ONLY the two VPO candidates (P1, P4).
  await vpo.selectOption("true");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pVpo))).toBeVisible();
  await expect(page.locator(card(pVpoLicensed))).toBeVisible();
  await expect(page.locator(card(pLicensed))).toHaveCount(0);
  await expect(page.locator(card(pPlain))).toHaveCount(0);

  // "Sin VPO" → keeps ONLY the two non-VPO candidates (P2, P3).
  await vpo.selectOption("false");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator(card(pLicensed))).toBeVisible();
  await expect(page.locator(card(pPlain))).toBeVisible();
  await expect(page.locator(card(pVpo))).toHaveCount(0);
  await expect(page.locator(card(pVpoLicensed))).toHaveCount(0);

  // Reset restores the full list, still no error surface.
  await vpo.selectOption("");
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(4);
});
