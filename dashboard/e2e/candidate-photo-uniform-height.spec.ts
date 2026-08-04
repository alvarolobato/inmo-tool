/**
 * E2E: candidate list photo box is a FIXED 4:3 box, never image-driven.
 *
 * Bug: in the opportunities/candidate list a portrait (tall) listing photo
 * made its card taller than a landscape (wide) one — the row height tracked
 * the photo's aspect ratio instead of staying uniform. Root cause was in
 * `CandidatePhotoTicker`: the lead `<img>` sat in flow with `height: 100%`
 * inside a wrapper whose only height came from `aspect-ratio: 4/3`. A
 * percentage height against that (indefinite) container collapses to `auto`,
 * so the image rendered at its intrinsic size and stretched the box, and
 * `object-fit: cover` never engaged. The fix takes the image out of flow
 * (`position: absolute; inset: 0`) so the box height is a pure function of its
 * width (4:3), identical for every card.
 *
 * This is the D-041 regression net for that surface: it seeds two candidates,
 * one with a PORTRAIT photo and one with a LANDSCAPE photo, and asserts their
 * rendered photo boxes are the same height and are ~4:3 — the exact invariant
 * the bug broke (portrait box was ~4x taller than landscape). Asserting on the
 * photo box, not the card, is deliberate: two cards in the same CSS-grid row
 * are always stretched to equal height regardless of the bug, so the card
 * height hides it; the photo box is where the aspect distortion actually shows.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the schema applied. Skips
 * cleanly if no DB is reachable, matching candidates.spec.ts.
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
const NAME_PREFIX = "e2e-photobox-";

// Deterministic, synthetic SVG data URIs (never real scraped photos — public
// repo). The intrinsic width/height attributes are what would drive the box
// under the bug: 200x600 is a strong portrait, 600x200 a strong landscape.
const PORTRAIT_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='600'><rect width='200' height='600' fill='#cc3333'/></svg>",
  );
const LANDSCAPE_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='200'><rect width='600' height='200' fill='#3333cc'/></svg>",
  );

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let portraitPropertyId: number;
let landscapePropertyId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[candidate-photo-uniform-height.spec] no reachable Postgres - skipping e2e suite. " +
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

  async function insertCandidate(address: string, m2Built: number, photo: string): Promise<number> {
    const property = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], m2Built, address],
    );
    const propertyId = property.rows[0].id;
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, photo_urls)
       VALUES ($1, 'fotocasa', $2, 'active', $3, NOW(), $4)`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, 300000, [photo]],
    );
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
    return propertyId;
  }

  portraitPropertyId = await insertCandidate(`${NAME_PREFIX}Retrato, Madrid`, 60, PORTRAIT_IMG);
  landscapePropertyId = await insertCandidate(`${NAME_PREFIX}Apaisado, Madrid`, 61, LANDSCAPE_IMG);
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
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
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

async function photoBox(page: Page, propertyId: number) {
  const box = await page
    .locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"] [data-testid="candidate-photo"]`)
    .boundingBox();
  if (!box) throw new Error(`no photo box for property ${propertyId}`);
  return box;
}

test("portrait and landscape candidate photos render in an identical fixed 4:3 box", async ({ page }) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const cards = page.locator('[data-testid="candidate-card"]');
  await expect(cards).toHaveCount(2);

  const portrait = await photoBox(page, portraitPropertyId);
  const landscape = await photoBox(page, landscapePropertyId);

  // The bug made the portrait box ~4x the landscape box's height. The fix
  // pins both to the same width-derived height.
  expect(Math.abs(portrait.height - landscape.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(portrait.width - landscape.width)).toBeLessThanOrEqual(1);

  // Each box is ~4:3 (1.333), NOT the image's own aspect (portrait would be
  // ~0.33, landscape ~3.0 if the image drove the box).
  for (const box of [portrait, landscape]) {
    const ratio = box.width / box.height;
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(1.45);
  }
});
