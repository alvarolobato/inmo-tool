/**
 * E2E (D-041): the feed's NUEVO novelty mark (#416, plan #415 §3.1) against a
 * real Next.js server + seeded Postgres.
 *
 * This is the "anchor test" — the one that would have caught the
 * touchProfileViewedAt trap #416 exists to fix. A naive "highlight rows newer
 * than last_viewed_at" implementation renders an EMPTY highlight on every
 * visit, because GET /api/profiles/[id] (which the feed page fires on mount)
 * stamps last_viewed_at = NOW() before the candidates query runs. #416 anchors
 * novelty on the SHIFTED previous_viewed_at instead, so the mark must:
 *   1. survive the whole visit — reload, a filter re-fetch, and "Cargar más"
 *      all keep the same cards marked;
 *   2. expire on the NEXT visit — once the anchor advances past the listing's
 *      first_seen_at, the mark is gone.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the schema applied. Skips
 * cleanly if none is reachable, matching candidates.spec.ts /
 * novedades-strip.spec.ts.
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
const NAME_PREFIX = "e2e-novelty-";
// One full page (30) + one, so "Cargar más" surfaces a real second page.
const SURVIVE_COUNT = 31;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

let pool: Pool;
let dbAvailable = false;
// Profile whose mark must survive the whole visit.
let surviveProfileId: number;
// Profile whose mark must expire on the next visit.
let expireProfileId: number;
let expirePropertyId: number;

async function seedProfile(prevViewedAt: string | null, lastViewedAt: string | null): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      prevViewedAt,
      lastViewedAt,
    ],
  );
  return res.rows[0].id;
}

async function seedMatched(profileId: number, firstSeenAt: string, price: number): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}Calle Nueva, Madrid`],
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
      "[novelty-badge.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // "Survive" profile: a prior visit 2h ago (previous visit 3 days before
  // that). Every listing is first-seen NOW() — after the anchor either way, so
  // every card is new. The 2h-ago last_viewed_at is OUTSIDE the 30-min session
  // debounce, so this visit's touch shifts previous_viewed_at forward to 2h
  // ago — still before every first_seen_at, so the marks hold; and a reload
  // within the session is INSIDE the debounce, so the anchor does not move
  // again.
  surviveProfileId = await seedProfile(iso(3 * DAYS), iso(2 * HOURS));
  for (let i = 0; i < SURVIVE_COUNT; i++) {
    await seedMatched(surviveProfileId, iso(0), 300000 + i * 1000);
  }

  // "Expire" profile: anchored 2h ago, its one listing first-seen 1h ago — so
  // it starts new. The test then advances the anchor past first_seen_at to
  // simulate the next visit.
  expireProfileId = await seedProfile(iso(2 * HOURS), iso(2 * HOURS));
  expirePropertyId = await seedMatched(expireProfileId, iso(1 * HOURS), 250000);
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

const newCards = (page: Page) => page.locator('[data-testid="candidate-card"][data-novelty="new"]');
const allCards = (page: Page) => page.locator('[data-testid="candidate-card"]');

test("the NUEVO mark survives the whole visit — reload, a filter re-fetch, and Cargar más all keep it", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${surviveProfileId}`);
  await assertNoErrorSurface(page);

  // First page: 30 real cards, every one marked new (NUEVO badge + the
  // data-novelty root hook).
  await expect(allCards(page)).toHaveCount(30);
  await expect(newCards(page)).toHaveCount(30);
  await expect(page.getByTestId("candidate-novelty").first()).toHaveText(/nuevo/i);

  // Reload — the exact case a naive last_viewed_at anchor would render empty,
  // because the page GET stamps last_viewed_at = NOW() on arrival. The
  // two-slot anchor keeps every card marked.
  await page.reload();
  await assertNoErrorSurface(page);
  await expect(newCards(page)).toHaveCount(30);

  // A filter re-fetch (fetchPage with includeRejected=true) — same code path
  // as any filter change — must not drop the marks either.
  await page.getByTestId("show-rejected-toggle").check();
  await expect(newCards(page)).toHaveCount(30);

  // "Cargar más" pulls a genuine second page; the 31st card is new too.
  const loadMore = page.getByRole("button", { name: /cargar más/i });
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await expect(allCards(page)).toHaveCount(SURVIVE_COUNT);
  await expect(newCards(page)).toHaveCount(SURVIVE_COUNT);
});

test("the NUEVO mark expires on the NEXT visit — once the anchor advances past the listing", async ({
  page,
}) => {
  skipIfNoDb(test);

  const card = page.locator(
    `[data-testid="candidate-card"][data-property-id="${expirePropertyId}"]`,
  );

  // This visit: the listing (first-seen 1h ago) is new against the 2h-ago
  // anchor.
  await page.goto(`/profiles/${expireProfileId}`);
  await assertNoErrorSurface(page);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-novelty", "new");
  await expect(card.getByTestId("candidate-novelty")).toBeVisible();

  // Simulate the NEXT visit: the anchor advances to now (past the listing's
  // first_seen_at). Set both slots so a page-GET touch — inside the debounce,
  // so it won't re-shift — cannot resurrect the mark.
  await pool.query(
    `UPDATE search_profile SET previous_viewed_at = NOW(), last_viewed_at = NOW() WHERE id = $1`,
    [expireProfileId],
  );

  await page.reload();
  await assertNoErrorSurface(page);
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute("data-novelty");
  await expect(card.getByTestId("candidate-novelty")).toHaveCount(0);
});
