/**
 * E2E (D-041): "Más filtros" popover stays on-screen + "Limpiar todo" is always
 * visible — CandidateFilterBar overflow/layout fixes.
 *
 * Two owner-reported bugs, both purely presentational, both in
 * components/candidates/CandidateFilterBar.tsx:
 *
 *   (1) "Cuando selecciono más filtros el popup se sale de la pantalla." The
 *       "Más filtros" popover panel was `position:absolute; left:0`, so when the
 *       trigger sat near the right edge (wide feed) or the bar wrapped on narrow
 *       widths, the 300px panel spilled off-screen and was unreachable. The fix
 *       anchors it viewport-aware (headlessui `anchor="bottom end"`, Floating UI
 *       flip/shift) + caps width to min(300px,92vw) and height to 70vh w/ scroll.
 *
 *   (2) "Limpiar todo hace un efecto raro que salta la pantalla, déjalo siempre
 *       visible." The button was conditionally rendered (only with ≥1 active
 *       filter), so it popped in/out and shifted the bar. The fix keeps it always
 *       rendered — disabled/muted when nothing is active.
 *
 * This spec drives a real Next.js server against a real, self-seeded Postgres
 * (same admin-session pattern as filter-bar-url-state.spec.ts). It asserts:
 *   (a) at 1920px AND 480px, opening "Más filtros" yields a panel whose bounding
 *       box is FULLY inside the viewport (x>=0, x+w<=vw, y>=0, y+h<=vh);
 *   (b) "Limpiar todo" is present/visible with AND without active filters, and
 *       toggling a filter does not change the primary row's height or the
 *       button's position (no layout jump);
 *   (c) no error surface renders.
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

// Distinct coordinates so a concurrent seed can't overlap this file's radius scan.
const CENTER: [number, number] = [39.4699, -0.3763]; // Valencia
const NAME_PREFIX = "e2e-mas-filtros-overflow-";

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
      "[mas-filtros-popover-overflow.spec] no reachable Postgres - skipping e2e suite. " +
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
        geography: { type: "radius", center: CENTER, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  // One matched property so the feed (and thus the filter bar) renders normally.
  const propResult = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [CENTER[0], CENTER[1], `${NAME_PREFIX}Calle Prueba, Valencia`],
  );
  const propertyId = propResult.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', 200000, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN " +
      "(SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query(
    "DELETE FROM property WHERE id NOT IN (SELECT property_id FROM listing) AND address LIKE $1",
    [`${NAME_PREFIX}%`],
  );
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/error|hubo un problema|there is no parameter|http 500|no válid/i),
  ).toHaveCount(0);
}

// Open "Más filtros" and assert the panel's bounding box is fully on-screen for
// the current viewport. 1px tolerance for sub-pixel layout rounding.
async function assertPanelWithinViewport(page: Page) {
  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport size");

  await page.getByTestId("more-filters-button").click();
  const panel = page.getByTestId("more-filters-panel");
  await expect(panel).toBeVisible();

  const box = await panel.boundingBox();
  expect(box, "panel should have a bounding box").not.toBeNull();
  const { x, y, width, height } = box!;

  const T = 1;
  expect(x, "panel left edge must not be off-screen left").toBeGreaterThanOrEqual(-T);
  expect(
    x + width,
    "panel right edge must not spill past the viewport width",
  ).toBeLessThanOrEqual(vp.width + T);
  expect(y, "panel top edge must not be off-screen top").toBeGreaterThanOrEqual(-T);
  expect(
    y + height,
    "panel bottom edge must not be clipped below the fold",
  ).toBeLessThanOrEqual(vp.height + T);

  // Close so subsequent assertions aren't overlapped by the panel.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
}

for (const vp of [
  { name: "wide (1920×1080)", width: 1920, height: 1080 },
  { name: "narrow (480×800)", width: 480, height: 800 },
]) {
  test(`"Más filtros" popover stays within the viewport — ${vp.name}`, async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/profiles/${profileId}`);
    await assertNoErrorSurface(page);
    await expect(page.getByTestId("candidate-filter-bar")).toBeVisible();

    await assertPanelWithinViewport(page);
    await assertNoErrorSurface(page);
  });
}

test('"Limpiar todo" is always visible and never shifts the bar', async ({ page }) => {
  skipIfNoDb(test);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const primaryRow = page.getByTestId("candidate-filter-row-primary");
  const clearAll = page.getByTestId("clear-all-filters");
  await expect(primaryRow).toBeVisible();

  // (b1) Present + visible with NO active filters (previously it was absent).
  await expect(clearAll).toBeVisible();
  await expect(clearAll).toBeDisabled();

  // Snapshot the geometry BEFORE toggling any filter.
  const rowBefore = await primaryRow.boundingBox();
  const clearBefore = await clearAll.boundingBox();
  expect(rowBefore).not.toBeNull();
  expect(clearBefore).not.toBeNull();

  // Toggle a primary-row filter ON (⚠ Con alertas) — this used to make
  // "Limpiar todo" appear from nothing and jump the layout.
  await page.getByTestId("alerts-segment-with").click();
  await assertNoErrorSurface(page);

  // (b2) Still present + visible, now enabled/clickable.
  await expect(clearAll).toBeVisible();
  await expect(clearAll).toBeEnabled();

  // (b3) No layout shift: the primary row height and the button position are
  // unchanged whether or not a filter is active.
  const rowAfter = await primaryRow.boundingBox();
  const clearAfter = await clearAll.boundingBox();
  const T = 1;
  expect(Math.abs(rowAfter!.height - rowBefore!.height)).toBeLessThanOrEqual(T);
  expect(Math.abs(clearAfter!.x - clearBefore!.x)).toBeLessThanOrEqual(T);
  expect(Math.abs(clearAfter!.y - clearBefore!.y)).toBeLessThanOrEqual(T);

  // Clicking it clears everything and returns to the disabled resting state
  // WITHOUT the button disappearing or the row changing height.
  await clearAll.click();
  await assertNoErrorSurface(page);
  await expect(clearAll).toBeVisible();
  await expect(clearAll).toBeDisabled();
  const rowReset = await primaryRow.boundingBox();
  expect(Math.abs(rowReset!.height - rowBefore!.height)).toBeLessThanOrEqual(T);
});
