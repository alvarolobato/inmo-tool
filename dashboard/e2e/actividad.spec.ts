/**
 * E2E: `/admin/actividad` — the unified ingest chronology (issue #644).
 *
 * Runs at PHONE width (390px, iPhone 13) because that is the surface the
 * owner actually reads this on. The assertions that matter here are the ones
 * a desktop run cannot make:
 *
 *   - nothing overflows 390px — measured with
 *     `document.documentElement.clientWidth/scrollWidth`, NEVER
 *     `window.innerWidth`, which Chromium device emulation reports as 653 on
 *     an emulated 390px page (D-120 point 3);
 *   - every filter control clears the 44px tap-target floor (D-124);
 *   - the feed rolls up rather than firehosing: a seeded 20-capture burst
 *     renders as ONE row, not 20.
 *
 * Plus EC-3: filtering by source shows only that source's events.
 *
 * Seeds its own rows against whatever Postgres the server under test uses,
 * and deletes them afterwards. Skips cleanly when Postgres is unreachable or
 * ADMIN_API_KEY is unset, matching the other admin specs.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

// Destructure out `defaultBrowserType` (webkit) — this project's single
// Playwright project is chromium (playwright.config.ts, #681); spreading the
// descriptor whole switches the worker to a browser CI does not install.
// Pinned by lib/__tests__/e2e-device-descriptor-convention.test.ts.
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
test.use({ ...iPhone13 });

const TAG = "e2e644";
const CRAWL_SOURCE = `${TAG}_fotocasa`;
const CAPTURE_SOURCE = `${TAG}_idealista`;
const MIN_TAP_PX = 44;

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
let runId: number | null = null;
let dedupId: number | null = null;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[actividad.spec] Postgres unreachable — skipping");
    return;
  }
  await cleanup();

  // A crawl sweep, five minutes ago, with one connector outcome.
  const run = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs (trigger, started_at, finished_at, duration_ms, status,
                                 connectors_ok, connectors_failed, total_connectors)
     VALUES ('scheduler', NOW() - interval '5 minutes', NOW() - interval '4 minutes',
             60000, 'success', 1, 0, 1)
     RETURNING id`,
  );
  runId = run.rows[0].id;
  await pool.query(
    `INSERT INTO connector_run_results
       (run_id, connector_name, started_at, finished_at, status,
        discovered_count, fetched_count, error_count, skipped_unchanged_count, fetch_ms_total)
     VALUES ($1, $2, NOW() - interval '5 minutes', NOW() - interval '4 minutes', 'ok',
             179, 10, 0, 169, 4038)`,
    [runId, CRAWL_SOURCE],
  );

  // A 20-capture burst one minute apart, ending 40 minutes ago. Every gap
  // is 1 minute, well inside the 30-minute session threshold, so the whole
  // burst must collapse into ONE row.
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO extension_capture (url, connector_name, status, created_at)
       VALUES ($1, $2, 'done', NOW() - ($3 || ' minutes')::interval)`,
      [`https://x/${TAG}/${i}`, CAPTURE_SOURCE, String(60 - i)],
    );
  }

  const dedup = await pool.query<{ id: number }>(
    `INSERT INTO dedup_runs (trigger, started_at, finished_at, duration_ms, status,
                             pairs_compared, merged, suggested, conflicts)
     VALUES ('scheduler', NOW() - interval '2 minutes', NOW() - interval '1 minute',
             60000, 'success', 1234, 2, 7, 0)
     RETURNING id`,
  );
  dedupId = dedup.rows[0].id;
});

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM extension_capture WHERE url LIKE 'https://x/${TAG}/%'`);
  if (runId != null) await pool.query(`DELETE FROM connector_runs WHERE id = $1`, [runId]);
  if (dedupId != null) await pool.query(`DELETE FROM dedup_runs WHERE id = $1`, [dedupId]);
  await pool.query(`DELETE FROM connector_run_results WHERE connector_name = $1`, [CRAWL_SOURCE]);
}

test.afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool?.end().catch(() => {});
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

/**
 * NEVER `window.innerWidth` under emulation — see this file's header.
 *
 * `document.documentElement.scrollWidth` alone is NOT enough on an `/admin`
 * page: the admin chrome puts the page inside its own scroll container
 * (`.admin-chrome-content`), so a child can overflow sideways by hundreds of
 * pixels while the document reports a clean 390. That happened while
 * building this page (the kind-chip strip measured 875px inside a 390px
 * viewport), so the container is measured too — plus a sweep for any element
 * whose right edge is past the viewport, excluding the chip strip's own
 * deliberate horizontal scroll.
 */
