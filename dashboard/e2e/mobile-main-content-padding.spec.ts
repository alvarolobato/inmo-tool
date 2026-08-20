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

async function mainContentPadding(
  page: Page,
): Promise<{ top: string; right: string; bottom: string; left: string }> {
  return page.evaluate(() => {
    const main = document.querySelector("main.main-content");
    if (!main) throw new Error("main.main-content not found");
    const cs = getComputedStyle(main);
    return { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
  });
}

/** Every element on the page must fit inside the viewport horizontally. */
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
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
const MAIN_ROUTES = ["/", "/profiles", "/captura", "/etl", "/admin", "/glossary", "/inicio", "/conversations"];

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
      await page.goto(route);
      await assertNoHorizontalOverflow(page);
    });
  }
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
});
