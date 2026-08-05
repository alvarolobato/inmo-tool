/**
 * E2E (D-041): the "novedades" strip (issue #195) on the home / Perfiles
 * surface renders REAL new-candidate counts against seeded Postgres, with no
 * error surface — the exact class of bug D-041 exists to catch (a strip that's
 * green in unit tests but 500s or renders a placeholder against real data).
 *
 * #195 retired the dead `/inicio` Phase-1 placeholder: `/` and `/inicio` now
 * render the redesigned Perfiles page, and the strip above the rows sums each
 * profile's `new_count` (matched candidates first-seen since the profile's
 * `last_viewed_at`; for a never-visited profile, everything matched counts as
 * new). This spec seeds one never-visited profile with 3 matched properties,
 * loads `/`, and asserts the strip surfaces them and jumps to the row.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching candidates.spec.ts / profiles-kebab-menu.spec.ts.
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
const NAME_PREFIX = "e2e-novedades-";
const NEW_COUNT = 3;

let pool: Pool;
let dbAvailable = false;
let profileId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[novedades-strip.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // A never-visited profile (last_viewed_at defaults NULL) — so every matched
  // property first-seen recently counts as "new since last visit".
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

  for (let i = 0; i < NEW_COUNT; i++) {
    const prop = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address, created_at)
       VALUES ($1, $2, 'piso', $3, $4, NOW()) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], 60 + i, `${NAME_PREFIX}Calle Nueva ${i}, Madrid`],
    );
    const propertyId = prop.rows[0].id;
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, last_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', $3, NOW(), NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, 200000 + i * 1000],
    );
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN " +
      "(SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM listing WHERE property_id IN (SELECT id FROM property WHERE address LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
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

test("home surface shows the novedades strip with real new-candidate counts and jumps to the profile", async ({
  page,
}) => {
  skipIfNoDb(test);

  // `/` renders the merged Perfiles surface (issue #195 retired the /inicio placeholder).
  await page.goto("/");
  await assertNoErrorSurface(page);

  // The strip is real data (not a placeholder/skeleton) — it reflects at least
  // this profile's 3 freshly-matched candidates.
  const strip = page.getByTestId("novedades-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(/nuevos? en total/);
  const totalNew = Number(await strip.getAttribute("data-total-new"));
  expect(totalNew).toBeGreaterThanOrEqual(NEW_COUNT);

  // The seeded profile's own row agrees with the strip: it shows its 3 nuevos.
  const myRow = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(myRow).toBeVisible();
  await expect(myRow.getByTestId("profile-metric-new")).toContainText(String(NEW_COUNT));

  // Clicking the strip jumps to and highlights the profile that changed.
  await strip.click();
  await expect(page.locator('[data-testid="profile-row"][data-highlighted="true"]')).toHaveCount(1);
});
