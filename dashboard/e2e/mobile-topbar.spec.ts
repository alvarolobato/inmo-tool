/**
 * E2E: mobile shell — hamburger nav, dot-only sync indicator, logo-only
 * wordmark (issue #571).
 *
 * Measured with Playwright (iPhone 13 emulation, authenticated, pre-fix
 * `main`): every route overflowed the 390px layout viewport by the same
 * +264px (`document.documentElement.scrollWidth` 654 vs `clientWidth` 390),
 * on `/profiles`, `/inicio`, `/captura`, `/etl` and even a bare 404 page with
 * no content — all traced to one non-wrapping header row
 * (`div.flex.items-center.gap-3.px-5`, right edge at 654). Fixing the header
 * alone removes the overflow everywhere, which is what the "does not
 * overflow" tests below assert across several routes rather than just one.
 *
 * MEASUREMENT TRAP (do not undo this): assert against
 * `document.documentElement.clientWidth`, never `window.innerWidth`. Under
 * Chromium device emulation `innerWidth` reports the layout viewport width
 * used for *zoom* (653 on a 390px device here) and hides every overflow —
 * an assertion against it would pass whether or not the header actually
 * overflows. `clientWidth` is the real rendered viewport.
 *
 * Same real-server/real-Postgres/admin-cookie pattern as
 * e2e/freshness-indicator.spec.ts and e2e/card-detail-ux.spec.ts (whose
 * `#167` describe block is the precedent for the iPhone 13 destructure
 * below — `defaultBrowserType` is dropped because this project's single
 * Playwright project is chromium; switching engines needs a new worker).
 * Skips cleanly when Postgres is unreachable or ADMIN_API_KEY is unset.
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

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[mobile-topbar.spec] Postgres unreachable — skipping");
  }
});

test.afterAll(async () => {
  await pool?.end();
});

// Routes the owner's measurement covered: the redesigned Perfiles surface
// (twice — `/profiles` and its `/inicio` alias), Captura, the admin ETL
// monitor, and a route that renders no page content at all (404) — proving
// the overflow was the shell, not any page's own content.
const ROUTES_MEASURED_OVERFLOWING = ["/profiles", "/inicio", "/captura", "/etl", "/route-that-does-not-exist-571"];

/** Real rendered viewport (NOT window.innerWidth — see file header). */
async function documentOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function headerOverflowPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const header = document.querySelector("header");
    if (!header) return 0;
    return header.scrollWidth - header.clientWidth;
  });
}

test.describe("mobile shell (iPhone 13 emulation, 390px)", () => {
  // Precedent: e2e/card-detail-ux.spec.ts `#167` describe block. Dropping
  // `defaultBrowserType` (webkit) keeps this on the project's chromium engine
  // while still getting the iPhone 13 viewport/isMobile/hasTouch profile.
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!dbAvailable, "Postgres unavailable");
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
  });

  test("header does not overflow the viewport, on every measured route", async ({ page }) => {
    for (const route of ROUTES_MEASURED_OVERFLOWING) {
      await page.goto(route);
      // document.documentElement.clientWidth — never window.innerWidth, which
      // reports ~653 under emulation regardless of the real 390px viewport.
      expect(
        await page.evaluate(() => document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(400);
      expect(await headerOverflowPx(page), `header overflow on ${route}`).toBeLessThanOrEqual(0);
      expect(await documentOverflowPx(page), `document overflow on ${route}`).toBeLessThanOrEqual(0);
    }
  });

  test("mobile header collapses to hamburger with dot-only sync", async ({ page }) => {
    await page.goto("/profiles");

    // Wordmark text is hidden — logo (svg) only.
    await expect(page.getByText("Inmo-Tool", { exact: true })).toBeHidden();

    // Freshness dot renders; its text does not. The dot itself is the
    // first child span inside the live-status wrapper — assert on the
    // wrapper's own child count rather than a color, since the dot's exact
    // colour depends on unrelated freshness state.
    const pill = page.getByTestId("freshness-indicator");
    await expect(pill).toBeHidden();
    const dot = page.locator('header span[style*="border-radius: 50%"]').first();
    await expect(dot).toBeVisible();

    // Hamburger is present with the required a11y attributes and hit area.
    const hamburger = page.getByRole("button", { name: "Menú" });
    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    const box = await hamburger.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);

    // Desktop-only chrome is gone: inline nav, Admin link, avatar.
    await expect(page.getByRole("link", { name: "Perfiles", exact: true })).toBeHidden();
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toBeHidden();
    await expect(page.getByLabel("Avatar de usuario")).toBeHidden();

    await expect(page.getByTestId("error-display")).toHaveCount(0);
  });

  test("hamburger menu navigates, closes on link tap, D-045 keeps Captura reachable", async ({
    page,
  }) => {
    await page.goto("/profiles");
    const hamburger = page.getByRole("button", { name: "Menú" });
    await hamburger.click();
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");

    const panel = page.locator("#mobile-nav-panel");
    await expect(panel).toBeVisible();

    // D-045: Captura must be reachable from the mobile menu, next to Perfiles.
    const rows = ["Perfiles", "Captura", "Conversaciones", "Admin"] as const;
    for (const label of rows) {
      const row = panel.getByRole("link", { name: label, exact: true });
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      expect(box?.height, `${label} row hit area`).toBeGreaterThanOrEqual(44);
    }

    await panel.getByRole("link", { name: "Captura", exact: true }).click();
    await expect(page).toHaveURL(/\/captura$/);
    // Menu closed itself on navigation.
    await expect(page.locator("#mobile-nav-panel")).toHaveCount(0);
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });

  test("menu closes on outside tap and on Escape", async ({ page }) => {
    await page.goto("/profiles");
    const hamburger = page.getByRole("button", { name: "Menú" });

    await hamburger.click();
    await expect(page.locator("#mobile-nav-panel")).toBeVisible();
    // Tap below the panel, outside both the panel and the button.
    await page.mouse.click(195, 700);
    await expect(page.locator("#mobile-nav-panel")).toHaveCount(0);

    await hamburger.click();
    await expect(page.locator("#mobile-nav-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#mobile-nav-panel")).toHaveCount(0);
  });
});

test.describe("desktop (>=768px) — unchanged", () => {
  // No device override: the project's own Desktop Chrome viewport
  // (playwright.config.ts) applies.
  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!dbAvailable, "Postgres unavailable");
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
  });

  test("wordmark, inline nav, full sync text, admin link and avatar all show; hamburger absent", async ({
    page,
  }) => {
    await page.goto("/profiles");

    await expect(page.getByText("Inmo-Tool", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Perfiles", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Captura", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Conversaciones", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
    await expect(page.getByLabel("Avatar de usuario")).toBeVisible();
    await expect(page.getByTestId("freshness-indicator")).toBeVisible();

    await expect(page.getByRole("button", { name: "Menú" })).toBeHidden();
    await expect(page.locator("#mobile-nav-panel")).toHaveCount(0);

    expect(await headerOverflowPx(page)).toBeLessThanOrEqual(0);
  });
});
