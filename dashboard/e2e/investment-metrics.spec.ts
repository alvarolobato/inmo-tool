/**
 * E2E: property detail page's investment-metrics section (task 5.3, #33;
 * ties in #151's acquisition-cost/rent-honesty model and #32's area-price
 * comparison). Same real-server/real-Postgres pattern as
 * e2e/property-detail.spec.ts.
 *
 * Requires a reachable Postgres with the schema applied; skips cleanly if
 * none is reachable. Requires ADMIN_API_KEY (see e2e/helpers/admin-session.ts)
 * for the session gate — skips if unset, same as every other spec in this
 * directory.
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

// Distinct from every other spec's MADRID_SOL/ATOCHA point (see
// docs/skills/testing-patterns.md's gotcha note added alongside this PR) —
// this spec's own area-price fixtures use exact `sample_size` counts, which
// a shared coordinate would make sensitive to any other concurrently-seeded
// data. Playwright itself runs this repo's e2e specs serially
// (`fullyParallel: false`, `workers: 1`), but the dev server may be shared
// with other manual/automated activity against the same database.
const TEST_CENTER: [number, number] = [37.3891, -5.9845]; // Sevilla
const NAME_PREFIX = "e2e-investment-";

// A distinct cluster (issue #31's new fixtures), far outside the
// DEFAULT_RADIUS_KM (1.5km) used by both area-price.ts and
// rent-estimate.ts's comparable queries from TEST_CENTER — keeps the new
// rent-comparable fixtures below from perturbing the existing area-price
// sample_size assertions above, and vice versa.
const RENT_TEST_CENTER: [number, number] = [37.3891, -4.9845]; // ~1 degree east of Sevilla

let pool: Pool;
let dbAvailable = false;
let profileWithRentId: number;
let profileNoRentId: number;
let propertyWithGoodCompsId: number;
let propertyFewCompsId: number;
let propertyMarketRentId: number;
let propertyInsufficientRentId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[investment-metrics.spec] no reachable Postgres - skipping e2e suite. " +
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

  profileWithRentId = await makeProfile({
    financing: { down_payment_pct: 20, rate_pct: 3, term_years: 25 },
    rent_assumption: { eur_per_m2_month: 12 },
  });
  profileNoRentId = await makeProfile({});

  async function insertProperty(address: string, lat: number, lon: number, province: string | null): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address, province)
       VALUES ($1, $2, 'piso', 80, $3, $4) RETURNING id`,
      [lat, lon, address, province],
    );
    return result.rows[0].id;
  }

  async function insertListing(propertyId: number, price: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, operation)
       VALUES ($1, 'fotocasa', $2, 'active', $3, NOW(), 'sale')`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
    );
  }

  /** A rental comparable (issue #31) at RENT_TEST_CENTER, 'piso' type. */
  async function insertRentComp(m2: number, monthlyRent: number): Promise<void> {
    const compId = await insertProperty(`${NAME_PREFIX}rent-comp`, RENT_TEST_CENTER[0], RENT_TEST_CENTER[1], "Sevilla");
    await pool.query(
      `UPDATE property SET m2_built = $2 WHERE id = $1`,
      [compId, m2],
    );
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, operation)
       VALUES ($1, 'milanuncios_rental', $2, 'active', $3, NOW(), 'rent')`,
      [compId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, monthlyRent],
    );
  }

  async function markMatched(profileId: number, propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  // Property with >=5 same-type/same-area comparables (a real area-price
  // comparison renders) and both profiles matched to it.
  propertyWithGoodCompsId = await insertProperty(`${NAME_PREFIX}Calle Sierpes, Sevilla`, TEST_CENTER[0], TEST_CENTER[1], "Sevilla");
  await insertListing(propertyWithGoodCompsId, 200000); // 2,500 EUR/m2
  await markMatched(profileWithRentId, propertyWithGoodCompsId);
  await markMatched(profileNoRentId, propertyWithGoodCompsId);
  for (const price of [180000, 190000, 210000, 220000, 230000]) {
    const compId = await insertProperty(`${NAME_PREFIX}comp`, TEST_CENTER[0], TEST_CENTER[1], "Sevilla");
    await insertListing(compId, price);
  }

  // Property with only 2 comparables — must show the "insufficient data"
  // area-price state regardless of which profile views it.
  propertyFewCompsId = await insertProperty(`${NAME_PREFIX}Calle Pocos Comparables`, TEST_CENTER[0] + 0.2, TEST_CENTER[1] + 0.2, "Sevilla");
  await insertListing(propertyFewCompsId, 200000);
  await markMatched(profileWithRentId, propertyFewCompsId);
  for (const price of [190000, 210000]) {
    const compId = await insertProperty(`${NAME_PREFIX}comp-few`, TEST_CENTER[0] + 0.2, TEST_CENTER[1] + 0.2, "Sevilla");
    await insertListing(compId, price);
  }

  // Issue #31: a property matched to the NO-assumption profile, with 8
  // real rental comparables nearby (same worked-example (m2, rent) pairs
  // as rent-estimate.test.ts / the investment route's own worked example
  // -> median 10 EUR/m2/month, high confidence). Proves the actual new
  // capability end to end: a profile that never set a manual assumption
  // still gets a real, measured yield.
  propertyMarketRentId = await insertProperty(
    `${NAME_PREFIX}Calle Alquiler Medido`,
    RENT_TEST_CENTER[0],
    RENT_TEST_CENTER[1],
    "Sevilla",
  );
  await insertListing(propertyMarketRentId, 200000);
  await markMatched(profileNoRentId, propertyMarketRentId);
  for (const [m2, rent] of [
    [80, 800],
    [80, 720],
    [100, 1100],
    [60, 660],
    [90, 900],
    [70, 770],
    [80, 760],
    [100, 950],
  ] as const) {
    await insertRentComp(m2, rent);
  }

  // A property matched to the NO-assumption profile, but with only 1
  // rental comparable nearby — the "insufficient rental comparables"
  // state (distinct from "no comparables at all", still below the
  // MIN_LOW_CONFIDENCE_SAMPLE_SIZE gate).
  propertyInsufficientRentId = await insertProperty(
    `${NAME_PREFIX}Calle Alquiler Insuficiente`,
    RENT_TEST_CENTER[0] + 0.2,
    RENT_TEST_CENTER[1] + 0.2,
    "Sevilla",
  );
  await insertListing(propertyInsufficientRentId, 200000);
  await markMatched(profileNoRentId, propertyInsufficientRentId);
  // Reuses insertRentComp's RENT_TEST_CENTER location, so needs its own
  // helper call at THIS property's own offset instead — inline here
  // rather than generalizing insertRentComp's location parameter for one
  // call site.
  const soloCompId = await insertProperty(
    `${NAME_PREFIX}rent-comp-solo`,
    RENT_TEST_CENTER[0] + 0.2,
    RENT_TEST_CENTER[1] + 0.2,
    "Sevilla",
  );
  await pool.query(`UPDATE property SET m2_built = 80 WHERE id = $1`, [soloCompId]);
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, operation)
     VALUES ($1, 'milanuncios_rental', $2, 'active', $3, NOW(), 'rent')`,
    [soloCompId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, 800],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
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
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

