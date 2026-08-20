/**
 * E2E: the Estado board at `/admin` (issue #638, part of #636).
 *
 * The two fixtures this spec exists to prove are named directly in the
 * issue's verification section — a decorative "every source is healthy"
 * fixture never exercises the status logic at all:
 *
 *   1. A "starving-but-ok" CRAWL source (fotocasa's real 2026-08-20 shape:
 *      four consecutive `ok` runs, the latest carrying a soft_block notice,
 *      zero listing activity for ~40h) — must render `atascado`, never a
 *      green/fresco row.
 *   2. A CAPTURE source that is merely awaiting capture (idealista-shaped:
 *      well past its due window, zero recent capture failures) — must
 *      render `pendiente`, NEVER `atascado`/`fallando` — the owner's
 *      #636-addendum safety constraint: a bursty, operator-paced source
 *      must never read as failure from elapsed time alone.
 *
 * The page's data comes from GET /api/etl/source-health
 * (lib/db/source-health.ts). This spec MOCKS that route (`page.route`)
 * rather than seeding the shared demo Postgres: the real-DB-to-real-status
 * wiring is already proven by the vitest integration suite
 * (lib/db/__tests__/source-health.integration.test.ts, which snapshots and
 * restores every real connector row it has to touch); what THIS layer needs
 * to prove is rendering — ordering, mobile viewport, no horizontal overflow
 * — which a crafted payload tests deterministically and without touching
 * any shared data, real connector names (fotocasa/idealista/aliseda are
 * genuine portals with real rows in the demo DB) included. Same precedent as
 * e2e/freshness-indicator.spec.ts's "all fresh stays green (EC-2)" /
 * "API failure shows unknown (EC-3)" tests.
 *
 * Requires ADMIN_API_KEY (middleware.ts gates every UI page). Skips cleanly
 * otherwise, matching the other specs here.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

interface MockSourceRow {
  source: string;
  kind: "crawl" | "capture";
  status: "fresco" | "pendiente" | "atascado" | "fallando";
  disabled: boolean;
  freshnessIntervalHours: number;
  lastActivityAt: string | null;
  ageHours: number | null;
  due: boolean;
  pastDoubleWindow: boolean;
  captureFailureRate7d: number | null;
  reason: string;
  new24h: number;
  sparkline7d: number[];
  latestRunStatus: string | null;
  latestRunFailureClassification: string | null;
  captureFailed7d: number;
  captureTotal7d: number;
  ultimaPasadaCompletaAt: string | null;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function mockRow(overrides: Partial<MockSourceRow> & { source: string }): MockSourceRow {
  return {
    kind: "crawl",
    status: "fresco",
    disabled: false,
    freshnessIntervalHours: 24,
    lastActivityAt: hoursAgo(0.5),
    ageHours: 0.5,
    due: false,
    pastDoubleWindow: false,
    captureFailureRate7d: null,
    reason: "fresh",
    new24h: 3,
    sparkline7d: [0, 1, 0, 2, 1, 0, 3],
    latestRunStatus: "ok",
    latestRunFailureClassification: null,
    captureFailed7d: 0,
    captureTotal7d: 0,
    ultimaPasadaCompletaAt: hoursAgo(1),
    ...overrides,
  };
}

// The fixture: fotocasa-shaped starvation, idealista-shaped pending capture,
// a genuinely failing source, a healthy source, and a disabled one.
const FIXTURE_SOURCES: MockSourceRow[] = [
  mockRow({
    source: "e2e-fotocasa-starving",
    status: "atascado",
    reason: "soft_block_stale",
    lastActivityAt: hoursAgo(40),
    ageHours: 40,
    due: true,
    pastDoubleWindow: true,
    new24h: 0,
    sparkline7d: [2, 3, 1, 0, 0, 0, 0],
    latestRunStatus: "ok",
    latestRunFailureClassification: "soft_block",
  }),
  mockRow({
    source: "e2e-milanuncios-failing",
    status: "fallando",
    reason: "run_failed",
    lastActivityAt: hoursAgo(3),
    ageHours: 3,
    due: false,
    new24h: 0,
    latestRunStatus: "failed",
  }),
  mockRow({
    source: "e2e-idealista-pending",
    kind: "capture",
    status: "pendiente",
    reason: "pendiente_de_captura",
    lastActivityAt: hoursAgo(96),
    ageHours: 96,
    due: true,
    pastDoubleWindow: true,
    new24h: 0,
    sparkline7d: [0, 0, 0, 0, 0, 0, 0],
    latestRunStatus: null,
    latestRunFailureClassification: null,
    captureFailed7d: 0,
    captureTotal7d: 0,
    ultimaPasadaCompletaAt: null,
  }),
  mockRow({
    source: "e2e-solvia-fresh",
    status: "fresco",
    lastActivityAt: hoursAgo(1),
    ageHours: 1,
    new24h: 4,
  }),
  mockRow({
    source: "e2e-escogecasa-disabled",
    status: "atascado", // would be a problem if it counted — it must not.
    disabled: true,
    lastActivityAt: hoursAgo(500),
    ageHours: 500,
    due: true,
    pastDoubleWindow: true,
  }),
];

async function mockSourceHealth(page: Page): Promise<void> {
  await page.route("**/api/etl/source-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: FIXTURE_SOURCES,
        rollupStatus: "fallando",
        generatedAt: new Date().toISOString(),
      }),
    });
  });
}

