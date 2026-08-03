/**
 * E2E: candidate card + property detail UX overhaul (#152).
 *
 * Covers what unit tests structurally can't: that the hover-revealed action
 * bar is actually reachable and doesn't navigate, that the cold-start notice
 * appears once for the page rather than once per card, that lightbox
 * prev/next walks the real photo union, and that detail-page prev/next
 * follows the same ranking the list is sorted by.
 *
 * Same real-server/real-Postgres pattern as e2e/candidates.spec.ts; skips
 * cleanly when no Postgres is reachable.
 *
 * Every UI page in this app is gated on the `ps_admin` cookie (middleware.ts
 * gates by default — `/profiles/*` included), so the suite seeds that cookie
 * the way `/admin/login` does, following e2e/connectors.spec.ts. Without it
 * every navigation 307s to the login page and the assertions below would fail
 * on a page that is actually healthy.
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
const NAME_PREFIX = "e2e-card-ux-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
/** Ranked best → worst, so prev/next has a known expected sequence. */
let topId: number;
let middleId: number;
let bottomId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[card-detail-ux.spec] no reachable Postgres - skipping e2e suite. " +
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

  async function insertCandidate(
    address: string,
    score: number,
    rankExplanation: string,
    photoUrls: string[],
  ): Promise<number> {
    const property = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, rooms, bathrooms, floor, address)
       VALUES ($1, $2, 'piso', 82, 3, 2, '4', $3) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], address],
    );
    const propertyId = property.rows[0].id;
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, photo_urls)
       VALUES ($1, 'fotocasa', $2, 'active', 289000, NOW(), $3)`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, photoUrls],
    );
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, rank_explanation)
       VALUES ($1, $2, true, $3, $4)`,
      [profileId, propertyId, score, rankExplanation],
    );
    return propertyId;
  }

  // Three photos on the top candidate so lightbox prev/next has somewhere to
  // go; distinct scores so the ranking (and therefore prev/next) is
  // deterministic rather than falling back to the id tiebreak.
  topId = await insertCandidate(`${NAME_PREFIX}Calle Trafalgar, Madrid`, 0.91, "Rentabilidad bruta estimada del 6,2%, por encima de la media de la zona.", [
    `https://example.com/${NAME_PREFIX}1.jpg`,
    `https://example.com/${NAME_PREFIX}2.jpg`,
    `https://example.com/${NAME_PREFIX}3.jpg`,
  ]);
  middleId = await insertCandidate(`${NAME_PREFIX}Calle Goya, Madrid`, 0.55, "Precio en línea con tu banda objetivo.", []);
  bottomId = await insertCandidate(`${NAME_PREFIX}Calle Alcalá, Madrid`, 0.21, "Superficie por debajo de lo que sueles aceptar.", []);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  // Feedback first: the "accept" click below writes a feedback_event, and its
  // FK to search_profile blocks the profile delete otherwise.
  await pool.query(
    "DELETE FROM feedback_event WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
}

function card(page: Page, propertyId: number) {
  return page.locator(`[data-testid="candidate-card"][data-property-id="${propertyId}"]`);
}

test("cards render photo-first with price, facts and no per-card cold-start noise", async ({ page }) => {

  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const top = card(page, topId);
  await expect(top).toBeVisible();
  await expect(top.getByTestId("candidate-photo")).toBeVisible();
  await expect(top.getByTestId("candidate-price")).toContainText("289.000");
  // Every fact the issue asks to keep visible, on one line.
  const facts = top.getByTestId("candidate-facts");
  await expect(facts).toContainText("82 m²");
  await expect(facts).toContainText("3 hab.");
  await expect(facts).toContainText("2 baños");
  await expect(facts).toContainText("Planta 4");
  // These candidates have real (non-cold-start) explanations, so the footer
  // must not appear — the cold-start copy belongs to the profile, not a card.
  await expect(page.getByTestId("cold-start-footer")).toHaveCount(0);
});

test("the action bar is reachable on hover and acting on it does not navigate", async ({ page }) => {

  await page.goto(`/profiles/${profileId}`);
  const target = card(page, middleId);
  await expect(target).toBeVisible();

  const actions = target.getByTestId("candidate-card-actions");
  // Baseline: hidden (opacity 0) until the card is hovered.
  await expect(actions).toHaveCSS("opacity", "0");

  await target.hover();
  await expect(actions).toHaveCSS("opacity", "1");

  await actions.getByTestId("feedback-accept").click();
  await expect(actions.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");
  // The whole point of keeping the controls a sibling of the <Link>.
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
  await assertNoErrorSurface(page);
});

test("lightbox walks the photo union with buttons and arrow keys", async ({ page }) => {

  await page.goto(`/profiles/${profileId}/properties/${topId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await page.getByTestId("photo-gallery-thumb").first().click();
  const counter = page.getByTestId("photo-gallery-counter");
  await expect(counter).toHaveText("1 / 3");

  await page.getByTestId("photo-gallery-next").click();
  await expect(counter).toHaveText("2 / 3");

  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("3 / 3");

  await page.keyboard.press("ArrowLeft");
  await expect(counter).toHaveText("2 / 3");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("photo-gallery-lightbox")).toHaveCount(0);
});

test("detail page walks the ranking with prev/next, disabled at the ends", async ({ page }) => {

  // Middle of the ranking: both directions available.
  await page.goto(`/profiles/${profileId}/properties/${middleId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${bottomId}`,
  );
  await page.getByTestId("candidate-prev").click();
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${topId}$`));

  // Top of the ranking: "previous" is present but inert, so the controls
  // don't shift position as you move through the queue.
  await expect(page.getByTestId("candidate-prev")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${middleId}`,
  );
  await assertNoErrorSurface(page);

  // Bottom of the ranking: the mirror case.
  await page.goto(`/profiles/${profileId}/properties/${bottomId}`);
  await expect(page.getByTestId("candidate-next")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("candidate-prev")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${middleId}`,
  );
});