async function widths(
  page: Page,
): Promise<{ client: number; scroll: number; containerOverflow: number; overflowing: string[] }> {
  return page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const container = document.querySelector(".admin-chrome-content");
    const overflowing: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      if (el.closest(".act-chips")) return;
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

async function gotoActividad(page: Page): Promise<void> {
  await page.goto("/admin/actividad");
  await expect(page.getByTestId("actividad-page")).toBeVisible();
  // Wait out the initial fetch before measuring anything.
  await expect(page.getByTestId("actividad-loading")).toHaveCount(0);
}

test("the feed renders every kind in one stream, rolled up, at 390px", async ({ page }) => {
  await gotoActividad(page);

  const w = await widths(page);
  expect(w.client).toBeLessThanOrEqual(400);
  // The three assertions a desktop run cannot make.
  expect(w.scroll).toBeLessThanOrEqual(w.client + 1);
  expect(w.containerOverflow).toBeLessThanOrEqual(1);
  expect(w.overflowing).toEqual([]);

  // All three halves of ingest are in ONE stream — the thing four separate
  // surfaces could not do.
  await expect(page.locator('[data-testid^="act-row-crawl:"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="act-row-captura:"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="act-row-dedup:"]').first()).toBeVisible();

  // Rollup, not firehose: 20 seeded captures are ONE row. Scoped through the
  // source filter rather than asserted as a global count — this spec seeds
  // into whatever database the server under test uses, which in dev already
  // holds real activity.
  await page.getByTestId("source-filter").selectOption(CAPTURE_SOURCE);
  const captureRows = page.locator('[data-testid^="act-row-captura:"]');
  await expect(captureRows).toHaveCount(1);
  await expect(captureRows.first()).toContainText(CAPTURE_SOURCE);
  await expect(captureRows.first()).toContainText("×20");

  // The day rollup line — the literal answer to "cuántos datos se han
  // cargado". It is computed over exactly the rows on screen, so with the
  // capture source selected it reads that source's 20 stored captures.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
  const rollup = page.getByTestId(`actividad-rollup-${today}`);
  await expect(rollup).toContainText("20 anuncios guardados");
  await expect(rollup).toContainText("20 capturas");

  // ...and the crawl half contributes its own `fetched` to the same line —
  // the sum the run-centric monitor could never produce.
  await page.getByTestId("source-filter").selectOption(CRAWL_SOURCE);
  await expect(page.getByTestId(`actividad-rollup-${today}`)).toContainText("10 anuncios guardados");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-3: source filter shows only that source's events", async ({ page }) => {
  await gotoActividad(page);

  await expect(page.locator('[data-testid^="act-row-crawl:"]').first()).toBeVisible();

  await page.getByTestId("source-filter").selectOption(CAPTURE_SOURCE);

  await expect(page.locator('[data-testid^="act-row-captura:"]')).toHaveCount(1);
  // The crawl source and the sourceless dedup passes are both filtered out.
  await expect(page.locator('[data-testid^="act-row-crawl:"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="act-row-dedup:"]')).toHaveCount(0);
});

test("kind chips narrow the feed and stay tappable at 390px", async ({ page }) => {
  await gotoActividad(page);

  const chip = page.getByTestId("kind-chip-dedup");
  const box = await chip.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(MIN_TAP_PX);

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // Only dedup rows survive. Asserted as "some dedup, no capture" rather
  // than an exact dedup count: the database under test may hold real passes
  // besides the seeded one.
  await expect(page.locator('[data-testid^="act-row-dedup:"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="act-row-captura:"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="act-row-crawl:"]')).toHaveCount(0);

  // Every control on the page clears the tap-target floor, including the
  // source picker and the paging button.
  for (const testId of ["kind-chip-todo", "source-filter"]) {
    const b = await page.getByTestId(testId).boundingBox();
    expect(b!.height, testId).toBeGreaterThanOrEqual(MIN_TAP_PX);
  }

  await page.getByTestId("kind-chip-todo").click();
  await expect(page.locator('[data-testid^="act-row-captura:"]').first()).toBeVisible();
});

test("a row drills through to the surface that explains it", async ({ page }) => {
  await gotoActividad(page);
  await page.locator('[data-testid^="act-row-crawl:"]').first().click();
  // #642 P2 moved the run drill-down under Actividad; `/etl/[id]` is gone.
  await expect(page).toHaveURL(new RegExp(`/admin/actividad/run/${runId}$`));
  await expect(page.getByTestId("run-detail")).toBeVisible();
});

test("a deep link pre-filters the feed by kind and source (#642 P2)", async ({ page }) => {
  // Estado's aviso chips and the Fuentes active-block notice link here with
  // `?tipo=…&fuente=…`; without it, "ver los episodios anteriores" would drop
  // the operator into the whole unfiltered feed to hunt for the row.
  await page.goto("/admin/actividad?tipo=crawl");
  await expect(page.getByTestId("actividad-page")).toBeVisible();
  await expect(page.getByTestId("kind-chip-crawl")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("kind-chip-todo")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-testid^="act-row-crawl:"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="act-row-captura:"]')).toHaveCount(0);

  // An unknown kind is DROPPED, not rejected — a stale bookmark shows the
  // feed rather than an error page.
  await page.goto("/admin/actividad?tipo=no-such-kind");
  await expect(page.getByTestId("kind-chip-todo")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("paging loads older days without duplicating the current ones", async ({ page }) => {
  await gotoActividad(page);
  const before = await page.locator('[data-testid^="act-row-"]').count();

  const more = page.getByTestId("actividad-load-more");
  if ((await more.count()) === 0) {
    // Nothing older than the default window exists in this database — the
    // page must say so rather than offering a button that loads nothing.
    await expect(page.getByTestId("actividad-exhausted")).toBeVisible();
    return;
  }
  const moreBox = await more.boundingBox();
  expect(moreBox!.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
  await more.click();
  await expect(page.locator('[data-testid^="act-row-"]')).not.toHaveCount(before, { timeout: 10_000 });

  const ids = await page.locator('[data-testid^="act-row-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")),
  );
  expect(new Set(ids).size).toBe(ids.length);

  const w = await widths(page);
  expect(w.scroll).toBeLessThanOrEqual(w.client + 1);
  expect(w.containerOverflow).toBeLessThanOrEqual(1);
  expect(w.overflowing).toEqual([]);
});