async function documentOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("Estado board (/admin)", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
    await mockSourceHealth(page);
  });

  test.describe("mobile (iPhone 13, 390px)", () => {
    const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
    test.use({ ...iPhone13 });

    test("problem sources rank first on mobile, with no horizontal overflow", async ({
      page,
    }) => {
      await page.goto("/admin");
      await expect(page.getByTestId("estado-board")).toBeVisible();

      // D-120's measurement trap: assert the REAL rendered viewport, never
      // window.innerWidth (reports ~653 under emulation regardless of the
      // real 390px viewport).
      expect(
        await page.evaluate(() => document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(400);
      expect(await documentOverflowPx(page)).toBeLessThanOrEqual(0);

      // Every non-fresco ACTIVE row must rank ahead of every fresco row,
      // without scrolling — read the rendered DOM order directly. Scoped to
      // the active-sources wrapper: the disabled fixture row is
      // deliberately seeded with status "atascado" precisely to prove it
      // must NOT be counted here (D-055) — its own describe block below
      // checks it renders, just never mixed into this ranking.
      const rows = page
        .getByTestId("estado-active-sources")
        .locator('[data-testid^="source-row-e2e-"]');
      const statuses = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-status")),
      );
      const firstFrescoIdx = statuses.indexOf("fresco");
      expect(firstFrescoIdx).toBeGreaterThan(-1);
      // Nothing worse than fresco appears after the first fresco row.
      const afterFirstFresco = statuses.slice(firstFrescoIdx);
      expect(afterFirstFresco.every((s) => s === "fresco")).toBe(true);

      // Every row from the fixture rendered somewhere on the page (active
      // section + the disabled section below it), all without any
      // horizontal scroll (asserted above).
      await expect(page.locator('[data-testid^="source-row-e2e-"]')).toHaveCount(
        FIXTURE_SOURCES.length,
      );

      await expect(page.getByTestId("error-display")).toHaveCount(0);
    });

    test("fotocasa-shaped starving-but-ok source renders atascado, never green", async ({
      page,
    }) => {
      await page.goto("/admin");
      const row = page.getByTestId("source-row-e2e-fotocasa-starving");
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-status", "atascado");
      await expect(row.getByTestId("source-new24h-e2e-fotocasa-starving")).toContainText(
        "+0 en 24h",
      );
    });

    test("idealista-shaped bursty capture source renders pendiente, never atascado/fallando", async ({
      page,
    }) => {
      await page.goto("/admin");
      const row = page.getByTestId("source-row-e2e-idealista-pending");
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-status", "pendiente");
      const status = await row.getAttribute("data-status");
      expect(status).not.toBe("atascado");
      expect(status).not.toBe("fallando");
      // The chip reads as an owner action, not an alarm.
      await expect(row).toContainText("tu acción: capturar");
    });

    test("a disabled source is collapsed into its own section, not counted as a failure", async ({
      page,
    }) => {
      await page.goto("/admin");
      const disabledSection = page.getByTestId("estado-disabled-section");
      await expect(disabledSection).toBeVisible();
      const disabledRow = disabledSection.getByTestId(
        "source-row-e2e-escogecasa-disabled",
      );
      await expect(disabledRow).toBeVisible();

      // Renders below every active row, even though its own (disabled,
      // ignored) status would otherwise rank it as the worst problem —
      // D-055's "never as a failure" requirement.
      const activeRows = page
        .getByTestId("estado-active-sources")
        .locator('[data-testid^="source-row-e2e-"]');
      const lastActiveBox = await activeRows.last().boundingBox();
      const disabledBox = await disabledRow.boundingBox();
      expect(lastActiveBox).not.toBeNull();
      expect(disabledBox).not.toBeNull();
      expect(disabledBox!.y).toBeGreaterThan(lastActiveBox!.y);
    });
  });

  test.describe("desktop", () => {
    test("problem sources still rank first on desktop, no horizontal overflow", async ({
      page,
    }) => {
      await page.goto("/admin");
      await expect(page.getByTestId("estado-board")).toBeVisible();
      expect(await documentOverflowPx(page)).toBeLessThanOrEqual(0);

      const rows = page
        .getByTestId("estado-active-sources")
        .locator('[data-testid^="source-row-e2e-"]');
      const statuses = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-status")),
      );
      expect(statuses[0]).not.toBe("fresco");
      const firstFrescoIdx = statuses.indexOf("fresco");
      expect(statuses.slice(firstFrescoIdx).every((s) => s === "fresco")).toBe(true);
    });

    test("the idealista-shaped pending capture source never reads red on desktop either", async ({
      page,
    }) => {
      await page.goto("/admin");
      const row = page.getByTestId("source-row-e2e-idealista-pending");
      await expect(row).toHaveAttribute("data-status", "pendiente");
    });
  });
});
