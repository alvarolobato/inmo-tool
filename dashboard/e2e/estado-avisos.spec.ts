/**
 * E2E: the two Estado bands that let `/etl` and `/etl/salud` be deleted
 * (issue #642 P2, D-041).
 *
 *   - **Avisos** — an ACTIVE extension block (#637) and an active
 *     zero-result regression (D-092), each one line, each linking to the
 *     source's own Fuentes page. This is the half neither #702 nor #706 built
 *     and the half #642's own disposition table owed.
 *   - **Rastreo** — the three fleet-wide crawl rollups `/etl`'s KPI row owned
 *     and that were not per-run facts: success rate over the last 30 sweeps
 *     (absorbing `EvolutionCharts`' outcome donut), the download rate on the
 *     last finished sweep, and the rolling 24 h error counts.
 *
 * Both endpoints are mocked with `page.route` rather than seeded: what is
 * under test is the rendering and the honesty rules (never a fabricated zero,
 * never a false "sin avisos" after a failed read), and the aggregation behind
 * them is already covered by its own tests. Mocking also lets the failure
 * shapes be driven deterministically, which seeding cannot.
 *
 * Phone-first per D-120/D-121/D-124. The overflow assertion measures
 * `.admin-chrome-content`, NOT `document.documentElement`: the admin chrome
 * has its own scroll container, so a child can overflow sideways by hundreds
 * of pixels while the document reports a clean 390 (the trap
 * `e2e/actividad.spec.ts` documents; its `widths()` helper is reused here).
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

const BLOCKED_PORTAL = "e2e-avisos-idealista";
const ZERO_CONN = "e2e-avisos-fotocasa";

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

/** A data-health payload with only the fields these two bands read. */
function dataHealth(over: Record<string, unknown> = {}) {
  return {
    connectors: [],
    portals: [],
    sources: [],
    stale_profiles: [],
    zero_result_regressions: [],
    sweep_in_progress: false,
    extension_blocks: [],
    generated_at: new Date().toISOString(),
    ...over,
  };
}

const STATS = {
  success_rate: { total: 30, success: 26, partial: 2, failed: 2 },
  last_run: {
    run_id: 4242,
    duration_ms: 61_000,
    total_discovered: 1310,
    total_fetched: 1234,
    fetch_rate: 0.9420,
  },
  errors_24h: { runs_failed: 2, connectors_failed: 1 },
};

async function mock(page: Page, opts: { health?: unknown; stats?: unknown; healthFails?: boolean } = {}) {
  await page.route("**/api/etl/data-health", async (route) => {
    if (opts.healthFails) return route.fulfill({ status: 500, body: "{}" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.health ?? dataHealth()),
    });
  });
  await page.route("**/api/etl/stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.stats ?? STATS),
    });
  });
}

/**
 * Reused verbatim from `e2e/actividad.spec.ts` — the correct measurement.
 * `document.documentElement.scrollWidth` reads clean on these pages even when
 * content overflows, because `.admin-chrome-content` scrolls independently.
 */
async function widths(page: Page): Promise<{
  client: number;
  scroll: number;
  containerOverflow: number;
  overflowing: string[];
}> {
  return page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const container = document.querySelector(".admin-chrome-content");
    const overflowing: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      if (el.getBoundingClientRect().right > client + 1) {
        overflowing.push(String((el as HTMLElement).className).slice(0, 40));
      }
    });
    return {
      client,
      scroll: document.documentElement.scrollWidth,
      containerOverflow: container ? container.scrollWidth - container.clientWidth : 0,
      overflowing: overflowing.slice(0, 5),
    };
  });
}

