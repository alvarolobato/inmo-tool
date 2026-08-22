/**
 * E2E (PR #675 review, D-124): `/admin/diagnostics` row controls at phone
 * width.
 *
 * "Ver HTML", "Ver JSON" and "Borrar" are `fontSize: 12` controls with
 * `padding: "4px 12px"` — measured ~25px tall against D-124's 44px minimum
 * tap target. The pattern was copied from
 * `app/admin/clasificacion/DismissButton.tsx`, so it is pre-existing rather
 * than introduced here, but D-124's own evidence line is exactly this
 * control, so it gets fixed at the point of copy instead of propagating.
 *
 * The fix is the `.diag-action` class in globals.css (D-121 rung 1: the
 * padding is a static literal with no prop/state dependency, so it leaves
 * the inline `style` objects entirely — an inline declaration would outrank
 * the class and silently defeat the breakpoint). Desktop is unchanged at
 * 4px/12px; only `@media (max-width: 767px)` grows the box. This spec pins
 * BOTH halves, because "phone-only" is the part a later edit would quietly
 * break.
 *
 * Requires a reachable Postgres — the list needs a real
 * `extension_diagnostic` row to render a control at all. Skips cleanly if
 * none is reachable, matching mobile-clasificacion.spec.ts.
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

const SEEDED_URL = "https://realestate.hipoges.com/e2e-mobile-diagnostics/listado";
const MIN_TAP_PX = 44;

let pool: Pool;
let dbAvailable = false;
let diagnosticId: number | null = null;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[mobile-diagnostics.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const res = await pool.query<{ id: number }>(
    `INSERT INTO extension_diagnostic
       (url, html, html_bytes, title, extension_version, detection)
     VALUES ($1, $2, $3, $4, '0.16.0', $5::jsonb)
     RETURNING id`,
    [
      SEEDED_URL,
      "<html><body><main>shell</main></body></html>",
      44,
      "e2e mobile diagnostics",
      JSON.stringify({
        detection: { detailPortal: null, listingPortal: "hipoges", pageRole: "listing" },
        renderReady: {
          ready: false,
          selector: null,
          reason: "ningún selector coincidió",
          bodyTextLength: 12,
        },
        harvest: { anchorCount: 17, extractDetailUrlsCount: 0 },
        block: { blocked: false, signature: null },
        autoCaptureWouldFire: false,
      }),
    ],
  );
  diagnosticId = res.rows[0].id;
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  if (diagnosticId != null) {
    await pool.query("DELETE FROM extension_diagnostic WHERE id = $1", [diagnosticId]);
  }
  await pool.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function clientWidth(page: Page): Promise<number> {
  // NEVER window.innerWidth under mobile emulation — see
  // mobile-profiles.spec.ts's header for the measured gotcha.
  return page.evaluate(() => document.documentElement.clientWidth);
}

/** Heights of the three row controls, in DOM order. */
async function actionBoxes(
  page: Page,
): Promise<{ label: string; height: number; width: number; right: number }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".diag-action")).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: (el.textContent || "").trim(),
        height: Math.round(r.height),
        width: Math.round(r.width),
        right: Math.round(r.right),
      };
    }),
  );
}

test.describe("phone width (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("row controls meet the 44px tap target and stay inside the viewport", async ({ page }) => {
    test.skip(!dbAvailable, "no reachable Postgres");

    await page.goto("/admin/diagnostics", { waitUntil: "networkidle" });
    await expect(page.getByText("e2e mobile diagnostics")).toBeVisible();

    const width = await clientWidth(page);
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);

    const boxes = await actionBoxes(page);
    expect(
      boxes.map((b) => b.label),
      "all three row controls rendered",
    ).toEqual(expect.arrayContaining(["Ver HTML", "Ver JSON", "Borrar"]));

    for (const box of boxes) {
      expect(
        box.height,
        `"${box.label}" is ${box.height}px tall; D-124 requires >= ${MIN_TAP_PX}px on phone`,
      ).toBeGreaterThanOrEqual(MIN_TAP_PX);
      expect(
        box.width,
        `"${box.label}" is ${box.width}px wide; D-124 requires >= ${MIN_TAP_PX}px on phone`,
      ).toBeGreaterThanOrEqual(MIN_TAP_PX);
      expect(
        box.right,
        `"${box.label}" must not extend past the ${width}px viewport`,
      ).toBeLessThanOrEqual(width + 1);
    }
  });

  test("the harvest counts and the readiness reason are on the list, not SQL-only", async ({
    page,
  }) => {
    test.skip(!dbAvailable, "no reachable Postgres");

    await page.goto("/admin/diagnostics", { waitUntil: "networkidle" });
    await expect(page.getByText("e2e mobile diagnostics")).toBeVisible();

    // The "0 of 17" the whole Hipoges investigation turned on (B3).
    await expect(page.getByText("harvest: 0 de 17 enlaces")).toBeVisible();
    // A negative isRenderReady verdict must still say WHY — the chip used to
    // drop both selector and reason in exactly this case.
    await expect(page.getByText("ningún selector coincidió")).toBeVisible();
  });
});

test.describe("desktop width — the phone fix must not leak", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("row controls keep their compact desktop size", async ({ page }) => {
    test.skip(!dbAvailable, "no reachable Postgres");

    await page.goto("/admin/diagnostics", { waitUntil: "networkidle" });
    await expect(page.getByText("e2e mobile diagnostics")).toBeVisible();

    const boxes = await actionBoxes(page);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      // Unchanged from before the fix: fontSize 12 + 4px vertical padding.
      // Asserted as an upper bound so this fails loudly if the phone
      // minimums ever escape their media query.
      expect(
        box.height,
        `"${box.label}" should stay compact on desktop (was ${box.height}px)`,
      ).toBeLessThan(MIN_TAP_PX);
    }
  });
});