test("renders populated yield/cash-on-cash and a real area-price comparison for a profile with a rent assumption", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileWithRentId}/properties/${propertyWithGoodCompsId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  // Non-blocking fetch — wait for the section to actually appear rather
  // than asserting immediately (it loads in behind the core page content).
  await expect(page.getByTestId("yield-section-content")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("area-price-comparison")).toBeVisible();
  await expect(page.getByTestId("estimated-rent")).toBeVisible();
  await expect(page.getByTestId("gross-yield")).toBeVisible();
  await expect(page.getByTestId("net-yield")).toBeVisible();
  await expect(page.getByTestId("cash-on-cash")).toBeVisible();

  // Every figure this task computes must read as an estimate, never a
  // guaranteed number (issue #33 EC-3) — at least 3 "estimado" badges:
  // estimated rent, gross yield, net yield, cash-on-cash.
  const estimateBadges = page.locator('[data-testid="estimate-badge"]');
  await expect(estimateBadges).toHaveCount(4);

  // Confidence badge reflects this module's honest "assumption" tier, not a
  // measurement-grade "alta confianza" label (issue #151's honesty
  // constraint — a user must be able to tell an assumption from a
  // measurement just by looking at the UI).
  const confidenceBadge = page.getByTestId("rent-confidence-badge");
  await expect(confidenceBadge).toHaveAttribute("data-confidence", "assumption");
  await expect(confidenceBadge).toHaveAttribute("data-muted", "true");

  // Assumptions breakdown is visible on request (issue #151: "show the
  // inputs, not just the output") — expand it and check the ITP line names
  // the actual region used.
  await page.getByTestId("assumptions-detail").locator("summary").click();
  await expect(page.getByTestId("acquisition-total")).toBeVisible();
  // The property's `province` is "Sevilla" (a province name); the panel
  // must show the resolved comunidad autónoma ("Andalucía") and its real
  // 7% ITP rate — proving acquisition-costs.ts's province->CCAA resolution
  // is actually wired end-to-end here, not just unit-tested in isolation.
  await expect(page.getByTestId("assumptions-detail")).toContainText(/andaluc[ií]a/i);
  await expect(page.getByTestId("assumptions-detail")).toContainText("7,0 %");
});

