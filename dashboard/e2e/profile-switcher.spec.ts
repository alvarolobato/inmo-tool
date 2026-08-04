/**
 * E2E: header profile switcher on `/profiles/:id` (issue #162).
 *
 * #162 reported the switcher rendering a phantom "Perfil no encontrado"
 * option next to the correct profile, reproduced on two pre-#201 commits
 * (74cb59c, 5fa246a). Re-verified against `main` @ ffe18a4 (post-#201
 * Perfiles rewrite) before starting any fix: `ProfileSwitcher` (component
 * layout/ProfileSwitcher.tsx) already guards the placeholder behind a
 * `currentExists` check that only renders it when the current id is
 * genuinely absent from the fetched profile list — the bug no longer
 * reproduces. This spec locks that behavior in with a real browser + real
 * Postgres, per the issue's own acceptance criterion ("Covered by an e2e
 * assertion on /profiles/:id").
 */
import { test, expect } from "@playwright/test";
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
const NAME_PREFIX = "e2e-switcher-";

let pool: Pool;
let dbAvailable = false;
let firstProfileId: number;
let secondProfileId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[profile-switcher.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const scope = JSON.stringify({
    geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
    property_types: ["piso"],
    hard_exclusions: {},
  });

  const first = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [`${NAME_PREFIX}first-${Date.now()}`, scope],
  );
  firstProfileId = first.rows[0].id;

  const second = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [`${NAME_PREFIX}second-${Date.now()}`, scope],
  );
  secondProfileId = second.rows[0].id;
});

test.afterAll(async () => {
  if (!dbAvailable) return;
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

test("lists exactly the existing profiles, with no 'Perfil no encontrado' phantom option", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${firstProfileId}`);

  const select = page.getByRole("combobox", { name: "Cambiar de perfil de búsqueda" });
  await expect(select).toBeVisible();

  // Exactly the two seeded (non-archived) profiles — no extra placeholder.
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select.getByText("Perfil no encontrado")).toHaveCount(0);

  // The current profile resolves to a real, non-disabled option.
  const currentOption = select.locator(`option[value="${firstProfileId}"]`);
  await expect(currentOption).toHaveCount(1);
  await expect(currentOption).not.toBeDisabled();
});
