/**
 * E2E: the "Colas" band on the Estado board (issue #640, part of #636).
 *
 * MOCKS both `/api/etl/source-health` and `/api/etl/queues` — the same
 * precedent as `e2e/estado-board.spec.ts`, and for the same reason: the
 * real-DB-to-real-number wiring is proven by
 * `lib/db/__tests__/queues.integration.test.ts` against a real Postgres,
 * while what THIS layer must prove is rendering — that a 390px phone shows
 * every tile 2-across with no horizontal overflow, that problems rank first,
 * and above all that the honesty rules survive the trip to the DOM: a
 * `null` depth must never come out as "0".
 *
 * The fixture is production-shaped (2026-08-22): a capture worklist deep and
 * rising because a re-capture cohort was requeued, a dedup review backlog
 * roughly in balance, a dedup PASS whose last success is 20h old (#614), an
 * assessment backlog with measured throughput but no measurable arrivals,
 * and the polled queues sitting at zero.
 *
 * Requires ADMIN_API_KEY (middleware.ts gates every UI page). Skips cleanly
 * otherwise, matching the other specs here.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { adminKey, seedAdminSession } from "./helpers/admin-session";
import type { QueueTile } from "../lib/queues";

const FIXTURE_QUEUES: QueueTile[] = [
  {
    key: "dedup_pass",
    label: "Pase de dedup",
    depth: null,
    headline: "último OK hace 20 h",
    inflow24h: null,
    outflow24h: null,
    oldestAgeHours: 20,
    trend: "unknown",
    severity: "alarm",
    note: "12 muertos/7 d",
    unmeasured: null,
    href: null,
    etaHours: null,
  },
  {
    key: "captura",
    label: "Captura pendiente",
    depth: 1476,
    headline: null,
    inflow24h: 2855,
    outflow24h: 1379,
    oldestAgeHours: 408,
    trend: "growing",
    severity: "warn",
    note: "idealista",
    unmeasured: null,
    href: "/admin/fuentes/idealista",
    etaHours: 25.7,
  },
  {
    key: "dedup_review",
    label: "Revisión de dedup",
    depth: 287,
    headline: null,
    inflow24h: 46,
    outflow24h: 43,
    oldestAgeHours: 456,
    trend: "growing",
    severity: "warn",
    note: null,
    unmeasured: null,
    href: "/admin/dedup",
    etaHours: 160,
  },
  {
    key: "evaluacion_ia",
    label: "Evaluación IA",
    depth: 1157,
    headline: null,
    inflow24h: null,
    outflow24h: 1076,
    oldestAgeHours: 300,
    trend: "working",
    severity: "ok",
    note: null,
    unmeasured: null,
    href: "/admin/llm",
    etaHours: 25.8,
  },
  {
    key: "capturas_sin_procesar",
    label: "Capturas sin procesar",
    depth: 0,
    headline: null,
    inflow24h: 1396,
    outflow24h: 1396,
    oldestAgeHours: null,
    trend: "empty",
    severity: "ok",
    note: null,
    unmeasured: null,
    href: "/admin/fuentes",
    etaHours: null,
  },
  {
    key: "triggers",
    label: "Triggers pendientes",
    depth: 0,
    headline: null,
    inflow24h: 0,
    outflow24h: 0,
    oldestAgeHours: null,
    trend: "empty",
    severity: "ok",
    note: null,
    unmeasured: null,
    href: "/admin/fuentes",
    etaHours: null,
  },
  {
    key: "perfiles_materializar",
    label: "Perfiles por re-materializar",
    depth: null,
    headline: null,
    inflow24h: null,
    outflow24h: null,
    oldestAgeHours: null,
    trend: "unknown",
    severity: "ok",
    note: null,
    unmeasured: "sweep en curso",
    href: "/profiles",
    etaHours: null,
  },
];

async function mockApis(page: Page, queues: QueueTile[] | null): Promise<void> {
  await page.route("**/api/etl/source-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: [],
        rollupStatus: null,
        generatedAt: new Date().toISOString(),
        ok: true,
      }),
    });
  });
  await page.route("**/api/etl/queues", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        queues === null
          ? { queues: [], generatedAt: new Date(0).toISOString(), ok: false }
          : { queues, generatedAt: new Date().toISOString(), ok: true },
      ),
    });
  });
}

