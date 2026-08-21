/**
 * E2E (issue #659, #665 review L3): the ProfileForm scope-sentinel toggles
 * ("Sin filtro geográfico" / "Todos los tipos") at PHONE width.
 *
 * Issue #659's own EC-1 claims phone-width verification for these toggles,
 * but the test it originally cited (a materialize integration test) never
 * touches ProfileForm or a mobile viewport at all — a real gap between the
 * exit criterion's wording and what was actually verified, caught in
 * review. This closes it directly rather than just softening the claim.
 *
 * Device emulation gotcha (documented in mobile-profiles.spec.ts, repeated
 * here per the same project convention): under Playwright's
 * `devices["iPhone 13"]` emulation, `window.innerWidth` does NOT reflect the
 * emulated 390px viewport — always read `document.documentElement.
 * clientWidth` instead (the constraint this project's mobile specs assert
 * against, D-120/D-121/D-124).
 *
 * Requires a reachable Postgres and ADMIN_API_KEY on the server under test
 * (this is an admin-gated page, middleware.ts) — skips cleanly otherwise,
 * matching quick-refresh.spec.ts / mobile-profiles.spec.ts.
 */
import { test, expect, devices } from "@playwright/test";
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

// Same iPhone-13-minus-defaultBrowserType pattern as mobile-profiles.spec.ts —
// Playwright refuses `defaultBrowserType` inside `test.use`.
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
test.use({ ...iPhone13 });

const NAME_PREFIX = "e2e-mobile-scope-sentinels-";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[profile-form-mobile-scope-sentinels.spec] no reachable Postgres - skipping.");
  }
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("both sentinel toggles are visible, in-viewport, and usable at phone width; saving creates an everywhere+all profile", async ({
  page,
}) => {
  const name = `${NAME_PREFIX}${Date.now()}`;

  await page.goto("/profiles");

  // Sanity: this really is the mobile viewport (mobile-profiles.spec.ts's
  // own documented gotcha — window.innerWidth lies under this emulation).
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(clientWidth).toBeLessThan(768);

  await page.getByRole("button", { name: "Nuevo perfil" }).click();

  const everywhereToggle = page.getByTestId("scope-everywhere-toggle");
  const allTypesToggle = page.getByTestId("scope-all-types-toggle");

  await expect(everywhereToggle).toBeVisible();
  await expect(allTypesToggle).toBeVisible();

  // Both checkboxes' full bounding box must sit inside the phone viewport —
  // not clipped off-screen the way #572's original Entrar-button bug was.
  for (const toggle of [everywhereToggle, allTypesToggle]) {
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth);
  }

  // Toggling "everywhere" replaces the LocationPicker with the explanatory
  // note (ProfileForm.tsx) — reachable and clickable at this width.
  await everywhereToggle.check();
  await expect(page.getByTestId("scope-everywhere-note")).toBeVisible();

  // Toggling "all types" disables the individual type checkboxes.
  await allTypesToggle.check();
  const pisoCheckbox = page.getByRole("checkbox", { name: "Piso" });
  await expect(pisoCheckbox).toBeDisabled();
  await expect(pisoCheckbox).toBeChecked();

  // The scope-preview warning (issue #665 M1) renders once both sentinels
  // are active — visible and readable at this width, not cut off.
  await expect(page.getByTestId("scope-preview-warning")).toBeVisible();

  await page.getByPlaceholder("Ej: Alquiler alto rendimiento, bajo coste").fill(name);
  await page.getByRole("button", { name: "Crear perfil" }).click();

  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

  const { rows } = await pool.query<{ scope: { geography: { type: string }; property_types: unknown } }>(
    "SELECT scope FROM search_profile WHERE name = $1",
    [name],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].scope.geography.type).toBe("everywhere");
  expect(rows[0].scope.property_types).toBe("all");
});
