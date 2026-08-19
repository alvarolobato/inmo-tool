/**
 * E2E (issue #572): the `/profiles` card at phone width (390px class).
 *
 * The owner's own screenshot showed thumbnails holding a fixed 220px strip
 * while the text column collapsed to ~10px of usable width — "Piso, Chalet,
 * Ático · radio 3 km" wrapped across seven lines, the price range was
 * unreadable, and the Entrar button was clipped off-screen; the kebab menu
 * overlapped the title. `ProfileOverviewRow.tsx` now wraps the inner row
 * (`flexWrap`) and gives the text column a real flex-basis so the card
 * becomes photo-strip-on-top / text-below at phone width, with no explicit
 * breakpoint — see the component's own #572 comments for the mechanism.
 *
 * Device emulation gotcha (documented so the next spec doesn't repeat it):
 * under Playwright's `devices["iPhone 13"]` emulation, `window.innerWidth`
 * does NOT reflect the emulated 390px viewport here (it reported 653,
 * hiding every overflow on the first two probe runs) — always read
 * `document.documentElement.clientWidth` instead.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching profiles.spec.ts / profiles-kebab-menu.spec.ts.
 */
import { test, expect, devices, type Page } from "@playwright/test";
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

// This project's single Playwright project is chromium (playwright.config.ts);
// destructuring out `defaultBrowserType` follows the precedent in
// card-detail-ux.spec.ts's "#167: touch/coarse-pointer behaviour" describe —
// Playwright refuses `defaultBrowserType` inside `test.use` because switching
// browser engines needs a new worker, not just new context options. Chromium's
// mobile emulation (viewport/isMobile/hasTouch) is what actually reproduces
// the reported layout, independent of engine choice.
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
test.use({ ...iPhone13 });

