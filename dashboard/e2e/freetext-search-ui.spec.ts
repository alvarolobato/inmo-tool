/**
 * E2E (D-041): free-text search BOX + URL state — #470 Phase 2 (the UI).
 *
 * Phase 1 shipped the backend (property_search_doc + the `q` filter, exercised
 * API-level in freetext-search.spec.ts). This spec drives the browser surface
 * Phase 2 adds — the debounced search input in the candidate feed's primary
 * filter row — against a real Next.js server and a real, self-seeded Postgres:
 *
 *   (a) typing a term narrows the feed AND the refetch carries `q=<term>` (the
 *       box is wired to the P1 filter, not faked client-side);
 *   (b) an active search surfaces the `Búsqueda: «…»` chip and mirrors `q` into
 *       the URL (deep-linkable);
 *   (c) a deep-load of /profiles/[id]?q=<term> restores the input + chip + the
 *       narrowed feed in ONE filtered fetch — never a throwaway unfiltered flash
 *       (the #479 filtersReady gate must not regress);
 *   (d) clearing (✕) restores the full feed;
 *   (e) a non-matching search shows the search-specific empty state;
 *   (f) no error surface ever renders.
 *
 * Same DB-availability + admin-session self-seed pattern as
 * filter-bar-url-state.spec.ts. Seeds ONE profile with two matched properties:
 * one whose ad mentions "terraza", one that does not.
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

// Distinct coordinates so a concurrent seed can't overlap this file's radius scan.
const CENTER: [number, number] = [37.1773, -3.5986]; // Granada
const NAME_PREFIX = "e2e-freetext-ui-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let terraceId: number;
let plainId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[freetext-search-ui.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: CENTER, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  async function insertProperty(address: string): Promise<number> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
      [CENTER[0], CENTER[1], address],
    );
    // pg returns bigint as string; the API returns property_id as a JS number.
    return Number(r.rows[0].id);
  }
  async function insertListing(propertyId: number, description: string): Promise<void> {
    // The AFTER INSERT trigger builds property_search_doc from this row.
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, description)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', 285000, NOW(), $3)`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, description],
    );
  }
  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  terraceId = await insertProperty(`${NAME_PREFIX}Calle Elvira, Granada`);
  await insertListing(terraceId, "Bonito piso con terraza soleada y vistas.");
  await markMatched(terraceId);

  plainId = await insertProperty(`${NAME_PREFIX}Gran Vía, Granada`);
  await insertListing(plainId, "Piso interior reformado, sin exteriores.");
  await markMatched(plainId);
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
  // property_search_doc rows cascade with the property delete.
  await pool.query(
    "DELETE FROM property WHERE id NOT IN (SELECT property_id FROM listing) AND address LIKE $1",
    [`${NAME_PREFIX}%`],
  );
  await pool.end();
});

function skipIfNoDb() {
  test.skip(!dbAvailable, "no reachable Postgres");
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(
      /error|hubo un problema|there is no parameter|http 500|no válid|error al cargar/i,
    ),
  ).toHaveCount(0);
}

const card = (id: number) => `[data-testid="candidate-card"][data-property-id="${id}"]`;

test("typing a term narrows the feed, carries q= in the request, chips + URL", async ({
  page,
}) => {
  skipIfNoDb();

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(2);

  const box = page.getByTestId("search-input");
  await expect(box).toBeVisible();

  // Typing "terraza" refetches (after debounce) with q=terraza.
  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.url().includes(`/api/profiles/${profileId}/candidates`) &&
        req.url().includes("q=terraza"),
    ),
    box.fill("terraza"),
  ]);
  expect(request.url()).toContain("q=terraza");
  await assertNoErrorSurface(page);

  // Feed narrows to the single ad that mentions "terraza".
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(terraceId))).toBeVisible();
  await expect(page.locator(card(plainId))).toHaveCount(0);

  // The active search surfaces its chip and is mirrored into the URL.
  await expect(page.getByTestId("filter-chip-q")).toContainText("Búsqueda: «terraza»");
  await expect(page).toHaveURL(/q=terraza/);

  // ✕ in the box clears the search → full feed restored, URL clean.
  await page.getByTestId("search-clear").click();
  await assertNoErrorSurface(page);
  await expect(cards).toHaveCount(2);
  await expect(page).not.toHaveURL(/q=/);
  await expect(box).toHaveValue("");
});

test("deep-load restores input + chip + narrowed feed in ONE filtered fetch", async ({
  page,
}) => {
  skipIfNoDb();

  // Capture every page-level request to the candidates endpoint so we can prove
  // there was no throwaway unfiltered fetch (the #479 filtersReady gate).
  const candidateSearches: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === `/api/profiles/${profileId}/candidates`) {
      candidateSearches.push(u.search);
    }
  });

  await page.goto(`/profiles/${profileId}?q=terraza`);
  await assertNoErrorSurface(page);

  // Only the matching card is shown — the URL param drove the fetch.
  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(1);
  await expect(page.locator(card(terraceId))).toBeVisible();
  await expect(page.locator(card(plainId))).toHaveCount(0);

  // The input and chip are restored from the URL (state, not a keystroke).
  await expect(page.getByTestId("search-input")).toHaveValue("terraza");
  await expect(page.getByTestId("filter-chip-q")).toContainText("Búsqueda: «terraza»");

  // The core #479 guarantee: EVERY candidates fetch carried q=terraza — the
  // first request was already filtered, no unfiltered flash of the full pool.
  expect(candidateSearches.length).toBeGreaterThan(0);
  for (const s of candidateSearches) {
    expect(new URLSearchParams(s).get("q")).toBe("terraza");
  }
});

test("a non-matching search shows the search-specific empty state", async ({ page }) => {
  skipIfNoDb();

  await page.goto(`/profiles/${profileId}?q=zzz-inexistente-xyz`);
  await assertNoErrorSurface(page);

  await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(0);
  const empty = page.getByTestId("no-candidates-for-search");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("zzz-inexistente-xyz");
  // The bar stays so the search remains editable/removable.
  await expect(page.getByTestId("candidate-filter-bar")).toBeVisible();
  await expect(page.getByTestId("filter-chip-q")).toBeVisible();

  // "Quitar búsqueda" restores the full feed.
  await page.getByTestId("clear-search-empty-state").click();
  await assertNoErrorSurface(page);
  await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(2);
  await expect(page).not.toHaveURL(/q=/);
});
