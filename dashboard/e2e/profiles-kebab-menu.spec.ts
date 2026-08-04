/**
 * E2E: the profile row kebab (three-dots) overflow menu sizes to its content,
 * never to the full container width.
 *
 * Bug: opening the kebab on a profile row in `/profiles` rendered the
 * Editar/Clonar/Archivar menu at the full VIEWPORT width (~1280px) instead of
 * hugging its three short labels. Root cause was in `ProfileOverviewRow`'s
 * `OverflowMenu`: `<MenuItems anchor="bottom end">` lets Headless UI position
 * the (portaled) panel via floating-ui, which sets its own `left`; the panel's
 * style ALSO set `position: absolute; right: 0`, so with both a `left` and a
 * `right: 0` and no width the element stretched edge-to-edge. The fix drops the
 * manual positioning (Headless UI owns it) and sets `width: max-content` with a
 * `minWidth`/`maxWidth`, so the panel hugs its labels.
 *
 * D-041 regression net for the profiles surface: seed one profile, open its
 * kebab, assert the menu's rendered width is content-sized (well under the row
 * width and nowhere near full-viewport) while its items are all present.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching candidates.spec.ts / profile-switcher.spec.ts.
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
const NAME_PREFIX = "e2e-kebab-";

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
      "[profiles-kebab-menu.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;
});

test.afterAll(async () => {
  if (!dbAvailable) return;
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

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

test("profile kebab menu hugs its content instead of stretching full width", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
  await expect(row).toBeVisible();
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error("no profile row bounding box");

  const kebab = row.getByRole("button", { name: /más acciones/i });
  await kebab.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // The menu is the right one: its three actions are present.
  await expect(menu.getByRole("menuitem", { name: "Editar" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Clonar" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archivar" })).toBeVisible();

  const menuBox = await menu.boundingBox();
  if (!menuBox) throw new Error("no menu bounding box");

  const viewport = page.viewportSize();
  const viewportWidth = viewport?.width ?? 1280;

  // The bug rendered this at ~full viewport width. Assert it is content-sized:
  // comfortably narrower than the row, and nowhere near the viewport edge. The
  // component caps it at maxWidth 240; 300 leaves headroom without admitting a
  // regression back toward full-width.
  expect(menuBox.width).toBeLessThan(300);
  expect(menuBox.width).toBeLessThan(rowBox.width * 0.6);
  expect(menuBox.width).toBeLessThan(viewportWidth * 0.4);
});
