/**
 * E2E: task-driven guided-capture EXECUTION page (issue #289, D-041, D-045).
 *
 * Drives a real Next.js server against a real Postgres. Seeds one search
 * profile (so `GET /api/profiles/[id]/search-urls` returns real pre-filtered
 * task URLs for idealista + aliseda) plus a couple of `capture_worklist` rows
 * for aliseda (so the per-portal progress header has real content), then on the
 * NEW task-driven `/captura` page:
 *   - asserts the profile's tasks render, grouped by portal, each with a run
 *     BUTTON and a last-done note ('nunca' initially = active/not muted);
 *   - clicks a task's button, which records the run (POST /capture-task-runs,
 *     a real DB write) and opens the URL (window.open is stubbed so the test
 *     stays hermetic — no external navigation), then asserts the row flips to
 *     GRAYED (data-muted="true") with a 'hecho …' last-done label — a DONE task
 *     shown muted;
 *   - asserts a DIFFERENT task stays ACTIVE (data-muted="false");
 *   - seeds `extension_capture` (status='done') rows for idealista — the REAL
 *     capture activity that lands when the owner opens detail pages one by one,
 *     seeding NO worklist — and asserts the idealista group shows non-zero
 *     "propiedades capturadas" progress (not "sin capturas todavía"), the fix
 *     for "the page reads empty even though captures are working";
 *   - asserts the D-041 no-error-surface bar.
 *
 * Admin-gated like every page (middleware.ts). Sets the `ps_admin` cookie the
 * way /admin/login does, and skips cleanly when Postgres is unreachable or
 * ADMIN_API_KEY is unset — matching the other specs.
 */
import { test, expect } from "@playwright/test";
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

const PROFILE_NAME = "E2E-CAPTURA-289";
const SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 10 },
  property_types: ["piso"],
  price_max: 200000,
};

const WL_SEED = [
  { path: "/inmueble/E2E-CAP289-PENDING", status: "pending" },
  { path: "/inmueble/E2E-CAP289-CAPTURED", status: "captured" },
];

// REAL captures landing for IDEALISTA with NO worklist seed — the case that
// made the page read empty. These are the ground truth (extension_capture done).
const EC_SEED = [
  "https://www.idealista.com/inmueble/E2E-CAP289-EC-1/",
  "https://www.idealista.com/inmueble/E2E-CAP289-EC-2/",
  "https://www.idealista.com/inmueble/E2E-CAP289-EC-3/",
];

let pool: Pool;
let dbAvailable = false;
let profileId: number | null = null;

async function purge(): Promise<void> {
  if (profileId !== null) {
    await pool.query("DELETE FROM capture_task_run WHERE profile_id = $1", [profileId]);
  }
  await pool.query("DELETE FROM extension_capture WHERE url LIKE '%E2E-CAP289-%'");
  await pool.query("DELETE FROM capture_worklist WHERE url LIKE '%E2E-CAP289-%'");
  await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[captura-tasks.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();

  const prof = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [PROFILE_NAME, JSON.stringify(SCOPE)],
  );
  profileId = prof.rows[0].id;

  for (const { path, status } of WL_SEED) {
    const url = `https://www.alisedainmobiliaria.com${path}`;
    const matchKey = `alisedainmobiliaria.com${path}`;
    await pool.query(
      `INSERT INTO capture_worklist (url, match_key, source_portal, status)
       VALUES ($1, $2, $3, $4)`,
      [url, matchKey, "aliseda", status],
    );
  }

  for (const url of EC_SEED) {
    await pool.query(
      `INSERT INTO extension_capture (url, status, connector_name)
       VALUES ($1, 'done', 'idealista')`,
      [url],
    );
  }
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  // Stub window.open so executing a task never navigates to a real portal —
  // record the URLs it would have opened for assertion instead.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });
  await seedAdminSession(page, baseURL);
});

test("renders discrete capture tasks with buttons, grays a done task, keeps an undone task active — no error surface", async ({
  page,
}) => {
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // Select our seeded profile explicitly (the page auto-selects the first).
  await expect(page.getByTestId("captura-profile-select")).toBeVisible();
  await page.getByTestId("captura-profile-select").selectOption({ label: PROFILE_NAME });

  // Both capture portals render as task groups.
  await expect(page.getByTestId("captura-portal-idealista")).toBeVisible();
  await expect(page.getByTestId("captura-portal-aliseda")).toBeVisible();

  // REAL capture activity: idealista shows non-zero captured progress from the
  // seeded extension_capture rows, even though NOTHING seeded its worklist —
  // the fix for "reads empty while captures are working".
  const idealistaActivity = page.getByTestId("captura-activity-idealista");
  await expect(idealistaActivity).toContainText("propiedades capturadas");
  await expect(idealistaActivity).not.toContainText("sin capturas todavía");

  // Aliseda's worklist progress header (1 of 2 captured from the seed).
  await expect(page.getByTestId("captura-captured-aliseda")).toContainText("1/2");

  // Totals strip renders.
  await expect(page.getByTestId("captura-totals")).toBeVisible();

  // Each portal group has at least one task ROW with a run BUTTON.
  const idealistaTask = page.locator('[data-portal="idealista"][data-testid^="captura-task-"]').first();
  const alisedaTask = page.locator('[data-portal="aliseda"][data-testid^="captura-task-"]').first();
  await expect(idealistaTask).toBeVisible();
  await expect(alisedaTask).toBeVisible();

  const alisedaButton = alisedaTask.locator('[data-testid^="captura-task-run-"]');
  const alisedaLastDone = alisedaTask.locator('[data-testid^="captura-task-lastdone-"]');
  await expect(alisedaButton).toBeVisible();

  // Initially: never run → active (not muted) → last-done "nunca".
  await expect(alisedaTask).toHaveAttribute("data-muted", "false");
  await expect(alisedaLastDone).toHaveText("nunca");
  await expect(idealistaTask).toHaveAttribute("data-muted", "false");

  // Execute the aliseda task: records the run (real POST) + stubbed open.
  await alisedaButton.click();

  // The row flips to grayed (done within its staleness window) with a 'hecho …'
  // last-done label — a DONE task shown muted.
  await expect(alisedaTask).toHaveAttribute("data-muted", "true");
  await expect(alisedaLastDone).toContainText("hecho");
  await expect(alisedaTask.locator('[data-testid^="captura-task-done-badge-"]')).toBeVisible();

  // window.open was invoked with the aliseda search URL (stubbed, no nav).
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened.some((u) => u.includes("alisedainmobiliaria.com"))).toBe(true);

  // The OTHER (idealista) task stays ACTIVE — one task at a time.
  await expect(idealistaTask).toHaveAttribute("data-muted", "false");

  // The run was persisted: a fresh reload still shows the aliseda task grayed.
  await page.reload();
  await page.getByTestId("captura-profile-select").selectOption({ label: PROFILE_NAME });
  const alisedaAfter = page.locator('[data-portal="aliseda"][data-testid^="captura-task-"]').first();
  await expect(alisedaAfter).toHaveAttribute("data-muted", "true");

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