test("shows the explicit no-rent-assumption empty state (no fabricated yield) when the profile has none set", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileNoRentId}/properties/${propertyWithGoodCompsId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("yield-empty-state")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);

  // No yield figures rendered at all — not a zero, not a placeholder.
  await expect(page.getByTestId("gross-yield")).toHaveCount(0);
  await expect(page.getByTestId("estimated-rent")).toHaveCount(0);
  await expect(page.getByTestId("yield-empty-state")).toContainText(/sin estimaci[oó]n de alquiler/i);

  // The area-price comparison is independent of rent and still renders
  // (issue #32 doesn't depend on #151/#33's rent data).
  await expect(page.getByTestId("area-price-comparison")).toBeVisible();
});

test("shows the insufficient-comparables empty state for an area with too few ingested properties", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileWithRentId}/properties/${propertyFewCompsId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  // The rent/yield block still renders (this profile has a rent
  // assumption) — it's specifically the area-price comparison that must
  // show its own, independent "not enough data" state.
  await expect(page.getByTestId("yield-section-content")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);
  await expect(page.getByTestId("area-price-insufficient")).toBeVisible();
  await expect(page.getByTestId("area-price-comparison")).toHaveCount(0);
});

// Issue #31's core new capability, end to end: a profile that never set a
// manual rent assumption still renders a real, measured yield — derived
// from real ingested rental comparables, not a fabricated number.
test("renders a real, measured yield from rental comparables when the profile has no assumption (issue #31)", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileNoRentId}/properties/${propertyMarketRentId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("yield-section-content")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("estimated-rent")).toBeVisible();
  await expect(page.getByTestId("gross-yield")).toBeVisible();

  // High-confidence market comparable (8 comps, tight dispersion — see
  // beforeAll's fixture) — NOT the muted "assumption" tier, since no
  // assumption was ever set for this profile.
  const confidenceBadge = page.getByTestId("rent-confidence-badge");
  await expect(confidenceBadge).toHaveAttribute("data-confidence", "high");
  await expect(confidenceBadge).toHaveAttribute("data-muted", "false");

  // The row label itself must say this came from market comparables, not
  // silently reuse the assumption-specific wording.
  await expect(page.getByText(/comparables de mercado\)/i)).toBeVisible();

  // Worked-example numbers (see beforeAll / rent-estimate.test.ts's
  // matching fixture): median 10 EUR/m2/month * 80 m2 = 800/month ->
  // gross yield 800*12/200,000*100 = 4.8%.
  await expect(page.getByTestId("estimated-rent")).toContainText("800");
  await expect(page.getByTestId("gross-yield")).toContainText("4,8");
});

test("shows the insufficient-rental-comparables state when the profile has no assumption and too few rentals are nearby", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileNoRentId}/properties/${propertyInsufficientRentId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("yield-empty-state")).toBeVisible({ timeout: 15000 });
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("gross-yield")).toHaveCount(0);
  await expect(page.getByTestId("estimated-rent")).toHaveCount(0);
  // The 1 comparable that WAS found is surfaced, not silently dropped —
  // distinguishes "we looked and found almost nothing" from "we found
  // nothing at all" (propertyWithGoodCompsId's own no-assumption test).
  await expect(page.getByTestId("yield-empty-state")).toContainText(/1 encontrado/i);
});
