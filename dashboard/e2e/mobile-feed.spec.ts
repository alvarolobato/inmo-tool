/**
 * E2E (issue #574): the candidate feed (`/profiles/[id]`) at phone width.
 *
 * The issue's own "measured update" (before this PR) found the feed's own
 * elements didn't overflow `document.documentElement` — that overflow was
 * #571's header row, since fixed. Re-measuring against the worst-case seed
 * (a long profile name + an active seguimiento alert badge + active filter
 * chips, exactly the inputs the issue named) after #571 landed found a
 * real, different bug: `main.main-content` — the `overflow: auto` scroll
 * container the #571 mobile shell gave every page — has its OWN
 * scrollWidth pushed past its clientWidth by two elements:
 *   1. `ProfileSwitcher`'s native `<select>` (no width cap — sizes to the
 *      longest profile NAME, an owner-controlled string).
 *   2. The feed header's right-side group (`app/profiles/[id]/page.tsx`,
 *      "Ver mapa →" + ProfileSwitcher) — non-wrapping (default flex
 *      nowrap), so the select above couldn't drop to its own line.
 *
 * `document.documentElement.scrollWidth` stays === clientWidth throughout
 * (confirmed empirically) because `.main-content`'s own `overflow: auto`
 * absorbs the overflow instead of pushing the whole document sideways —
 * asserting document-level here would be a test that can never fail
 * (it was already true before any fix). This spec asserts on
 * `main.main-content` instead, the container that actually shows a
 * horizontal scrollbar to the owner.
 *
 * The active-filter-chips strip (`CandidateFilterBar.tsx`'s
 * `active-filter-chips`) is INTENTIONALLY `overflowX: "auto"` — a
 * contained horizontal-scroll pill strip, same pattern as the alerts
 * segment's popover. Its chips extending past the viewport on their own
 * (before you scroll the strip) is correct, not a bug — confirmed this
 * does NOT push `main.main-content`'s scrollWidth.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching mobile-profiles.spec.ts / seguimiento-alerts.spec.ts.
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

const MADRID_SOL: [number, number] = [40.4168, -3.7038];
const NAME_PREFIX = "e2e-mobile-feed-";
// Long enough on its own to be the reported widening input (#574's own
// analysis: the switcher's <select> has no width cap and sizes to this).
const LONG_PROFILE_NAME = `${NAME_PREFIX}Alquiler de alto rendimiento en la zona norte de Madrid y alrededores`;

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let propertyId: number;
let listingId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[mobile-feed.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const profRes = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      LONG_PROFILE_NAME,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profRes.rows[0].id;

  // A tracked ("en seguimiento") property with a recent price drop — the
  // second widening input the issue names: the seguimiento alert badge on
  // the segmented control.
  const propRes = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}addr`],
  );
  propertyId = propRes.rows[0].id;
  const listRes = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', 180000, NOW() - interval '2 days', NOW()) RETURNING id`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`],
  );
  listingId = listRes.rows[0].id;
  await pool.query(
    `INSERT INTO listing_price_history (listing_id, observed_at, price)
     VALUES ($1, NOW() - interval '2 days', 200000), ($1, NOW() - interval '1 hour', 180000)`,
    [listingId],
  );
  await pool.query(
    `INSERT INTO feedback_event (property_id, profile_id, feedback_type, created_at)
     VALUES ($1, $2, 'accept', NOW() - interval '3 days')`,
    [propertyId, profileId],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM feedback_event WHERE property_id = $1", [propertyId]);
  await pool.query("DELETE FROM listing_price_history WHERE listing_id = $1", [listingId]);
  await pool.query("DELETE FROM listing WHERE id = $1", [listingId]);
  await pool.query("DELETE FROM property WHERE id = $1", [propertyId]);
  await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function mainContentOverflow(page: Page): Promise<{ clientWidth: number; scrollWidth: number }> {
  return page.evaluate(() => {
    const m = document.querySelector("main.main-content")!;
    return { clientWidth: m.clientWidth, scrollWidth: m.scrollWidth };
  });
}

test.describe("phone width (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("feed has no horizontal overflow at phone width", async ({ page }) => {
    skipIfNoDb(test);

    // Worst-case seed per the issue: long profile name (in the URL via
    // profileId already) + active alerts filter + active chips (search
    // text + onlyNew) — every widening input named in #574's analysis at
    // once.
    await page.goto(
      `/profiles/${profileId}?view=seguimiento&alerts=1&q=${encodeURIComponent("busqueda de prueba larga")}&onlyNew=true`,
      { waitUntil: "networkidle" },
    );
    await expect(page.getByTestId("candidate-filter-bar"), "the feed rendered").toBeVisible();
    await page.waitForTimeout(1000);

    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);

    // The real, falsifiable measurement — see file header for why
    // document.documentElement is NOT it (it was already 390/390 before
    // any fix here, since .main-content's own overflow:auto absorbs it).
    const main = await mainContentOverflow(page);
    expect(
      main.scrollWidth,
      `main.main-content scrollWidth (${main.scrollWidth}) should equal clientWidth (${main.clientWidth}) — this is the pane that actually scrolls sideways for the owner`,
    ).toBeLessThanOrEqual(main.clientWidth + 1);
  });

  test("view segments usable at phone width", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("candidate-filter-bar")).toBeVisible();
    await page.waitForTimeout(500);

    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    for (const testId of ["view-segment-todas", "view-segment-seguimiento", "view-segment-descartadas"]) {
      const el = page.getByTestId(testId);
      await expect(el, `${testId} is visible`).toBeVisible();
      const box = await el.boundingBox();
      expect(box, `${testId} has a bounding box`).not.toBeNull();
      if (box) {
        expect(box.x + box.width, `${testId} stays within the viewport`).toBeLessThanOrEqual(clientWidth + 1);
      }
    }
    // The three segments are still independently clickable (not overlapping,
    // not clipped by an ancestor) — clicking "seguimiento" actually flips
    // the URL/active state rather than silently no-op'ing.
    await page.getByTestId("view-segment-seguimiento").click();
    await expect(page).toHaveURL(/view=seguimiento/);
  });
});
