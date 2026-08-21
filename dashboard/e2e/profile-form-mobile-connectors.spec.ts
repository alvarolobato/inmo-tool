/**
 * E2E (issue #660): the ProfileForm connector-selection picker at PHONE
 * width — same pattern/gotcha as profile-form-mobile-scope-sentinels.spec.ts
 * (#659's own mobile-sentinel spec): under Playwright's `devices["iPhone
 * 13"]` emulation, `window.innerWidth` does NOT reflect the emulated 390px
 * viewport — always read `document.documentElement.clientWidth` instead
 * (D-120/D-121/D-124).
 *
 * Covers: the "Todas las fuentes" master toggle is visible/usable at phone
 * width; unticking it reveals one checkbox per registered connector, each a
 * real ≥44px touch target with no horizontal overflow; a globally-disabled
 * connector (connector_config.enabled=false) renders greyed with the
 * "desactivado globalmente" badge but stays selectable; saving persists the
 * exact selection to `search_profile.scope.connectors`.
 *
 * Requires a reachable Postgres and ADMIN_API_KEY on the server under test
 * (admin-gated page, middleware.ts) — skips cleanly otherwise.
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

const NAME_PREFIX = "e2e-mobile-connectors-";
const ACTIVE_CONNECTOR = "e2e-conn660-active";
const DISABLED_CONNECTOR = "e2e-conn660-disabled";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[profile-form-mobile-connectors.spec] no reachable Postgres - skipping.");
    return;
  }

  await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1)", [
    [ACTIVE_CONNECTOR, DISABLED_CONNECTOR],
  ]);
  await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1)", [
    [ACTIVE_CONNECTOR, DISABLED_CONNECTOR],
  ]);

  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters)
     VALUES ($1, true, 20, false, true, '[]'::jsonb),
            ($2, true, 20, false, true, '[]'::jsonb)`,
    [ACTIVE_CONNECTOR, DISABLED_CONNECTOR],
  );
  // D-055: a crawl connector's global on/off is connector_config.enabled.
  await pool.query(
    `INSERT INTO connector_config (connector_name, enabled) VALUES ($1, false)`,
    [DISABLED_CONNECTOR],
  );
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
    await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1)", [
      [ACTIVE_CONNECTOR, DISABLED_CONNECTOR],
    ]);
    await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1)", [
      [ACTIVE_CONNECTOR, DISABLED_CONNECTOR],
    ]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("connector picker is usable at phone width, greys a globally-disabled connector, and saves the selection", async ({
  page,
}) => {
  const name = `${NAME_PREFIX}${Date.now()}`;

  await page.goto("/profiles");

  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(clientWidth).toBeLessThan(768);

  await page.getByRole("button", { name: "Nuevo perfil" }).click();

  const allConnectorsToggle = page.getByTestId("scope-all-connectors-toggle");
  await expect(allConnectorsToggle).toBeVisible();
  // Default-on (D-055-neutral: every existing profile behaves unchanged).
  await expect(allConnectorsToggle).toBeChecked();

  await allConnectorsToggle.uncheck();

  const activeRow = page.getByTestId(`scope-connector-${ACTIVE_CONNECTOR}`);
  const disabledRow = page.getByTestId(`scope-connector-${DISABLED_CONNECTOR}`);
  await expect(activeRow).toBeVisible({ timeout: 10_000 });
  await expect(disabledRow).toBeVisible();

  // Real ≥44px touch targets, fully inside the phone viewport — no
  // horizontal overflow at 390px (D-120/D-121/D-124).
  for (const row of [activeRow, disabledRow]) {
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth);
  }

  // The globally-disabled connector is greyed AND badged, NEVER hidden — the
  // owner must be able to see why a source is unavailable.
  await expect(disabledRow.getByText("desactivado globalmente")).toBeVisible();
  await expect(activeRow.getByText("desactivado globalmente")).toHaveCount(0);
  // #674 review L1: "greyed" used to be true of the badge only — the
  // connector name rendered at full --fg like every other row, so the word
  // in this test's own title described nothing. Assert the actual dim.
  const dimmed = await disabledRow.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, opacity: Number(s.opacity) };
  });
  const solid = await activeRow.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, opacity: Number(s.opacity) };
  });
  expect(dimmed.color).not.toBe(solid.color);
  expect(dimmed.opacity).toBeLessThan(solid.opacity);
  // Greyed is not disabled: a globally-off source stays selectable (D-055
  // hides its listings at read time; the profile may still name it).
  await expect(disabledRow.getByRole("checkbox")).toBeEnabled();

  // Select ONLY the active connector — the decorative-trap-avoiding part:
  // the disabled one stays visible/selectable but we don't tick it.
  await activeRow.getByRole("checkbox").check();

  await page.getByPlaceholder("Ej: Alquiler alto rendimiento, bajo coste").fill(name);
  await page.getByRole("button", { name: "Crear perfil" }).click();

  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

  const { rows } = await pool.query<{ scope: { connectors: unknown } }>(
    "SELECT scope FROM search_profile WHERE name = $1",
    [name],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].scope.connectors).toEqual([ACTIVE_CONNECTOR]);
});
