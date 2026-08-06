/**
 * E2E (D-041): profile templates / faster onboarding (issue #39, part of #8).
 *
 * The user-facing contract this locks in: the create-profile panel offers
 * thesis "starting-point" templates above the form; picking one PRE-FILLS the
 * form with that thesis's plausible defaults, and the investor can still edit
 * every field before saving (EC-1). "Empezar en blanco" keeps the original
 * blank flow — asserted separately by e2e/profiles.spec.ts and the create flows
 * in quick-refresh.spec.ts / location-picker.spec.ts, all left unmodified (EC-3).
 *
 * Drives a real Next.js server against a real (seeded, synthetic) Postgres,
 * saves through POST /api/profiles, and reads the row back to prove the
 * template's scope + thesis_params actually flowed through to persistence — the
 * class of bug a mocked unit test never runs. Skips cleanly with no reachable
 * Postgres / ADMIN_API_KEY, matching the sibling specs.
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

const NAME_PREFIX = "e2e-profile-templates-";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[profile-templates.spec] no reachable Postgres - skipping e2e suite.",
    );
  }
});

test.afterAll(async () => {
  if (dbAvailable) {
    // FK-safe: the create flow enqueues an etl_manual_trigger + may materialize,
    // but this test's profile matches no seeded property, so only its own row
    // (and the queue) need clearing. Prefix-scoped so no sibling spec is touched.
    await pool.query("DELETE FROM etl_manual_trigger");
    await pool.query(
      "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
      [`${NAME_PREFIX}%`],
    );
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [
      `${NAME_PREFIX}%`,
    ]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
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

test("template selection pre-fills form fields", async ({ page }) => {
  const name = `${NAME_PREFIX}${Date.now()}`;

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  await page.getByRole("button", { name: "Nuevo perfil" }).click();

  // The template chooser is offered above the form, with "Empezar en blanco"
  // still available (EC-3).
  await expect(page.getByTestId("template-picker")).toBeVisible();
  await expect(page.getByTestId("template-option-blank")).toBeVisible();

  // Pick the buy-to-let / high-yield rental template.
  await page.getByTestId("template-option-buy-to-let").click();

  // --- EC-1: the form is PRE-FILLED with the template's defaults -------------
  const nameInput = page.getByPlaceholder(
    "Ej: Alquiler alto rendimiento, bajo coste",
  );
  await expect(nameInput).toHaveValue("Alquiler alto rendimiento");
  // A sensible target yield seeded into thesis_params.
  const yieldInput = page.getByTestId("thesis-target-yield");
  await expect(yieldInput).toHaveValue("7");

  // --- EC-1: the pre-filled values are STILL EDITABLE before saving ----------
  await nameInput.fill(name);
  await expect(nameInput).toHaveValue(name);
  await yieldInput.fill("9");
  await expect(yieldInput).toHaveValue("9");

  await page.getByRole("button", { name: "Crear perfil" }).click();

  // The new profile lands in the list — no error surface through the save.
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
  await assertNoErrorSurface(page);

  // The template's scope + thesis (with the one edited field) actually
  // persisted — proof the pre-fill flowed through the whole create pipeline,
  // not just the client state.
  const row = await pool.query<{
    scope: Record<string, unknown>;
    thesis_params: Record<string, unknown>;
  }>("SELECT scope, thesis_params FROM search_profile WHERE name = $1", [name]);
  expect(row.rows).toHaveLength(1);
  const { scope, thesis_params } = row.rows[0];
  expect(scope.property_types).toEqual(["piso"]);
  expect(scope.price_min).toBe(80000);
  expect(scope.price_max).toBe(180000);
  // thesis_type from the template, target_yield reflecting the user's edit.
  expect(thesis_params.thesis_type).toBe("rent");
  expect(thesis_params.target_yield_pct).toBe(9);
});
