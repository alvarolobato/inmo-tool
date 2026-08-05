/**
 * E2E (D-041): the redesigned Perfiles surface (issue #196, part of #176).
 *
 * The Perfiles list was redesigned from a flat CRUD list into a visual,
 * metric-bearing surface (issues #191–#195): each active profile renders as a
 * rich row with a live metrics line (matched/new counts, price range, model
 * state, yield, AI-flag count), a sneak-peek thumbnail strip, an
 * Entrar-is-primary interaction model with Editar/Clonar/Archivar behind a
 * kebab overflow, a zero-candidate diagnostic that names a *specific* cause,
 * and a visibly-broken row for a malformed-scope profile instead of silently
 * dropping it (issue #113). `/` and `/inicio` now render this same surface
 * (issue #195 retired the dead Phase-1 placeholder).
 *
 * This spec drives a real Next.js server against a real (seeded, synthetic)
 * Postgres and asserts each of those surfaces renders REAL content with NO
 * error surface — the exact class of bug D-041 exists to catch (a page that's
 * green in unit tests but 500s or renders a placeholder against real SQL).
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the task 1.2 schema applied.
 * Skips cleanly if none is reachable, matching candidates.spec.ts /
 * novedades-strip.spec.ts / profiles-kebab-menu.spec.ts.
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
// A deliberately isolated centre for the zero-candidate profile: the
// zero-candidate diagnostic's funnel counts scan the WHOLE property table
// within the profile's radius (unlike per-profile metrics, which only touch
// this profile's profile_listing_state rows). Placing this profile far from
// any coordinate other specs seed keeps its "type_empty" diagnosis
// deterministic regardless of what else is in the table.
const ISOLATED_CENTER: [number, number] = [42.5001, -6.5001];
const NAME_PREFIX = "e2e-profiles-";
// A 1x1 transparent PNG as a data: URI — a real, self-contained image so the
// thumbnail <img> actually renders (never fetches an external host, this is a
// public repo and the browser is offline to real portals).
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

let pool: Pool;
let dbAvailable = false;

// Scenario 1: a rich profile with real matched candidates.
let richProfileId: number;
let flaggedPropertyId: number;
// Scenario 2: a materialized profile with a valid scope but zero matches.
let zeroProfileId: number;
// Scenario 3: a malformed-scope profile (issue #113).
let brokenProfileId: number;

async function insertProfile(name: string, scope: object, lastMaterialized: boolean): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, last_materialized_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, ${lastMaterialized ? "NOW()" : "NULL"}) RETURNING id`,
    [name, JSON.stringify(scope)],
  );
  return res.rows[0].id;
}

async function insertProperty(
  center: [number, number],
  propertyType: string,
  m2Built: number,
  address: string,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
    [center[0], center[1], propertyType, m2Built, address],
  );
  return res.rows[0].id;
}

async function insertListing(
  propertyId: number,
  source: string,
  price: number,
  photoUrls: string[] | null = null,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, photo_urls, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'active', 'sale', $4, $5, NOW(), NOW()) RETURNING id`,
    [propertyId, source, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price, photoUrls],
  );
  return res.rows[0].id;
}

async function markMatched(profileId: number, propertyId: number, score: number): Promise<void> {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, score_kind)
     VALUES ($1, $2, true, $3, 'cold_start')`,
    [profileId, propertyId, score],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[profiles.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const stamp = Date.now();

  // --- Scenario 1: a rich profile with real matched candidates ---------------
  richProfileId = await insertProfile(
    `${NAME_PREFIX}rich-${stamp}`,
    { geography: { type: "radius", center: MADRID_SOL, radius_km: 5 }, property_types: ["piso"], hard_exclusions: {} },
    true,
  );

  // Property A: the top-ranked candidate — carries the lead photo (so it is
  // the thumbnail the strip resolves) AND an occupancy AI assessment with a
  // warn-tone caveat (so the "N con alertas" flag chip renders).
  flaggedPropertyId = await insertProperty(MADRID_SOL, "piso", 72, `${NAME_PREFIX}Calle Mayor 1, Madrid`);
  await insertListing(flaggedPropertyId, "fotocasa", 198000, [PIXEL_PNG, PIXEL_PNG]);
  await markMatched(richProfileId, flaggedPropertyId, 0.95);
  await pool.query(
    `INSERT INTO ai_assessment (property_id, assessment_type, result, prompt_version, generated_at)
     VALUES ($1, 'occupancy', $2::jsonb, $3, NOW())`,
    [flaggedPropertyId, JSON.stringify({ caveats: ["tenanted"] }), `${NAME_PREFIX}v1`],
  );

  // Property B: a plain matched candidate that also carries recorded feedback
  // (an 'accept') — exercises the aggregate query's feedback_counts CTE
  // against real rows, the SQL path a mocked unit test would never run.
  const feedbackPropertyId = await insertProperty(MADRID_SOL, "piso", 88, `${NAME_PREFIX}Calle Alcalá 2, Madrid`);
  const feedbackListingId = await insertListing(feedbackPropertyId, "fotocasa", 250000);
  await markMatched(richProfileId, feedbackPropertyId, 0.6);
  await pool.query(
    `INSERT INTO feedback_event (profile_id, property_id, listing_id, feedback_type)
     VALUES ($1, $2, $3, 'accept')`,
    [richProfileId, feedbackPropertyId, feedbackListingId],
  );

  // Property C: a third plain matched candidate (so "3 candidatos" and a real
  // min–max price range render).
  const plainPropertyId = await insertProperty(MADRID_SOL, "piso", 65, `${NAME_PREFIX}Calle Gran Vía 3, Madrid`);
  await insertListing(plainPropertyId, "fotocasa", 310000);
  await markMatched(richProfileId, plainPropertyId, 0.4);

  // --- Scenario 2: materialized, valid scope, genuinely zero matches ---------
  // Isolated centre + a single nearby property of the WRONG type (a chalet
  // when the profile wants a piso) → the funnel's geography stage counts it
  // (active sale listing in radius) but the type stage drops it, yielding a
  // *specific* "type_empty" cause, not a bare "0".
  zeroProfileId = await insertProfile(
    `${NAME_PREFIX}zero-${stamp}`,
    {
      geography: { type: "radius", center: ISOLATED_CENTER, radius_km: 1 },
      property_types: ["piso"],
      hard_exclusions: {},
    },
    true,
  );
  const chaletId = await insertProperty(ISOLATED_CENTER, "chalet", 140, `${NAME_PREFIX}Chalet aislado, Bierzo`);
  await insertListing(chaletId, "fotocasa", 175000);
  // Deliberately NO profile_listing_state rows for zeroProfileId — it is
  // materialized (last_materialized_at set) but matched nothing.

  // --- Scenario 3: a malformed-scope profile (issue #113) --------------------
  // `scope = '{}'` is valid JSON but fails ScopeSchema (geography and
  // property_types are both required) — the exact reachable case #113
  // describes. It must render as a visibly-broken row, never vanish.
  const brokenRes = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
    [`${NAME_PREFIX}broken-${stamp}`],
  );
  brokenProfileId = brokenRes.rows[0].id;
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  // FK-safe order: dependents of property/profile first, then those, then the
  // profiles. Everything is prefix-scoped so no other spec's rows are touched.
  await pool.query("DELETE FROM feedback_event WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM ai_assessment WHERE property_id IN (SELECT id FROM property WHERE address LIKE $1)", [
    `${NAME_PREFIX}%`,
  ]);
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

// D-041: no error surface anywhere on the page.
async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos|hubo un problema/i),
  ).toHaveCount(0);
  await expect(page.locator('[data-testid="error-display"]')).toHaveCount(0);
}

test("a profile with real matched candidates renders its metrics line, thumbnails and overflow menu", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${richProfileId}"]`);
  await expect(row).toBeVisible();

  // Metrics line — real, per-profile aggregate content, not a skeleton.
  await expect(row.getByTestId("profile-metric-matched")).toContainText("3");
  await expect(row.getByTestId("profile-metric-price")).toBeVisible();
  await expect(row.getByTestId("profile-metric-model")).toBeVisible();
  // The occupancy warn-tone caveat surfaces as the AI-alert chip.
  await expect(row.getByTestId("profile-metric-flags")).toContainText("1");

  // Sneak-peek thumbnail strip: the lead photo of the top-ranked candidate
  // rendered as a real <img> (the data: URI actually loads).
  await expect(row.getByTestId("profile-thumbnails")).toBeVisible();
  await expect(row.getByTestId("profile-thumb-img").first()).toBeVisible();

  // Entering is the only primary-weight action.
  const enter = row.getByTestId("profile-enter-button");
  await expect(enter).toBeVisible();
  await expect(enter).toHaveAttribute("href", `/profiles/${richProfileId}`);

  // Everything else demotes to a kebab overflow: Editar / Clonar / Archivar.
  await row.getByRole("button", { name: /más acciones/i }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Editar" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Clonar" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archivar" })).toBeVisible();
});

test("a materialized profile with zero matches explains a specific cause, not a bare 0", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  const row = page.locator(`[data-testid="profile-row"][data-profile-id="${zeroProfileId}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("profile-metric-matched")).toContainText("0");

  // "¿Por qué 0?" expands the on-demand diagnostic.
  await row.getByTestId("profile-zero-why-link").click();

  const diagnostic = row.getByTestId("zero-diagnostic");
  await expect(diagnostic).toBeVisible();
  // A named cause: the isolated chalet is in the zone, but no piso is.
  await expect(diagnostic).toHaveAttribute("data-diagnosis-kind", "type_empty");
  await expect(diagnostic).toContainText(/del tipo que buscas/i);
  await expect(diagnostic).toContainText(/piso/i);
  // Not the old generic empty-state copy.
  await expect(diagnostic).not.toContainText(/prueba a ampliar los filtros/i);

  await assertNoErrorSurface(page);
});

test("a malformed-scope profile renders as a visibly broken row with Clonar disabled, never absent", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto("/profiles");
  await assertNoErrorSurface(page);

  // The row is present in the DOM (not silently dropped) and flagged invalid.
  const broken = page.locator(`[data-testid="profile-row-broken"][data-profile-id="${brokenProfileId}"]`);
  await expect(broken).toBeVisible();
  await expect(broken.getByTestId("profile-invalid-badge")).toContainText(/configuración inválida/i);

  // A broken profile has no sensible Entrar target — the primary action is
  // absent, and Clonar (no parseable scope to clone) is disabled in the menu.
  await expect(broken.getByTestId("profile-enter-button")).toHaveCount(0);
  await broken.getByRole("button", { name: /más acciones/i }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Clonar" })).toBeDisabled();
  // Editar / Archivar remain the only sensible actions and stay enabled.
  await expect(menu.getByRole("menuitem", { name: "Editar" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Archivar" })).toBeEnabled();
});

for (const path of ["/", "/inicio"]) {
  test(`${path} renders the merged Perfiles surface, not the retired placeholder`, async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(path);
    await assertNoErrorSurface(page);

    // The redesigned Perfiles surface, reached from the landing route.
    await expect(page.getByRole("heading", { name: /perfiles de búsqueda/i })).toBeVisible();
    await expect(
      page.locator(`[data-testid="profile-row"][data-profile-id="${richProfileId}"]`),
    ).toBeVisible();

    // The Phase-1 placeholder copy #195 retired must be gone.
    await expect(page.getByText(/se están construyendo en fases posteriores/i)).toHaveCount(0);
  });
}
