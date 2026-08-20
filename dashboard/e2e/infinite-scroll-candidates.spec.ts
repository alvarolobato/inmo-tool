/**
 * E2E: candidate list infinite scroll on mobile (#592), replacing "Cargar
 * más" as the auto-load trigger under the 768px breakpoint.
 *
 * D-041 gate for a user-facing surface change. Drives a real Next.js server
 * against a real (seeded, synthetic) Postgres — same pattern as
 * e2e/candidates.spec.ts, whose "advances to a real second page" test this
 * file's mobile fixture deliberately extends to a THIRD page (61 matched
 * properties = 30 + 30 + 1) so scrolling exercises ≥2 auto-loads and reaches
 * the true, honest end state, not just one page break.
 *
 * MEASUREMENT TRAP (see e2e/mobile-topbar.spec.ts): assert against
 * `document.documentElement.clientWidth`, never `window.innerWidth`, which
 * reports the pre-emulation layout width under Chromium device emulation and
 * would hide a broken breakpoint.
 *
 * Same price on every seeded property (uniform below-market signal, no
 * assessment) so nothing but insertion order (id) distinguishes the feed's
 * DESC tiebreak — the ids captured render in exact reverse-insertion order,
 * letting the "no duplicate or skipped candidates" assertion be exact rather
 * than just a count.
 */
import { test, expect, devices, type Page } from "@playwright/test";
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

// Deliberately far from other e2e specs' coordinates so a concurrent seed
// can't overlap this file's radius scan.
const MADRID_NW: [number, number] = [40.4900, -3.7800];
const NAME_PREFIX = "e2e-infinite-scroll-";
const TOTAL = 61; // 30 (page 1) + 30 (page 2) + 1 (page 3, the true end)

let pool: Pool;
let dbAvailable = false;
let profileId: number;
// Seeded oldest-first; the feed's DESC tiebreak (same price/no assessment on
// every one, so score ties) renders them newest-id-first — the reverse of
// this array.
let seededIds: number[] = [];

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[infinite-scroll-candidates.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // Review #597: every test in this file also skips without ADMIN_API_KEY
  // (checked in each describe's beforeEach) — don't pay for seeding 61
  // properties (TOTAL) when nothing downstream will use them.
  if (!adminKey) return;

  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_NW, radius_km: 5 },
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
      [MADRID_NW[0], MADRID_NW[1], address],
    );
    // node-pg returns int8/bigint columns as strings by default (no custom
    // type parser on this standalone test Pool, unlike the app's own —
    // lib/db-shared.ts #155) — coerce so `seededIds` compares correctly
    // against the DOM's `data-property-id` (already a real number there).
    return Number(result.rows[0].id);
  }

  async function insertListing(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', 300000, NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`],
    );
  }

  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  for (let i = 0; i < TOTAL; i++) {
    const id = await insertProperty(`${NAME_PREFIX}Calle Sentinel ${i}, Madrid`);
    await insertListing(id);
    await markMatched(id);
    seededIds.push(id);
  }
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

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/hubo un problema|there is no parameter|http 500/i),
  ).toHaveCount(0);
}

async function cardIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="candidate-card"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-property-id") ?? ""));
}

