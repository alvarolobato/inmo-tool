/**
 * E2E (issue #596): the captura task row's button no longer squeezes the
 * label into a one-word-per-line column, at phone AND desktop width.
 *
 * The owner's own screenshots showed `CaptureTaskRow.tsx`'s label column
 * (and the "sin confirmar"-style loosened-flag warning beside it) collapsed
 * to roughly a third of the card because the launch button was a
 * `flexShrink: 0` sibling ~160px wide that could never shrink — a long task
 * label like "Hipoges — pisos, chalets, áticos en Dos Hermanas ≤210.000 €"
 * wrapped one word per line. He explicitly said this affects desktop too
 * ("esto afecta tanto al móvil como escritorio"), so this spec asserts the
 * SAME geometry at both an iPhone-13-class viewport and this project's
 * default desktop project — a mobile-only fix would pass the phone block
 * and fail (or worse, never even check) the desktop one.
 *
 * Device emulation gotcha (documented per mobile-profiles.spec.ts's header,
 * repeated here so this spec doesn't reintroduce it): under Playwright's
 * `devices["iPhone 13"]` emulation, `window.innerWidth` does NOT reflect the
 * emulated 390px viewport (it reported 653 on a prior probe) — always read
 * `document.documentElement.clientWidth` instead.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) and ADMIN_API_KEY. Skips cleanly
 * when either is missing, matching every other spec in this suite.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { Pool } from "pg";
import { seedAdminSession, adminKey } from "./helpers/admin-session";

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

// piso + chalet + atico (all three, like the owner's own "Hipoges — pisos,
// chalets, áticos en Dos Hermanas ≤210.000 €" example) plus a price ceiling
// so the assembled label (`lib/search-url/labels.ts` `taskLabel`) is long
// enough to actually wrap under the pre-fix side-by-side layout: "Idealista
// — pisos, chalets, áticos en Madrid ≤987.650 €". Madrid coordinates match
// the geography already exercised by captura-tasks.spec.ts / captura.spec.ts
// (known to resolve to real portal tasks), so this spec isn't the first to
// depend on that resolution working.
const NAME_PREFIX = "E2E-CAP596-";
const PROFILE = `${NAME_PREFIX}${Date.now()}`;
const SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 10 },
  property_types: ["piso", "chalet", "atico"],
  price_max: 987650,
};

let pool: Pool;
let dbAvailable = false;
let profileId: number | null = null;

async function purge(): Promise<void> {
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM search_profile WHERE name LIKE $1",
    [`${NAME_PREFIX}%`],
  );
  const ids = existing.rows.map((r) => r.id);
  for (const id of ids) {
    await pool.query("DELETE FROM capture_task_run WHERE profile_id = $1", [id]);
    for (const table of ["profile_listing_state", "feedback_event"]) {
      await pool.query(`DELETE FROM ${table} WHERE profile_id = $1`, [id]).catch(() => undefined);
    }
  }
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[mobile-captura-task-row.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }
  await purge();
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [PROFILE, JSON.stringify(SCOPE)],
  );
  profileId = res.rows[0].id;
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

function skipIfUnavailable(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
  test_.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
}

test.beforeEach(async ({ page, baseURL }) => {
  skipIfUnavailable(test);
  // Stub window.open so a launch click never actually navigates (matches
  // captura-tasks.spec.ts's pattern).
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });
  await seedAdminSession(page, baseURL);
});

async function clientWidth(page: Page): Promise<number> {
  // NEVER window.innerWidth under this project's chromium mobile emulation
  // (see file header) — it does not track the emulated viewport.
  return page.evaluate(() => document.documentElement.clientWidth);
}

/**
 * Resolve one hipoges task id for the seeded profile via the real (unmocked)
 * search-urls route — hipoges is picked deliberately: per D-115 every
 * hipoges task carries the "grammar" loosened flag unconditionally (its
 * `:operation` token is a confirmed-display, unconfirmed-route-code
 * inference), so it is a reliable, non-fragile way to get a row that
 * exercises BOTH exit criteria (the label AND the "sin confirmar" warning)
 * without hand-crafting a loosened-flag fixture.
 */
