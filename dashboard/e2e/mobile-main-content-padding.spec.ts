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

/**
 * Navigate and wait for the page to actually be rendered — the ONE place
 * every test/helper in this file must route through before touching the
 * DOM (#599 review, rounds 2 AND 3).
 *
 * History: round 2 hardened two new tests (AdminChrome/route-shell) after
 * CI failed on them with a bare "`.admin-chrome-content` not found" —
 * `page.goto()` with no wait at all, immediately followed by a
 * `page.evaluate` reading computed style. That fix was applied PER CALL
 * SITE. Round 3's CI run then failed on the file's two ORIGINAL (round-1,
 * untouched) tests with the identical shape, just a different selector
 * (`main.main-content` on `/profiles` instead of `.admin-chrome-content`
 * on `/etl/connectors`) — the exact same race, left in place two tests
 * over. Per-call-site hardening doesn't scale: every test in a file like
 * this needs the fix, and the only way to guarantee that is to make the
 * fix impossible to skip — one navigation helper every test calls.
 *
 * Two layers, because `waitUntil: "networkidle"` alone is not enough:
 *   1. `networkidle` — the network side of a cold `next dev` compile (a
 *      fresh schema-only DB + a route never hit before in that server's
 *      process lifetime, exactly CI's shape) settles.
 *   2. An explicit `toBeVisible()` wait on a marker element — Playwright's
 *      auto-retrying assertion, not a fixed sleep — covers the remaining
 *      gap `networkidle` doesn't: CLIENT-SIDE React hydration/mount can
 *      still be in flight after the network goes idle. `testId`, when
 *      given, targets a page-specific marker (tighter, and names exactly
 *      which page failed to render if it times out); omitted, it falls
 *      back to `main.main-content` — the root layout's own wrapper, safe
 *      for any route since it isn't gated by a page-specific data fetch.
 *
 * A failure here reads "the app shell actually rendered" (or the given
 * page's own testid) — naming the real problem — instead of a bare
 * "`<selector>` not found" three steps removed from the cause, which is
 * genuinely ambiguous between "page never rendered" and "selector is
 * wrong": confirmed for this file that it is always the former (`app/
 * layout.tsx` still declares `<main className="main-content">` unchanged,
 * and `.route-shell`/`.admin-chrome-content` are unchanged since round 2)
 * — but the next failure in a DIFFERENT file won't get that manual check
 * unless the assertion itself already distinguishes the two, which this
 * one now does structurally: if the marker element is genuinely absent
 * (wrong selector), `toBeVisible()` fails here with a name; if it's just
 * not rendered YET, this wait is exactly what fixes that.
 */
async function gotoAndSettle(page: Page, path: string, testId?: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
  const marker = testId ? page.getByTestId(testId) : page.locator("main.main-content");
  await expect(marker, `the app shell actually rendered at ${path}`).toBeVisible();
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
 * the fix (decorative). `gotoAndSettle` + a fixed extra 2s settle makes
 * this measure the real, fully-rendered DOM (the extra settle stays on top
 * of `gotoAndSettle`'s own wait because this helper reads the WHOLE page,
 * not one marker element — some routes' below-the-fold content finishes
 * mounting slightly after the app shell itself does).
 */
async function assertNoHorizontalOverflow(page: Page, route: string): Promise<void> {
  await gotoAndSettle(page, route);
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
// `/etl` and `/etl/captura` are deliberately excluded here (#599 review S2,
// then #606): once measured with a real settle (see
// `assertNoHorizontalOverflow`'s header) `/etl` overflows with an
// 812px-wide `<table>` inside a scroll container at 390px — a PRE-EXISTING
// bug (reproduces identically on unmodified `main`), not something this
// PR's change touches. Both routes were about to become moot rather than
// worth fixing: #642 P1 merges `/etl/connectors` and `/etl/captura` into
// `/admin/fuentes`, and `/etl` itself (Monitor) is slated for deletion in
// #642 P2 — fixing a table on a page mid-deletion elsewhere would only
// create a merge conflict with that work. `/admin/clasificacion` (#606's
// third target, and the one NOT going away) got its own fix — its overflow
// was individual `<a>`/`<span>` property-reference pills with no width cap,
// not a table — and its own seeded regression test:
// `mobile-clasificacion.spec.ts`.
const MAIN_ROUTES = ["/", "/profiles", "/captura", "/admin", "/glossary", "/inicio", "/conversations"];

test.describe("phone width (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("main-content horizontal padding shrinks below the vertical value, vertical rhythm untouched", async ({
    page,
  }) => {
    await gotoAndSettle(page, "/profiles");
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
  // 24}}>` shape, 8 call sites across 6 files). Both route through
  // `gotoAndSettle` (its own header has the full history of why).
  test("AdminChrome content div horizontal padding shrinks on phone (every /admin/* and /etl/* page)", async ({
    page,
  }) => {
    await gotoAndSettle(page, "/etl/connectors", "connectors-page");
    const padding = await elementPadding(page, ".admin-chrome-content");
    expect(padding.left, "left padding shrinks on phone").toBe("12px");
    expect(padding.right, "right padding shrinks on phone").toBe("12px");
    expect(padding.top, "top padding is untouched (vertical rhythm)").toBe("20px");
    expect(padding.bottom, "bottom padding is untouched (vertical rhythm)").toBe("20px");
  });

  test("route-shell horizontal padding shrinks on phone, desktop's 24px vertical stays", async ({ page }) => {
    await gotoAndSettle(page, "/captura", "captura-page");
    const padding = await elementPadding(page, ".route-shell");
    expect(padding.left, "left padding shrinks on phone").toBe("12px");
    expect(padding.right, "right padding shrinks on phone").toBe("12px");
    expect(padding.top, "top padding is untouched (vertical rhythm)").toBe("24px");
    expect(padding.bottom, "bottom padding is untouched (vertical rhythm)").toBe("24px");
  });
});

test.describe("desktop (default project)", () => {
  test("main-content padding is untouched at desktop width (no divergence introduced)", async ({ page }) => {
    await gotoAndSettle(page, "/profiles");
    const width = await clientWidth(page);
    expect(width, "sanity: this really is desktop").toBeGreaterThanOrEqual(768);

    const padding = await mainContentPadding(page);
    expect(padding.left).toBe("20px");
    expect(padding.right).toBe("20px");
    expect(padding.top).toBe("20px");
    expect(padding.bottom).toBe("20px");
  });

  test("AdminChrome content div and route-shell padding are untouched at desktop width", async ({ page }) => {
    await gotoAndSettle(page, "/etl/connectors", "connectors-page");
    const adminPadding = await elementPadding(page, ".admin-chrome-content");
    expect(adminPadding.left).toBe("20px");
    expect(adminPadding.right).toBe("20px");

    await gotoAndSettle(page, "/captura", "captura-page");
    const shellPadding = await elementPadding(page, ".route-shell");
    expect(shellPadding.left).toBe("24px");
    expect(shellPadding.right).toBe("24px");
  });
});