const MADRID_SOL: [number, number] = [40.4168, -3.7038];
const NAME_PREFIX = "e2e-mobile-profiles-";
// A 1x1 transparent PNG as a data: URI — a real, self-contained image so the
// thumbnail <img> actually renders (never fetches an external host).
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

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
      "[mobile-profiles.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const stamp = Date.now();

  // The owner's screenshot: three property types + a radius, so the
  // metadata line is exactly the string that wrapped across seven lines
  // ("Piso, Chalet, Ático · radio 3 km").
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, last_materialized_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, NOW()) RETURNING id`,
    [
      `${NAME_PREFIX}montequinto-${stamp}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 3 },
        property_types: ["piso", "chalet", "atico"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = res.rows[0].id;

  // Four matched candidates: enough thumbnails to fill the fixed 220px strip
  // (Thumbnails renders 4 slots) and a real min/max/median price range.
  const prices = [145000, 198000, 260000, 340000];
  for (const price of prices) {
    const propRes = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address, created_at)
       VALUES ($1, $2, 'piso', 70, $3, NOW()) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}Calle Falsa, Madrid`],
    );
    const propertyId = propRes.rows[0].id;
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, photo_urls, first_seen_at, last_seen_at)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4, NOW(), NOW())`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price, [PIXEL_PNG]],
    );
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, score_kind)
       VALUES ($1, $2, true, 0.5, 'cold_start')`,
      [profileId, propertyId],
    );
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
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

async function clientWidth(page: Page): Promise<number> {
  // NEVER window.innerWidth here — under this project's chromium mobile
  // emulation it does not track the emulated viewport (see file header).
  return page.evaluate(() => document.documentElement.clientWidth);
}

function row(page: Page) {
  return page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
}

test("no horizontal overflow in the profile card list", async ({ page }) => {
  skipIfNoDb(test);
  await page.goto("/profiles");
  await expect(row(page)).toBeVisible();

  const width = await clientWidth(page);
  // Scoped to <main> (the card list this issue owns), not the whole
  // document: TopBar.tsx's nav (Inmo-Tool/Perfiles/Captura/.../Admin/AL
  // avatar) already overflows the 390px viewport today, independently of
  // anything here — that's #571's in-flight mobile-shell fix on its own
  // branch, explicitly out of scope for this PR (zero file overlap with
  // TopBar.tsx). A whole-document scrollWidth check would fail on #571's
  // pre-existing bug regardless of whether the card itself is fixed.
  const offenders = await page.evaluate((clientW) => {
    const main = document.querySelector("main");
    if (!main) return [];
    const bad: { tag: string; testid: string | null; right: number }[] = [];
    main.querySelectorAll("*").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > clientW + 1) {
        bad.push({ tag: el.tagName, testid: el.getAttribute("data-testid"), right: rect.right });
      }
    });
    return bad;
  }, width);
  expect(offenders).toEqual([]);
});

test("Entrar is inside the viewport", async ({ page }) => {
  skipIfNoDb(test);
  await page.goto("/profiles");
  const width = await clientWidth(page);

  const enter = row(page).getByTestId("profile-enter-button");
  await expect(enter).toBeVisible();
  const box = await enter.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // Fully inside the viewport — this is exactly the bug: the button's
  // right edge ran off the 390px-class screen entirely.
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  // Tap target >= 44px (he is using a thumb).
  expect(box.height).toBeGreaterThanOrEqual(44);
});

test("kebab does not intersect the title", async ({ page }) => {
  skipIfNoDb(test);
  await page.goto("/profiles");

  const kebab = row(page).getByRole("button", { name: "Más acciones para este perfil" });
  await expect(kebab).toBeVisible();
  const kebabBox = await kebab.boundingBox();
  expect(kebabBox).not.toBeNull();

  // No `toBeVisible()` gate on the title on purpose: on the unfixed layout
  // the text column can collapse toward 0 width (Thumbnails' fixed 220px
  // leaves almost nothing for it), which Playwright's visibility heuristic
  // treats as "not visible" and would THROW here — failing the test on an
  // opaque precondition instead of the geometric claim its name advertises
  // (a prior version of this test did exactly that). `.boundingBox()`
  // returns geometry regardless of the visibility heuristic.
  const title = row(page).getByTestId("profile-row-link").locator("p").first();
  const titleBox = await title.boundingBox();
  expect(titleBox, "title element has a box at all (not detached)").not.toBeNull();
  if (!kebabBox || !titleBox) return;

  // This is the assertion that actually fails on the unfixed layout: a
  // collapsed-to-~0-width column is itself the root cause the owner
  // reported (screenshots showed the title's wrapped GLYPHS visually
  // running under the kebab even though a 0-width box technically doesn't
  // rectangle-intersect anything — CSS paints overflowing text past its
  // layout box by default, which a boundingBox()-vs-boundingBox() check
  // structurally can't see). Asserting real width is what makes this test
  // fail for the true reason pre-fix, not an incidental one.
  expect(titleBox.width, "title column has room to render (not collapsed by the fixed-width thumbnail strip)").toBeGreaterThan(100);

  // Now the literal rectangle check, kept as a second, independent
  // guarantee once the column has real width to lay out in: two
  // axis-aligned boxes intersect only if they overlap on BOTH axes.
  const overlapsX = kebabBox.x < titleBox.x + titleBox.width && titleBox.x < kebabBox.x + kebabBox.width;
  const overlapsY = kebabBox.y < titleBox.y + titleBox.height && titleBox.y < kebabBox.y + kebabBox.height;
  expect(overlapsX && overlapsY).toBe(false);
});

test("profile card reflows to stacked layout at phone width", async ({ page }) => {
  skipIfNoDb(test);
  await page.goto("/profiles");
  const width = await clientWidth(page);
  expect(width).toBeLessThan(768); // sanity: this really is the mobile viewport

  // No `toBeVisible()` gate on either box: on the unfixed layout the text
  // column can collapse toward 0 width, which Playwright's visibility
  // heuristic treats as "not visible" — that would throw here on an
  // opaque precondition rather than the reflow claim this test names.
  // `.boundingBox()` returns geometry regardless.
  const thumbs = row(page).getByTestId("profile-thumbnails");
  const link = row(page).getByTestId("profile-row-link");
  const thumbsBox = await thumbs.boundingBox();
  const linkBox = await link.boundingBox();
  expect(thumbsBox, "thumbnails have a box").not.toBeNull();
  expect(linkBox, "text column has a box").not.toBeNull();
  if (!thumbsBox || !linkBox) return;

  // This is the assertion that actually fails on the unfixed layout —
  // the text column collapses toward 0 width there (no flex-basis, and
  // Thumbnails' fixed 220px + Entrar leave it almost nothing), so this
  // is what makes the test fail for the real reported cause rather than
  // an incidental one. >= 240px matches the flex-basis the fix gives it.
  expect(linkBox.width, "text column has room to render (not squeezed to ~10px by the fixed-width thumbnail strip)").toBeGreaterThanOrEqual(240);

  // Photo strip on top, text column below it — not side by side. Only
  // meaningful once both boxes have real geometry (checked above).
  expect(thumbsBox.y + thumbsBox.height).toBeLessThanOrEqual(linkBox.y + 1);

  // The metadata line ("Piso, Chalet, Ático · radio 3 km") reads in at most
  // two lines, not the reported seven. Its own paragraph plus a little
  // slack for line-height comfortably bounds two 12px-font lines.
  const metaLine = link.locator("p").nth(1);
  const metaBox = await metaLine.boundingBox();
  expect(metaBox).not.toBeNull();
  if (!metaBox) return;
  expect(metaBox.height).toBeLessThanOrEqual(36);
});
