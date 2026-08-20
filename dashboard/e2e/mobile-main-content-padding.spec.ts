/**
 * E2E (issue #596): side margins on phone, shared `.main-content` rule.
 *
 * The owner reported "sigue habiendo demasiados márgenes a los lados en
 * todas las pantallas" (still too much side margin on every screen) more
 * than once — #572 and #576 each trimmed padding on ONE page/card and
 * explicitly left `.main-content` (the global app shell every page renders
 * inside) alone, because touching it affects far more than one page. This
 * is that follow-up, applied once in the shared rule instead of per page.
 *
 * The fix is horizontal-only (`--pad-x`, phone-only, globals.css): below
 * 768px `.main-content`'s left/right padding shrinks while top/bottom stay
 * on the untouched `--pad` token, preserving vertical rhythm and the sticky
 * triage-bar offset math elsewhere in this file that reads `--pad` for its
 * own cancellation trick.
 *
 * This spec pins the padding VALUES (a regression net going forward — the
 * PR body carries the actual before/after content-width measurement) and
 * sweeps the app's main routes for horizontal overflow at phone width,
 * since a smaller container edge is exactly the kind of change that reveals
 * a child that only fit by luck.
 *
 * Requires ADMIN_API_KEY (no Postgres dependency — this spec touches no
 * data, only rendered/computed CSS on pages that render fine with none).
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function clientWidth(page: Page): Promise<number> {
  // NEVER window.innerWidth under mobile emulation (see mobile-profiles.spec.ts's
  // header for the measured gotcha this project standardized around).
  return page.evaluate(() => document.documentElement.clientWidth);
}

async function elementPadding(
  page: Page,
  selector: string,
): Promise<{ top: string; right: string; bottom: string; left: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} not found`);
    const cs = getComputedStyle(el);
    return { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
  }, selector);
}

async function mainContentPadding(
  page: Page,
): Promise<{ top: string; right: string; bottom: string; left: string }> {
  return elementPadding(page, "main.main-content");
}

/**
 * Every element on the page must fit inside the viewport horizontally.
 *
 * #599 review (S2): the first version of this helper measured right after
 * `page.goto` with no settle, which inspected client-rendered pages BEFORE
 * their content existed — a padding *reduction* structurally cannot
 * introduce overflow, so those assertions were green both before and after
 * the fix (decorative). `waitUntil: "networkidle"` + a fixed settle makes
 * this measure the real, fully-rendered DOM.
 */
async function assertNoHorizontalOverflow(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const width = await clientWidth(page);
  const offenders = await page.evaluate((clientW) => {
    const bad: { tag: string; testid: string | null; right: number }[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > clientW + 1) {
        bad.push({ tag: el.tagName, testid: el.getAttribute("data-testid"), right: rect.right });
      }
    });
    return bad;
  }, width);
  expect(offenders).toEqual([]);
}

// The app's main navigable routes (issue #596: "en todas las pantallas" —
// this must not be a captura-only fix). Each renders 200 with no seed data
// (verified against a live dev server before writing this list).
//
// `/etl` is deliberately excluded here (#599 review S2): once measured with
// a real settle (see `assertNoHorizontalOverflow`'s header) it overflows
// with an 812px-wide `<table>` inside a scroll container at 390px — a
// PRE-EXISTING bug (reproduces identically on unmodified `main`, and a
// padding *reduction* cannot have introduced it), not something this PR's
// change touches. Filed as issue #606, along with the same finding on
// `/etl/captura` and `/admin/clasificacion`, rather than silently absorbed
// into this net.
const MAIN_ROUTES = ["/", "/profiles", "/captura", "/admin", "/glossary", "/inicio", "/conversations"];

test.describe("phone width (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("main-content horizontal padding shrinks below the vertical value, vertical rhythm untouched", async ({
    page,
  }) => {
    await page.goto("/profiles");
    const width = await clientWidth(page);
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);

    const padding = await mainContentPadding(page);
    // Comfort density is the default (no data-density cookie/attribute set
    // in this spec) — 12px horizontal vs the unchanged 20px vertical.
    expect(padding.left, "left padding shrinks on phone").toBe("12px");
    expect(padding.right, "right padding shrinks on phone").toBe("12px");
    expect(padding.top, "top padding is untouched (vertical rhythm)").toBe("20px");
    expect(padding.bottom, "bottom padding is untouched (vertical rhythm)").toBe("20px");
  });

  for (const route of MAIN_ROUTES) {
    test(`no horizontal overflow on ${route}`, async ({ page }) => {
      await assertNoHorizontalOverflow(page, route);
    });
  }

  // #599 review (S1): `.main-content` was only the smallest of three
  // horizontal-padding layers on the pages the owner complained about.
  // These two pin the other two shared layers this PR's follow-up fixes:
  // `AdminChrome.tsx`'s content div (every `/admin/*` and `/etl/*` page)
  // and `.route-shell` (the repeated per-route `<main style={{padding:
  // 24}}>` shape, 8 call sites across 6 files).
  test("AdminChrome content div horizontal padding shrinks on phone (every /admin/* and /etl/* page)", async ({
    page,
  }) => {
    await page.goto("/etl/connectors");
    const padding = await elementPadding(page, ".admin-chrome-content");
    expect(padding.left, "left padding shrinks on phone").toBe("12px");
    expect(padding.right, "right padding shrinks on phone").toBe("12px");
    expect(padding.top, "top padding is untouched (vertical rhythm)").toBe("20px");
    expect(padding.bottom, "bottom padding is untouched (vertical rhythm)").toBe("20px");
  });

  test("route-shell horizontal padding shrinks on phone, desktop's 24px vertical stays", async ({ page }) => {
    await page.goto("/captura");
    const padding = await elementPadding(page, ".route-shell");
    expect(padding.left, "left padding shrinks on phone").toBe("12px");
    expect(padding.right, "right padding shrinks on phone").toBe("12px");
    expect(padding.top, "top padding is untouched (vertical rhythm)").toBe("24px");
    expect(padding.bottom, "bottom padding is untouched (vertical rhythm)").toBe("24px");
  });
});

test.describe("desktop (default project)", () => {
  test("main-content padding is untouched at desktop width (no divergence introduced)", async ({ page }) => {
    await page.goto("/profiles");
    const width = await clientWidth(page);
    expect(width, "sanity: this really is desktop").toBeGreaterThanOrEqual(768);

    const padding = await mainContentPadding(page);
    expect(padding.left).toBe("20px");
    expect(padding.right).toBe("20px");
    expect(padding.top).toBe("20px");
    expect(padding.bottom).toBe("20px");
  });

  test("AdminChrome content div and route-shell padding are untouched at desktop width", async ({ page }) => {
    await page.goto("/etl/connectors");
    const adminPadding = await elementPadding(page, ".admin-chrome-content");
    expect(adminPadding.left).toBe("20px");
    expect(adminPadding.right).toBe("20px");

    await page.goto("/captura");
    const shellPadding = await elementPadding(page, ".route-shell");
    expect(shellPadding.left).toBe("24px");
    expect(shellPadding.right).toBe("24px");
  });
});
