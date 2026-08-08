/**
 * E2E (D-041) — issue #447: the "N nuevos" COUNT must equal the number of
 * NUEVO-tagged cards the user actually sees in the feed, ALWAYS.
 *
 * The owner saw a profile advertise ~400 "nuevos" while only 7 cards were
 * tagged NUEVO in the feed (and the count collapsed to 7 after re-visiting).
 * Root cause: the count (`profile-overview.ts` `new_count`, surfaced by the
 * Perfiles row metric + the novedades strip) diverged from the feed's novelty
 * mark (`candidates.ts`) on two axes —
 *   (1) it counted listings from DISABLED portals, which D-055 hides from the
 *       feed entirely (so they can never be a NUEVO card), and
 *   (2) it used a non-strict `>=` against the visit anchor.
 * The feed used a strict `>` on ACTIVE-source listings only. This spec seeds a
 * mix that exercises exactly that gap and asserts the count and the feed agree
 * card-for-card, then advances the anchor and asserts BOTH drop to zero.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or POSTGRES_HOST/PORT/USER/
 * PASSWORD/DB). Skips cleanly if none is reachable, matching
 * novelty-badge.spec.ts / novedades-strip.spec.ts.
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
const NAME_PREFIX = "e2e-nuevos447-";
const DISABLED_SOURCE = `${NAME_PREFIX}off-${Math.random().toString(36).slice(2)}`;

// Active-source, first-seen-NOW matched listings — the ones that ARE NUEVO.
const NEW_ACTIVE_COUNT = 5;
// Old (before-anchor) matched listings — not new, and they keep the fresh
// share under the #425 cold-start threshold (60%) so the marks render at all:
// 5 / (5 + 6) = 45%.
const OLD_ACTIVE_COUNT = 6;
// The bug bait: ONE first-seen-NOW listing whose source is DISABLED. It is
// hidden from the feed (D-055) and must NOT be counted as new either.
const NEW_DISABLED_COUNT = 1;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

let pool: Pool;
let dbAvailable = false;
let profileId: number;

async function seedMatched(
  profId: number,
  firstSeenAt: string,
  price: number,
  source: string,
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}Calle Nueva, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'active', 'sale', $4, $5::timestamptz, NOW())`,
    [propertyId, source, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price, firstSeenAt],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profId, propertyId],
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
      "[nuevos-count-feed-alignment.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // A DISABLED normal connector so listings on DISABLED_SOURCE are hidden from
  // the feed (D-055) — the exact class the count used to over-count.
  await pool.query(
    `INSERT INTO connector_registry (connector_name, registered, supports_discovery, supported_filters)
     VALUES ($1, true, true, '[]'::jsonb)
     ON CONFLICT (connector_name) DO UPDATE SET supports_discovery = EXCLUDED.supports_discovery`,
    [DISABLED_SOURCE],
  );
  await pool.query(
    `INSERT INTO connector_config (connector_name, enabled, capture_enabled, filters)
     VALUES ($1, false, true, '{}'::jsonb)
     ON CONFLICT (connector_name) DO UPDATE SET enabled = false`,
    [DISABLED_SOURCE],
  );

  // Visited before (both slots ~2h/3d ago), so the profile is NOT never-visited
  // (never-visited would trigger #425 cold-start suppression). After the page
  // GET's two-slot touch (last_viewed_at is 2h ago, outside the 30-min
  // debounce), previous_viewed_at settles at ~2h ago — before every fresh
  // first_seen_at (NOW) and after every old one (10 days ago).
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      iso(3 * DAYS),
      iso(2 * HOURS),
    ],
  );
  profileId = res.rows[0].id;

  for (let i = 0; i < NEW_ACTIVE_COUNT; i++) {
    await seedMatched(profileId, iso(0), 300000 + i * 1000, "fotocasa");
  }
  for (let i = 0; i < OLD_ACTIVE_COUNT; i++) {
    await seedMatched(profileId, iso(10 * DAYS), 200000 + i * 1000, "fotocasa");
  }
  for (let i = 0; i < NEW_DISABLED_COUNT; i++) {
    await seedMatched(profileId, iso(0), 250000 + i * 1000, DISABLED_SOURCE);
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
  await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [DISABLED_SOURCE]);
  await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [DISABLED_SOURCE]);
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

// D-041: assert no error surface is rendered anywhere on the page.
async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos/i),
  ).toHaveCount(0);
}

const newCards = (page: Page) =>
  page.locator('[data-testid="candidate-card"][data-novelty="new"]');
const allCards = (page: Page) => page.locator('[data-testid="candidate-card"]');

test("the 'N nuevos' count equals the number of NUEVO cards in the feed, and the disabled-source listing inflates neither", async ({
  page,
}) => {
  skipIfNoDb(test);

  // --- Feed: how many NUEVO cards does the user actually see? ---
  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  // All active-source cards fit on one page (5 + 6 = 11 < 30). The disabled
  // one is hidden entirely (D-055), so it is NOT among the cards.
  await expect(allCards(page)).toHaveCount(NEW_ACTIVE_COUNT + OLD_ACTIVE_COUNT);
  await expect(page.getByTestId("novelty-cold-start-note")).toHaveCount(0);
  await expect(newCards(page)).toHaveCount(NEW_ACTIVE_COUNT);

  // --- Perfiles: the count metric must equal that visible NUEVO card count ---
  await page.goto("/");
  await assertNoErrorSurface(page);
  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(row).toBeVisible();
  // The alignment invariant: count == number of NUEVO feed rows. NOT
  // NEW_ACTIVE_COUNT + NEW_DISABLED_COUNT (the pre-#447 over-count).
  await expect(row.getByTestId("profile-metric-new")).toContainText(String(NEW_ACTIVE_COUNT));
});

test("advancing the visit anchor drops the count and the feed's NUEVO marks together to zero", async ({
  page,
}) => {
  skipIfNoDb(test);

  // Simulate the NEXT visit: both anchor slots move to NOW(), past every
  // listing's first_seen_at. A page-GET touch is then inside the 30-min
  // debounce and cannot re-shift the anchor back.
  await pool.query(
    `UPDATE search_profile SET previous_viewed_at = NOW(), last_viewed_at = NOW() WHERE id = $1`,
    [profileId],
  );

  // Feed: no card is NUEVO anymore (the active-source cards still render).
  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);
  await expect(allCards(page)).toHaveCount(NEW_ACTIVE_COUNT + OLD_ACTIVE_COUNT);
  await expect(newCards(page)).toHaveCount(0);

  // Perfiles: the count drops identically to 0.
  await page.goto("/");
  await assertNoErrorSurface(page);
  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("profile-metric-new")).toContainText("0");
});
