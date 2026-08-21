/**
 * E2E (issue #667) — the "Ver novedades" button on `/profiles`: one tap from
 * a profile row to that profile's feed filtered to exactly the candidates
 * that are new since the owner's last visit, and nothing else.
 *
 * Reuses the exact "new" definition #416/#447 already established (visit
 * anchor = `previous_viewed_at`, measured on active-source `first_seen_at`)
 * and the #447 count⇔feed alignment discipline: the button shows no count of
 * its own — it links to the SAME `new_count` the row's "N nuevos" metric
 * already displays — so this spec seeds a mix of NEW and OLD matched
 * candidates and asserts the OLD ones are absent after clicking through, not
 * just that the NEW ones are present (the "decorative fixture" trap: a
 * fixture where every candidate is new never exercises the filter at all).
 *
 * A second, zero-new profile asserts the button is hidden (not disabled,
 * not shown with "0") when there is nothing new.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching nuevos-count-feed-alignment.spec.ts / mobile-profiles.spec.ts.
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
const NAME_PREFIX = "e2e-ver-novedades-";

// Kept under the #425 cold-start fresh-share threshold (60%) so the visit
// anchor genuinely governs novelty rather than tripping pool-coverage
// suppression: 3 / (3 + 4) = 43%.
const NEW_COUNT = 3;
const OLD_COUNT = 4;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

let pool: Pool;
let dbAvailable = false;
let profileWithNewId: number;
let profileZeroNewId: number;
const newPropertyIds: number[] = [];
const oldPropertyIds: number[] = [];

async function seedMatched(
  profileId: number,
  firstSeenAt: string,
  price: number,
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 68, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}Calle Mayor, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4::timestamptz, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price, firstSeenAt],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
  );
  return propertyId;
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[ver-novedades.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // Visited before (both anchor slots ~2h/3d ago, mirroring
  // nuevos-count-feed-alignment.spec.ts) — a real visit anchor, never the
  // never-visited cold-start path, so novelty/onlyNew behave exactly as a
  // returning owner would see them.
  const profNew = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      `${NAME_PREFIX}with-new-${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      iso(3 * DAYS),
      iso(2 * HOURS),
    ],
  );
  profileWithNewId = profNew.rows[0].id;

  for (let i = 0; i < NEW_COUNT; i++) {
    newPropertyIds.push(await seedMatched(profileWithNewId, iso(0), 300000 + i * 1000));
  }
  for (let i = 0; i < OLD_COUNT; i++) {
    oldPropertyIds.push(await seedMatched(profileWithNewId, iso(10 * DAYS), 200000 + i * 1000));
  }

  // Second profile: same visit anchor, but every matched candidate is OLD —
  // new_count = 0, so the row must show no "Ver novedades" button at all.
  const profZero = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      `${NAME_PREFIX}zero-new-${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      iso(3 * DAYS),
      iso(2 * HOURS),
    ],
  );
  profileZeroNewId = profZero.rows[0].id;
  for (let i = 0; i < 2; i++) {
    await seedMatched(profileZeroNewId, iso(10 * DAYS), 210000 + i * 1000);
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

function rowFor(page: Page, profileId: number) {
  return page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
}

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos/i),
  ).toHaveCount(0);
}

test.describe("desktop", () => {
  test("'Ver novedades' is visible only on the profile row with new candidates", async ({ page }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    await assertNoErrorSurface(page);

    const withNewRow = rowFor(page, profileWithNewId);
    await expect(withNewRow).toBeVisible();
    await expect(withNewRow.getByTestId("profile-metric-new")).toContainText(String(NEW_COUNT));
    await expect(withNewRow.getByTestId("profile-ver-novedades")).toBeVisible();
    await expect(withNewRow.getByTestId("profile-ver-novedades")).toHaveAttribute(
      "href",
      `/profiles/${profileWithNewId}?onlyNew=true`,
    );

    const zeroRow = rowFor(page, profileZeroNewId);
    await expect(zeroRow).toBeVisible();
    await expect(zeroRow.getByTestId("profile-metric-new")).toContainText("0");
    await expect(zeroRow.getByTestId("profile-ver-novedades")).toHaveCount(0);
  });

  test("Ver novedades navigates to the profile feed filtered to only new candidates, old ones absent", async ({
    page,
  }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    await rowFor(page, profileWithNewId).getByTestId("profile-ver-novedades").click();

    await expect(page).toHaveURL(new RegExp(`/profiles/${profileWithNewId}\\?onlyNew=true`));
    await assertNoErrorSurface(page);

    const cards = page.locator('[data-testid="candidate-card"]');
    await expect(cards).toHaveCount(NEW_COUNT);
    for (const id of newPropertyIds) {
      await expect(page.locator(`[data-testid="candidate-card"][data-property-id="${id}"]`)).toBeVisible();
    }
    for (const id of oldPropertyIds) {
      await expect(page.locator(`[data-testid="candidate-card"][data-property-id="${id}"]`)).toHaveCount(0);
    }

    // The onlyNew chip is visibly active — the filter is discoverable and
    // clearable without back-navigation.
    await expect(page.getByTestId("filter-chip-onlyNew")).toContainText("Solo nuevos");
  });

  test("the onlyNew feed count matches the profile row's new_count", async ({ page }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    const newCountText = await rowFor(page, profileWithNewId)
      .getByTestId("profile-metric-new")
      .innerText();
    expect(newCountText).toContain(String(NEW_COUNT));

    await rowFor(page, profileWithNewId).getByTestId("profile-ver-novedades").click();
    await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(NEW_COUNT);
  });

  test("the onlyNew chip clears the filter and restores the full feed", async ({ page }) => {
    skipIfNoDb(test);
    await page.goto(`/profiles/${profileWithNewId}?onlyNew=true`);
    await assertNoErrorSurface(page);
    await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(NEW_COUNT);

    await page.getByTestId("filter-chip-clear-onlyNew").click();

    await expect(page).not.toHaveURL(/onlyNew/);
    await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(NEW_COUNT + OLD_COUNT);
    for (const id of oldPropertyIds) {
      await expect(page.locator(`[data-testid="candidate-card"][data-property-id="${id}"]`)).toBeVisible();
    }
  });
});

// Device emulation gotcha (see mobile-profiles.spec.ts's file header): under
// this project's chromium mobile emulation, `window.innerWidth` does NOT
// track the emulated viewport — always read `document.documentElement.clientWidth`.
test.describe("iPhone 13", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  async function clientWidth(page: Page): Promise<number> {
    return page.evaluate(() => document.documentElement.clientWidth);
  }

  test("no horizontal overflow and the button meets the 44px tap target", async ({ page }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    const width = await clientWidth(page);
    expect(width).toBeLessThan(768); // sanity: this really is the mobile viewport

    const button = rowFor(page, profileWithNewId).getByTestId("profile-ver-novedades");
    await expect(button).toBeVisible();

    // Scoped to <main> — TopBar's own pre-existing mobile overflow (#571) is
    // explicitly out of scope here, same discipline mobile-profiles.spec.ts
    // uses.
    const offenders = await page.evaluate((clientW) => {
      const main = document.querySelector("main");
      if (!main) return [];
      const bad: { tag: string; testid: string | null; right: number }[] = [];
      main.querySelectorAll("*").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > clientW + 1) {
          bad.push({ tag: el.tagName, testid: el.getAttribute("data-testid"), right: rect.right });
        }
      });
      return bad;
    }, width);
    expect(offenders).toEqual([]);

    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // Tap target >= 44px (D-124's floor — he is using a thumb).
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