test.describe("mobile (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
  });

  test("scrolling the sentinel into view auto-loads more pages with no tap, then states the honest end — no duplicate or skipped candidates across ≥2 auto-loads", async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}`);
    await assertNoErrorSurface(page);

    // Confirm the real rendered viewport is narrow (never window.innerWidth
    // — see file header).
    expect(
      await page.evaluate(() => document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(400);

    const cards = page.locator('[data-testid="candidate-card"]');
    await expect(cards).toHaveCount(30);

    // No "Cargar más" button on mobile — the sentinel is the only trigger.
    await expect(page.getByRole("button", { name: /cargar más/i })).toBeHidden();
    await expect(page.getByTestId("infinite-scroll-sentinel")).toBeAttached();

    // Auto-load #1: scrolling the sentinel into view (no click) loads page 2.
    await page.getByTestId("infinite-scroll-sentinel").scrollIntoViewIfNeeded();
    await expect(cards).toHaveCount(60);
    await assertNoErrorSurface(page);

    // Auto-load #2: reaches the true end (61 seeded).
    await page.getByTestId("infinite-scroll-sentinel").scrollIntoViewIfNeeded();
    await expect(cards).toHaveCount(61);
    await assertNoErrorSurface(page);

    // Honest end state — no silent stop, and the sentinel is gone (cursor is
    // null, so it isn't rendered at all any more).
    await expect(page.getByTestId("candidates-end-of-list")).toBeVisible();
    await expect(page.getByTestId("candidates-end-of-list")).toContainText(
      /no hay más candidatos/i,
    );
    await expect(page.getByTestId("infinite-scroll-sentinel")).toHaveCount(0);

    // No duplicate or skipped candidates across the 2 auto-loads: exactly the
    // 61 seeded ids, each exactly once, in the feed's own DESC tiebreak order
    // (newest-inserted first — the reverse of seed order).
    const ids = await cardIds(page);
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL); // no duplicates
    expect(ids.map(Number)).toEqual([...seededIds].reverse()); // no skips, exact keyset order
  });

  test("a failed auto-load is visible and retryable — never a silent stall, never wipes the already-loaded page", async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}`);
    await assertNoErrorSurface(page);
    const cards = page.locator('[data-testid="candidate-card"]');
    await expect(cards).toHaveCount(30);

    // Fail exactly the first page-2+ (cursor-bearing) request once; every
    // other request (page 1, and the retry) passes through untouched.
    let failedOnce = false;
    await page.route("**/api/profiles/*/candidates*", async (route) => {
      const url = new URL(route.request().url());
      if (!failedOnce && url.searchParams.has("cursor")) {
        failedOnce = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: "fallo simulado (e2e)",
            code: "INTERNAL",
            requestId: "e2e-test",
            timestamp: new Date().toISOString(),
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByTestId("infinite-scroll-sentinel").scrollIntoViewIfNeeded();

    // Visible AND the already-loaded 30 items are untouched — a page-2+
    // failure must never wipe the feed the way a page-1 failure does.
    const errorDisplay = page.getByTestId("error-display");
    await expect(errorDisplay).toBeVisible();
    await expect(cards).toHaveCount(30);

    // Retryable: the SAME fetch re-runs on "Reintentar" and succeeds once
    // the interception has already fired its one failure.
    const retryButton = page.getByTestId("retry-button");
    await expect(retryButton).toBeVisible();
    await retryButton.click();
    await expect(cards).toHaveCount(60);
    await expect(errorDisplay).toHaveCount(0);
  });
});

test.describe("desktop (default project viewport)", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
  });

  test("desktop behaviour is unchanged: the button stays the only trigger, scrolling alone loads nothing", async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}`);
    await assertNoErrorSurface(page);

    expect(
      await page.evaluate(() => document.documentElement.clientWidth),
    ).toBeGreaterThan(768);

    const cards = page.locator('[data-testid="candidate-card"]');
    await expect(cards).toHaveCount(30);

    // The sentinel either isn't rendered as an active target or has no
    // layout box on desktop (`md:hidden`) — scrolling all the way to the
    // bottom of the REAL scroll container must not auto-load anything.
    //
    // MEASUREMENT TRAP (review #597 B2 — the sibling of the innerWidth trap
    // this file's header already warns about): the page body does not
    // scroll here. `app/layout.tsx` puts `overflow: auto` on `<main
    // class="main-content">`, not on `document`/`window` — measured,
    // `document.body.scrollHeight` equals `document.documentElement.
    // clientHeight` (nothing to scroll) while `main.scrollHeight` is the
    // real, much taller value. `window.scrollTo(0, document.body.
    // scrollHeight)` is therefore a silent no-op: this exact assertion still
    // passed with the sentinel's `md:hidden` removed entirely (i.e. with
    // desktop auto-load actually wired up), which means it was never
    // exercising the thing it claims to prove. `e2e/triage-loop.spec.ts`
    // already documents this same trap for this codebase (`window.scrollY`
    // stays 0 after `page.mouse.wheel`) and works around it by driving the
    // scrollable element directly — grepped the rest of e2e/ for
    // `window.scrollTo`/`document.body.scrollHeight` and this was the only
    // other place it appeared.
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(500);
    await expect(cards).toHaveCount(30);
    await assertNoErrorSurface(page);

    // The explicit button is still there, still works exactly as before.
    const loadMore = page.getByRole("button", { name: /cargar más/i });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(cards).toHaveCount(60);

    await loadMore.click();
    await expect(cards).toHaveCount(61);
    await expect(loadMore).toHaveCount(0);
  });
});
