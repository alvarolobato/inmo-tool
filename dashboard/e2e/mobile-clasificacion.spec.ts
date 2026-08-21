/**
 * E2E (issue #606): `/admin/clasificacion` at phone width.
 *
 * Measured directly (390px `document.documentElement.clientWidth`, iPhone 13
 * emulation): `main.main-content` itself never overflows (it's the
 * `overflow: auto` scroll container the #571 mobile shell gave every page),
 * but a promotion candidate's property-reference pills
 * (`app/admin/clasificacion/page.tsx`'s `PropertyRef`) sit in a
 * `flexWrap: "wrap"` row while each pill itself carries `whiteSpace:
 * "nowrap"` — a real listing address is long enough on its own that a
 * single pill's min-content width exceeds the viewport, and a nowrap item
 * can't shrink below that no matter how the row wraps around it. Fixed by
 * capping each pill at `min(240px, 60vw)` with an ellipsis.
 *
 * `/etl` and `/etl/captura` — #606's other two targets — are NOT covered
 * here: both are mid-deletion/merge under #642 (P1 merges `/etl/captura`
 * into `/admin/fuentes`; P2 deletes `/etl` outright), so fixing their
 * tables now would be wasted work that conflicts with that in-flight
 * deletion. See `mobile-main-content-padding.spec.ts`'s route-exclusion
 * comment for the same note.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) — a promotion candidate needs a
 * real `ai_assessment` row with a redflags `other` flag, above the
 * candidate-promotion threshold (default 5). Skips cleanly if none is
 * reachable, matching mobile-profiles.spec.ts / candidates.spec.ts.
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

const NAME_PREFIX = "e2e-mobile-clasif-";
// This project's promotion threshold defaults to 5 (getCandidatePromotionThreshold) —
// seed 5 properties/assessments so the slug actually clears it.
const CANDIDATE_COUNT = 5;
const SLUG = `${NAME_PREFIX}slug`;
// Long enough on its own (no wrapping) to reproduce the pre-fix overflow —
// a real listing address, not a short placeholder.
const LONG_ADDRESS = `${NAME_PREFIX}Calle de la Verificación Móvil Larguísima, número 123, piso 4B, Madrid`;

let pool: Pool;
let dbAvailable = false;
const propertyIds: number[] = [];

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[mobile-clasificacion.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const propRes = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address, created_at)
       VALUES (40.4168, -3.7038, 'piso', 70, $1, NOW()) RETURNING id`,
      [`${LONG_ADDRESS} ${i}`],
    );
    const propertyId = propRes.rows[0].id;
    propertyIds.push(propertyId);
    await pool.query(
      `INSERT INTO ai_assessment (property_id, assessment_type, result, generated_at)
       VALUES ($1, 'redflags', $2::jsonb, NOW())`,
      [
        propertyId,
        JSON.stringify({
          flags: [
            {
              type: "other",
              candidate_type: SLUG,
              candidate_definition: "e2e probe definition",
              evidence: `e2e probe evidence ${i}`,
              description: "e2e probe",
            },
          ],
        }),
      ],
    );
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [propertyIds]);
  await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [propertyIds]);
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
  // NEVER window.innerWidth under mobile emulation — see
  // mobile-profiles.spec.ts's header for the measured gotcha.
  return page.evaluate(() => document.documentElement.clientWidth);
}

test.describe("phone width (iPhone 13 emulation)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("candidate property pills don't overflow the page at phone width", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto("/admin/clasificacion", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`candidato-${SLUG}`), "the seeded candidate rendered").toBeVisible();
    await page.waitForTimeout(1000);

    const width = await clientWidth(page);
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);

    // The real, falsifiable measurement: `main.main-content`'s own scroll
    // width, not document.documentElement — `.main-content` is the
    // `overflow: auto` container the #571 shell gave every page, so
    // document-level scrollWidth never moves even when a child inside it
    // genuinely overflows (confirmed empirically while building this
    // fix — see #574's identical finding on the candidate feed).
    const mainMeasure = await page.evaluate(() => {
      const m = document.querySelector("main.main-content")!;
      return { clientWidth: m.clientWidth, scrollWidth: m.scrollWidth };
    });
    expect(
      mainMeasure.scrollWidth,
      `main.main-content scrollWidth (${mainMeasure.scrollWidth}) should equal clientWidth (${mainMeasure.clientWidth}) — no horizontal overflow`,
    ).toBeLessThanOrEqual(mainMeasure.clientWidth + 1);

    // Also assert no individual element pokes past the viewport, naming
    // the offender if this regresses — a proxy-free measurement per pill.
    const offenders = await page.evaluate((clientW) => {
      const bad: { tag: string; text: string; right: number }[] = [];
      document.querySelectorAll('[data-testid^="candidato-"] a, [data-testid^="candidato-"] span').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > clientW + 1) {
          bad.push({ tag: el.tagName, text: (el.textContent || "").slice(0, 40), right: Math.round(rect.right) });
        }
      });
      return bad;
    }, width);
    expect(offenders, "no property-reference pill should extend past the viewport").toEqual([]);

    // The fix must be `overflow: hidden` letting the pill shrink to its
    // line, NOT a fixed `maxWidth` cap. A cap tighter than the available
    // line truncates every same-street address to an identical prefix —
    // Spanish addresses carry the distinguishing part ("número 123, piso
    // 4B") at the END — so assert the pills actually use the width the
    // wrapped row gives them. Measured: 300px with `overflow: hidden`
    // alone; 234px with the removed `min(240px, 60vw)` cap.
    const pillWidths = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-testid^="candidato-"] a, [data-testid^="candidato-"] span'),
      )
        .filter((el) => (el.textContent || "").includes("Calle de la Verificaci"))
        .map((el) => Math.round(el.getBoundingClientRect().width)),
    );
    expect(pillWidths.length, "the seeded property pills rendered").toBeGreaterThan(0);
    for (const w of pillWidths) {
      expect(
        w,
        `pill width ${w}px should use the room its wrapped line has (>=280px at 390px viewport) — a tighter fixed cap truncates same-street addresses to an identical prefix`,
      ).toBeGreaterThanOrEqual(280);
    }

    // A truncated pill must stay recoverable: both branches of PropertyRef
    // put the full address in `title`. The unlinked <span> branch used to
    // spend its title purely on explaining the missing link.
    const titles = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-testid^="candidato-"] a, [data-testid^="candidato-"] span'),
      )
        .filter((el) => (el.textContent || "").includes("Calle de la Verificaci"))
        .map((el) => el.getAttribute("title") || ""),
    );
    for (const [i, t] of titles.entries()) {
      expect(t, `pill ${i}'s title carries the full address for recovery`).toContain(
        "piso 4B, Madrid",
      );
    }
  });
});

test.describe("desktop width (no regression from the phone fix)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("property pills render in full at 1440px — the phone fix must not cap desktop", async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.goto("/admin/clasificacion", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`candidato-${SLUG}`), "the seeded candidate rendered").toBeVisible();
    await page.waitForTimeout(500);

    // `/admin/clasificacion` had no overflow problem at desktop width. An
    // earlier revision of the #606 fix capped every pill at 240px here
    // too (natural width 540px), truncating addresses on a viewport with
    // plenty of room. `scrollWidth <= clientWidth` is the direct,
    // proxy-free "this text is not truncated" measurement.
    const pills = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-testid^="candidato-"] a, [data-testid^="candidato-"] span'),
      )
        .filter((el) => (el.textContent || "").includes("Calle de la Verificaci"))
        .map((el) => ({
          width: Math.round(el.getBoundingClientRect().width),
          scrollWidth: (el as HTMLElement).scrollWidth,
          clientWidth: (el as HTMLElement).clientWidth,
        })),
    );
    expect(pills.length, "the seeded property pills rendered").toBeGreaterThan(0);
    for (const p of pills) {
      expect(
        p.scrollWidth,
        `pill (${p.width}px rendered) should not be truncated at 1440px — scrollWidth ${p.scrollWidth} vs clientWidth ${p.clientWidth}`,
      ).toBeLessThanOrEqual(p.clientWidth + 1);
    }
  });
});