test.describe("Estado — Colas (/admin)", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
  });

  test.describe("mobile (iPhone 13, 390px)", () => {
    const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
    test.use({ ...iPhone13 });

    test("queue tiles render depth and trend", async ({ page }) => {
      await mockApis(page, FIXTURE_QUEUES);
      await page.goto("/admin");
      await expect(page.getByTestId("estado-queues")).toBeVisible();

      // EC-1: dedup-review, evaluación-IA, captura and triggers are all
      // present, each with depth, trend and oldest-age.
      for (const key of ["captura", "dedup_review", "evaluacion_ia", "triggers"]) {
        await expect(page.getByTestId(`queue-tile-${key}`)).toBeVisible();
      }
      await expect(page.getByTestId("queue-depth-captura")).toHaveText("1.476");
      await expect(page.getByTestId("queue-trend-captura")).toContainText("↑ subiendo");
      await expect(page.getByTestId("queue-trend-captura")).toContainText("+2855 / −1379");
      await expect(page.getByTestId("queue-meta-captura")).toContainText("más antiguo 17 d");
      await expect(page.getByTestId("queue-meta-captura")).toContainText("idealista");

      await expect(page.getByTestId("queue-depth-dedup_review")).toHaveText("287");
      await expect(page.getByTestId("queue-depth-triggers")).toHaveText("0");
      await expect(page.getByTestId("queue-trend-triggers")).toContainText("vacía");

      // The AI backlog knows its throughput but not its arrivals: it must say
      // "en curso", never claim a direction, and never print a fake inflow.
      await expect(page.getByTestId("queue-trend-evaluacion_ia")).toContainText("↓ en curso");
      await expect(page.getByTestId("queue-trend-evaluacion_ia")).toContainText("−1076");
      await expect(page.getByTestId("queue-trend-evaluacion_ia")).not.toContainText("+");

      // Each tile links to the surface that owns the work — Estado never
      // embeds a copy of it (the #636 "unifica, no añadas" constraint).
      await expect(page.getByTestId("queue-tile-captura")).toHaveAttribute(
        "href",
        "/admin/fuentes/idealista",
      );
      await expect(page.getByTestId("queue-tile-dedup_review")).toHaveAttribute(
        "href",
        "/admin/dedup",
      );
      await expect(page.getByTestId("queue-tile-evaluacion_ia")).toHaveAttribute(
        "href",
        "/admin/llm",
      );
    });

    test("a null depth renders its reason, never a zero", async ({ page }) => {
      await mockApis(page, FIXTURE_QUEUES);
      await page.goto("/admin");
      await expect(page.getByTestId("estado-queues")).toBeVisible();

      // The dedup PASS has no depth at all — its signal is an age.
      const pass = page.getByTestId("queue-depth-dedup_pass");
      await expect(pass).toHaveText("último OK hace 20 h");
      await expect(page.getByTestId("queue-trend-dedup_pass")).toHaveCount(0);

      // Mid-sweep the stale-profile check is not evaluable (#285).
      await expect(page.getByTestId("queue-depth-perfiles_materializar")).toHaveText(
        "sweep en curso",
      );
      await expect(page.getByTestId("queue-trend-perfiles_materializar")).toHaveCount(0);
    });

    test("a stalled dedup pass ranks first and reads red", async ({ page }) => {
      await mockApis(page, FIXTURE_QUEUES);
      await page.goto("/admin");
      await expect(page.getByTestId("estado-queues")).toBeVisible();
      const tiles = page.locator('[data-testid^="queue-tile-"]');
      await expect(tiles).toHaveCount(FIXTURE_QUEUES.length);
      const severities = await tiles.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-severity")),
      );
      expect(severities[0]).toBe("alarm");
      // Nothing worse than 'ok' appears after the first 'ok' tile.
      const firstOk = severities.indexOf("ok");
      expect(firstOk).toBeGreaterThan(-1);
      expect(severities.slice(firstOk).every((s) => s === "ok")).toBe(true);
      await expect(page.getByTestId("queue-tile-dedup_pass")).toHaveAttribute(
        "data-severity",
        "alarm",
      );
    });

    test("fits two tiles across at 390px with no horizontal overflow", async ({ page }) => {
      await mockApis(page, FIXTURE_QUEUES);
      await page.goto("/admin");
      await expect(page.getByTestId("estado-queues")).toBeVisible();
      await expect(page.locator('[data-testid^="queue-tile-"]')).toHaveCount(
        FIXTURE_QUEUES.length,
      );

      // D-120's measurement trap: window.innerWidth reports ~653 under
      // emulation — only clientWidth is the real rendered viewport.
      expect(await page.evaluate(() => document.documentElement.clientWidth)).toBeLessThanOrEqual(
        400,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);

      // Exactly two columns: the first two tiles share a row, the third starts
      // a new one.
      const boxes = await page
        .locator('[data-testid^="queue-tile-"]')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(boxes[0]).toBeCloseTo(boxes[1], 0);
      expect(boxes[2]).toBeGreaterThan(boxes[0]);

      // Every tile is a comfortable tap target (D-124-adjacent: ≥44px).
      const heights = await page
        .locator('[data-testid^="queue-tile-"]')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    });

    test("a failed queue read says unknown, never 'nothing queued'", async ({ page }) => {
      await mockApis(page, null);
      await page.goto("/admin");
      await expect(page.getByTestId("estado-queues-unknown")).toBeVisible();
      await expect(page.locator('[data-testid^="queue-tile-"]')).toHaveCount(0);
    });
  });
});
