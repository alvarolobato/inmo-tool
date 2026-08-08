/**
 * E2E (D-041): clicking "Editar" on a profile opens the edit form in a
 * focus-managed modal, not silently inline at the top of the page (issue #446).
 *
 * Before this change the edit form rendered inline above the list; with the row
 * far down, the form appeared off-screen and the click seemed to do nothing.
 * The fix presents ProfileForm inside a centered modal that autofocuses the
 * first field. This spec seeds a real profile, opens the kebab → Editar, and
 * asserts the modal is visibly presented, the name field is focused, an edit
 * saves through the unchanged PATCH pipeline, and no error surface appears.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is reachable,
 * matching profiles-kebab-menu.spec.ts / profiles.spec.ts.
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
const NAME_PREFIX = "e2e-edit-modal-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let originalName: string;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[profile-edit-modal.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  originalName = `${NAME_PREFIX}${Date.now()}`;
  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      originalName,
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
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
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

// D-041: no error surface anywhere on the page.
async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(
      /there is no parameter|http 500|error al cargar|detalles técnicos|hubo un problema/i,
    ),
  ).toHaveCount(0);
  await expect(page.locator('[data-testid="error-display"]')).toHaveCount(0);
}

test("clicking Editar opens a focus-managed modal and the edit saves", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  const row = page.locator(
    `[data-testid="profile-row"][data-profile-id="${profileId}"]`,
  );
  await expect(row).toBeVisible();

  // The edit form must NOT already be on the page (it used to render inline).
  const modal = page.getByTestId("profile-edit-modal");
  await expect(modal).toHaveCount(0);

  // Open the kebab overflow and click Editar.
  await row.getByRole("button", { name: /más acciones/i }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Editar" }).click();

  // The form is now VISIBLY PRESENTED in a modal dialog (the whole point of
  // #446 — it no longer goes unnoticed).
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("role", "dialog");
  await expect(modal).toHaveAttribute("aria-modal", "true");

  // The first field is focused so the user knows the form opened and can type.
  const nameInput = modal.getByTestId("profile-name-input");
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue(originalName);

  // The save/validation flow is intact: edit the name and save.
  const newName = `${originalName}-editado`;
  await nameInput.fill(newName);
  await modal.getByRole("button", { name: "Guardar cambios" }).click();

  // The modal closes and the renamed profile lands back in the list.
  await expect(modal).toHaveCount(0);
  await expect(page.getByText(newName)).toBeVisible({ timeout: 10_000 });
  await assertNoErrorSurface(page);

  // The rename actually persisted through the unchanged PATCH pipeline.
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM search_profile WHERE id = $1",
    [profileId],
  );
  expect(rows[0]?.name).toBe(newName);
});

test("the edit modal closes on Escape without saving", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  const row = page.locator(
    `[data-testid="profile-row"][data-profile-id="${profileId}"]`,
  );
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: /más acciones/i }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Editar" }).click();

  const modal = page.getByTestId("profile-edit-modal");
  await expect(modal).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await assertNoErrorSurface(page);
});