const BOTH_PROBLEMS = dataHealth({
  extension_blocks: [
    { portal: BLOCKED_PORTAL, signature: "captcha_wall", detected_at: hoursAgo(2) },
  ],
  zero_result_regressions: [
    {
      connector: ZERO_CONN,
      scope_key: "e2e-avisos-madrid",
      consecutive_zeros: 5,
      last_nonzero_count: 31,
      drift_started_at: hoursAgo(60),
    },
  ],
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("Avisos renders an active block and a zero-result regression, each linking to its source", async ({
  page,
}) => {
  await mock(page, { health: BOTH_PROBLEMS });
  await page.goto("/admin");
  await expect(page.getByTestId("estado-board")).toBeVisible();

  const band = page.getByTestId("estado-avisos");
  await expect(band).toBeVisible();

  const block = page.getByTestId(`estado-aviso-bloqueo:${BLOCKED_PORTAL}`);
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute("href", `/admin/fuentes/${BLOCKED_PORTAL}`);
  // D-047 vocabulary: a detected block is a clean stop ("nota: … pausada"),
  // never a crash report. The same helper the deleted page used.
  await expect(block).toContainText("pausada por bloqueo");

  const zero = page.getByTestId(`estado-aviso-zero:${ZERO_CONN}`);
  await expect(zero).toBeVisible();
  await expect(zero).toHaveAttribute("href", `/admin/fuentes/${ZERO_CONN}`);
  await expect(zero).toContainText("5 ejecuciones");
  // Estado counts; it must NOT restate the scope keys Fuentes/<name> lists.
  await expect(zero).not.toContainText("e2e-avisos-madrid");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("Avisos renders NOTHING when healthy, and nothing when the read fails", async ({ page }) => {
  await mock(page, { health: dataHealth() });
  await page.goto("/admin");
  await expect(page.getByTestId("estado-board")).toBeVisible();
  await expect(page.getByTestId("estado-avisos")).toHaveCount(0);

  // A failed read is UNKNOWN. Rendering "sin avisos" would assert a specific
  // fact about a state that is not known — the class of lie #638's review
  // found on the board above (a DB error reading as "no hay fuentes").
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { healthFails: true });
  await page.goto("/admin");
  await expect(page.getByTestId("estado-board")).toBeVisible();
  await expect(page.getByTestId("estado-avisos")).toHaveCount(0);
  await expect(page.getByText(/sin avisos/i)).toHaveCount(0);
});

test("Rastreo carries the success rate, its outcome split, the download rate and 24h errors", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/admin");

  const rollup = page.getByTestId("estado-crawl-rollup");
  await expect(rollup).toBeVisible();

  // "Tasa de éxito (últ. 30)" — the KPI — AND the three counts the deleted
  // donut chart drew. One tile carries both; the chart is not rebuilt.
  const success = page.getByTestId("crawl-success-rate");
  await expect(success).toContainText("87%");
  await expect(success).toContainText("26 ok");
  await expect(success).toContainText("2 parciales");
  await expect(success).toContainText("2 con error");

  // "Tasa de descarga" — and the encontrados-vs-guardados gap the deleted
  // 30-run area chart existed to make visible, as a number.
  const fetchRate = page.getByTestId("crawl-fetch-rate");
  await expect(fetchRate).toContainText("94%");
  // No thousands separator at four digits, and that is correct: CLDR sets
  // Spanish `minimumGroupingDigits = 2`, so `toLocaleString("es-ES")` groups
  // only from five digits up (1234 → "1234", 12345 → "12.345"). Asserting
  // "1.234" here fails against a fully-ICU Chromium, which is what caught it.
  await expect(fetchRate).toContainText("1234");
  await expect(fetchRate).toContainText("1310");

  await expect(page.getByTestId("crawl-errors-24h")).toContainText("2 / 1");
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("Rastreo says 'sin ejecuciones registradas', never 0%, when there are no runs", async ({
  page,
}) => {
  // The never-fabricate-a-zero rule the whole board follows: 0 runs is not
  // 0% success, and an empty run table is not a failing fleet.
  await mock(page, {
    stats: {
      success_rate: { total: 0, success: 0, partial: 0, failed: 0 },
      last_run: {
        run_id: null,
        duration_ms: null,
        total_discovered: null,
        total_fetched: null,
        fetch_rate: null,
      },
      errors_24h: { runs_failed: 0, connectors_failed: 0 },
    },
  });
  await page.goto("/admin");

  const success = page.getByTestId("crawl-success-rate");
  await expect(success).toContainText("—");
  await expect(success).toContainText("sin ejecuciones registradas");
  await expect(success).not.toContainText("0%");
  await expect(page.getByTestId("crawl-fetch-rate")).toContainText("sin ejecuciones registradas");
});

test.describe("mobile (iPhone 13, 390px)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("both bands fit 390px with no overflow and 44px tap targets", async ({ page }) => {
    await mock(page, { health: BOTH_PROBLEMS });
    await page.goto("/admin");
    await expect(page.getByTestId("estado-avisos")).toBeVisible();
    await expect(page.getByTestId("estado-crawl-rollup")).toBeVisible();

    const w = await widths(page);
    expect(w.client, "sanity: really a phone viewport").toBeLessThanOrEqual(400);
    // The measurement that matters — see this file's header.
    expect(w.containerOverflow, `overflowing: ${w.overflowing.join(", ")}`).toBeLessThanOrEqual(0);
    expect(w.scroll - w.client).toBeLessThanOrEqual(0);

    // WCAG 2.5.5 / D-120: every aviso is a full-width, thumb-sized link.
    for (const testId of [
      `estado-aviso-bloqueo:${BLOCKED_PORTAL}`,
      `estado-aviso-zero:${ZERO_CONN}`,
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, testId).toBeGreaterThanOrEqual(44);
    }

    // The Rastreo tiles reuse `.queue-band-grid`, which resolves to exactly
    // two columns at 390px with no media query (see globals.css) — pinned so
    // a future tile added with an inline width can't silently break it.
    const tiles = page.locator('[data-testid^="crawl-"]');
    await expect(tiles).toHaveCount(3);
    const tops = await tiles.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size, "three tiles wrap onto two rows at 390px").toBe(2);
  });
});