async function hipogesTaskId(page: Page): Promise<string> {
  const res = await page.request.get(`/api/profiles/${profileId}/search-urls`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { tasks: { id: string; portal: string }[] };
  const hipoges = body.tasks.find((t) => t.portal === "hipoges");
  expect(hipoges, "seeded profile scope must produce a hipoges task").toBeTruthy();
  return hipoges!.id;
}

/**
 * Runs the full set of geometry assertions for one captura task row against
 * whatever viewport the calling test is using. Shared between the desktop
 * and phone blocks below so both exercise the exact same claims — that is
 * the point: the owner's fix must not be viewport-conditional.
 *
 * The sanity check on the emulated viewport width (mobile < 768 <= desktop)
 * is done AFTER `page.goto`, not before: `document.documentElement
 * .clientWidth` on the pre-navigation `about:blank` document does not yet
 * reflect the emulated viewport (measured 980 on a probe run here, neither
 * the iPhone-13 390 nor any desktop width) — only the loaded page's layout
 * does.
 */
async function assertRowIsStacked(page: Page, expectMobile: boolean): Promise<void> {
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  const width = await clientWidth(page);
  if (expectMobile) {
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);
  } else {
    expect(width, "sanity: this really is desktop").toBeGreaterThanOrEqual(768);
  }

  const taskId = await hipogesTaskId(page);
  const row = page.getByTestId(`captura-task-${taskId}`);
  await expect(row).toBeVisible();

  const rowBox = await row.boundingBox();
  expect(rowBox, "task row has a box").not.toBeNull();
  if (!rowBox) return;

  // --- Exit criterion 1: the label uses the full card width, no
  // one-word-per-line wrapping. -----------------------------------------
  // Measured on the TEXT-BLOCK WRAPPER (the flex item that used to be
  // squeezed to a starved column by the `flexShrink: 0` button beside it),
  // not the `<strong>` label itself: a wrapped inline element's bounding
  // box only encloses its own line fragments, so on a wide-enough desktop
  // viewport a short label can render on a single line and read as
  // "narrow" by content alone even when its CONTAINER already has the
  // full row width available — that's the actually-fixed layout, not a
  // false negative to paper over. The wrapper's width is what the CSS
  // controls directly, independent of how long the label text happens to
  // be at a given viewport.
  const textBlock = row.getByTestId(`captura-task-text-${taskId}`);
  const textBox = await textBlock.boundingBox();
  expect(textBox, "text block has a box").not.toBeNull();
  if (!textBox) return;
  expect(
    textBox.width,
    "text block spans the row's content width, not a squeezed side column",
  ).toBeGreaterThanOrEqual(rowBox.width - 40);

  // --- Exit criterion 2: the "sin confirmar" (loosened) warning spans the
  // card width too — it used to sit in the exact same starved column. -----
  const loosened = row.getByTestId(`captura-task-loosened-${taskId}`);
  await expect(loosened).toBeVisible();
  await expect(loosened).toContainText("sin confirmar");
  const loosenedBox = await loosened.boundingBox();
  expect(loosenedBox, "loosened-flag list has a box").not.toBeNull();
  if (!loosenedBox) return;
  expect(
    loosenedBox.width,
    "loosened-flag list spans the row's content width",
  ).toBeGreaterThanOrEqual(rowBox.width - 40);

  // --- Stacked, not side-by-side: the button's top sits at or below the
  // text block's bottom (button "debajo", the owner's own wording; a
  // "button above" layout would satisfy the inverse, but this component
  // renders the button after the text block in document order). ----------
  const button = row.getByTestId(`captura-task-run-${taskId}`);
  await expect(button).toBeVisible();
  const buttonBox = await button.boundingBox();
  expect(buttonBox, "button has a box").not.toBeNull();
  if (!buttonBox) return;
  expect(
    buttonBox.y,
    "button sits below the text block (stacked), not beside it",
  ).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);

  // --- Tap target stays >= 44px (WCAG 2.5.5) — the old button was only
  // ~34px tall. ------------------------------------------------------------
  expect(buttonBox.height).toBeGreaterThanOrEqual(44);

  // --- No horizontal overflow anywhere on the page at this viewport. -----
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

test.describe("desktop (default project)", () => {
  test("captura task row: label + warning span the full card width, button stacked below with a >=44px tap target", async ({
    page,
  }) => {
    skipIfUnavailable(test);
    await assertRowIsStacked(page, false);
  });
});

test.describe("phone width (iPhone 13 emulation)", () => {
  // Destructure out `defaultBrowserType` (webkit) — this project's single
  // Playwright project is chromium (playwright.config.ts), and Playwright
  // refuses `defaultBrowserType` inside a describe block because switching
  // browser engines needs a new worker, not just new context options.
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("captura task row: label + warning span the full card width, button stacked below with a >=44px tap target", async ({
    page,
  }) => {
    skipIfUnavailable(test);
    await assertRowIsStacked(page, true);
  });
});
