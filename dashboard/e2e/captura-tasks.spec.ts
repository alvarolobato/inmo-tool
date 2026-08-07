/**
 * E2E: redesigned guided-capture page — stacked per-profile with collapsible
 * connectors (issue #413, D-041).
 *
 * Drives a real Next.js server against a real Postgres. Seeds TWO search
 * profiles so the page (`/captura`, now a server component) stacks both, one
 * under another. Then, by reading each profile's real task ids from
 * `GET /api/profiles/[id]/search-urls` and writing `capture_task_run` rows, it
 * puts connectors into the three states the redesign hinges on and asserts:
 *   - DUE (nothing run this cycle)            → EXPANDED, launch buttons shown;
 *   - HALF-DONE (some tasks run, some pending)→ EXPANDED, "A medias" badge;
 *   - NOT-DUE (every task run within window)  → COLLAPSED to a stats line;
 *   - manual expand of a collapsed connector reveals its launch buttons;
 *   - a launch button in an expanded connector records the run + opens the URL
 *     (window.open stubbed so the test stays hermetic);
 *   - the D-041 no-error-surface bar.
 *
 * Admin-gated like every page (middleware.ts). Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset — matching the other specs.
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

// Profile A → idealista fans out into TWO sections (piso=venta-viviendas,
// local=venta-locales) so it can be put HALF-DONE (one task run, one pending).
const PROFILE_A = "E2E-CAP413-A";
const SCOPE_A = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 10 },
  property_types: ["piso", "local"],
  price_max: 200000,
};
// Profile B → idealista is a single section, marked run → NOT-DUE (collapsed);
// aliseda left unrun → DUE (expanded).
const PROFILE_B = "E2E-CAP413-B";
const SCOPE_B = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 10 },
  property_types: ["piso"],
  price_max: 300000,
};

// A little real context so the secondary lines render (portal-global).
const EC_SEED = [
  "https://www.idealista.com/inmueble/E2E-CAP413-EC-1/",
  "https://www.idealista.com/inmueble/E2E-CAP413-EC-2/",
];
const WL_SEED = [
  { path: "/inmueble/E2E-CAP413-PENDING", status: "pending" },
  { path: "/inmueble/E2E-CAP413-CAPTURED", status: "captured" },
];

let pool: Pool;
let dbAvailable = false;
let profileAId: number | null = null;
let profileBId: number | null = null;

async function purge(): Promise<void> {
  // Resolve any leftover test-profile ids (a prior aborted run) so we can clear
  // their FK children — the running dev server may have materialized listing
  // state / feedback for them, which blocks a bare DELETE on search_profile.
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM search_profile WHERE name = ANY($1)",
    [[PROFILE_A, PROFILE_B]],
  );
  const ids = existing.rows.map((r) => r.id);
  for (const id of [profileAId, profileBId]) if (id !== null && !ids.includes(id)) ids.push(id);

  for (const id of ids) {
    await pool.query("DELETE FROM capture_task_run WHERE profile_id = $1", [id]);
    // Best-effort: FK children that a background materialization may have created.
    for (const table of ["profile_listing_state", "feedback_event"]) {
      await pool
        .query(`DELETE FROM ${table} WHERE profile_id = $1`, [id])
        .catch(() => undefined);
    }
  }
  // extension_capture rows must go before the property they reference (FK).
  await pool.query("DELETE FROM extension_capture WHERE url LIKE '%E2E-CAP413-%'");
  await pool.query("DELETE FROM capture_worklist WHERE url LIKE '%E2E-CAP413-%'");
  // The per-profile captured property (issue #430) — after its FK children above.
  await pool.query("DELETE FROM property WHERE address LIKE 'E2E-CAP413-%'");
  await pool.query("DELETE FROM search_profile WHERE name = ANY($1)", [[PROFILE_A, PROFILE_B]]);
}

async function insertProfile(name: string, scope: unknown): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [name, JSON.stringify(scope)],
  );
  return r.rows[0].id;
}

async function markRun(profileId: number, taskId: string): Promise<void> {
  await pool.query(
    `INSERT INTO capture_task_run (profile_id, task_id, last_run_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (profile_id, task_id) DO UPDATE SET last_run_at = NOW()`,
    [profileId, taskId],
  );
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
  profileAId = await insertProfile(PROFILE_A, SCOPE_A);
  profileBId = await insertProfile(PROFILE_B, SCOPE_B);

  for (const { path, status } of WL_SEED) {
    const url = `https://www.alisedainmobiliaria.com${path}`;
    await pool.query(
      `INSERT INTO capture_worklist (url, match_key, source_portal, status)
       VALUES ($1, $2, $3, $4)`,
      [url, `alisedainmobiliaria.com${path}`, "aliseda", status],
    );
  }
  for (const url of EC_SEED) {
    await pool.query(
      `INSERT INTO extension_capture (url, status, connector_name)
       VALUES ($1, 'done', 'idealista')`,
      [url],
    );
  }

  // Per-profile captured split (issue #430): a single captured idealista
  // property that matches profile A (profile_listing_state matched=true) but
  // NOT profile B. A's idealista connector must count it; B's must not. The two
  // EC_SEED captures above have NULL property_id, so they count for NOBODY —
  // exercising that arm too. (extension_capture.property_id → property.id.)
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (address) VALUES ('E2E-CAP413-PROP') RETURNING id`,
  );
  const propId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO extension_capture (url, status, connector_name, property_id)
     VALUES ($1, 'done', 'idealista', $2)`,
    ["https://www.idealista.com/inmueble/E2E-CAP413-MATCHED/", propId],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched)
     VALUES ($1, $2, true)`,
    [profileAId, propId],
  );
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  // Stub window.open so launching a task never navigates to a real portal.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });
  await seedAdminSession(page, baseURL);
});

async function idealistaTaskIds(page: import("@playwright/test").Page, profileId: number): Promise<string[]> {
  const res = await page.request.get(`/api/profiles/${profileId}/search-urls`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { tasks: { id: string; portal: string }[] };
  return body.tasks.filter((t) => t.portal === "idealista").map((t) => t.id);
}

test("stacks both profiles; expands due/half-done, collapses not-due; manual expand + launch — no error surface", async ({
  page,
}) => {
  // Put connectors into the three states via real task-run writes.
  const aIdealista = await idealistaTaskIds(page, profileAId!);
  expect(aIdealista.length).toBeGreaterThanOrEqual(2); // piso + local → two sections
  // HALF-DONE: run all but one of profile A's idealista tasks.
  for (const id of aIdealista.slice(0, aIdealista.length - 1)) await markRun(profileAId!, id);

  const bIdealista = await idealistaTaskIds(page, profileBId!);
  expect(bIdealista.length).toBeGreaterThanOrEqual(1);
  // NOT-DUE: run every idealista task of profile B (aliseda left unrun = DUE).
  for (const id of bIdealista) await markRun(profileBId!, id);

  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // Both profiles render, stacked.
  await expect(page.getByTestId(`captura-profile-${profileAId}`)).toBeVisible();
  await expect(page.getByTestId(`captura-profile-${profileBId}`)).toBeVisible();

  // Profile A idealista → HALF-DONE, expanded, "A medias" badge, launch buttons.
  const aIdeaConn = page.getByTestId(`captura-connector-${profileAId}-idealista`);
  await expect(aIdeaConn).toHaveAttribute("data-state", "half-done");
  await expect(aIdeaConn).toHaveAttribute("data-expanded", "true");
  await expect(page.getByTestId(`captura-connector-badge-${profileAId}-idealista`)).toContainText("A medias");
  await expect(aIdeaConn.locator('[data-testid^="captura-task-run-"]').first()).toBeVisible();

  // Profile B idealista → NOT-DUE, collapsed (stats line, no task rows yet).
  const bIdeaConn = page.getByTestId(`captura-connector-${profileBId}-idealista`);
  await expect(bIdeaConn).toHaveAttribute("data-state", "not-due");
  await expect(bIdeaConn).toHaveAttribute("data-expanded", "false");
  await expect(page.getByTestId(`captura-connector-stats-${profileBId}-idealista`)).toBeVisible();
  await expect(bIdeaConn.locator('[data-testid^="captura-task-run-"]')).toHaveCount(0);

  // Profile B aliseda → DUE, expanded, launch button available.
  const bAliConn = page.getByTestId(`captura-connector-${profileBId}-aliseda`);
  await expect(bAliConn).toHaveAttribute("data-state", "due");
  await expect(bAliConn).toHaveAttribute("data-expanded", "true");
  await expect(bAliConn.locator('[data-testid^="captura-task-run-"]').first()).toBeVisible();

  // Manual expand of the collapsed idealista connector reveals its launch button.
  await page.getByTestId(`captura-connector-toggle-${profileBId}-idealista`).click();
  await expect(bIdeaConn).toHaveAttribute("data-expanded", "true");
  await expect(bIdeaConn.locator('[data-testid^="captura-task-run-"]').first()).toBeVisible();

  // Per-profile captured split (issue #430): the one matched idealista property
  // belongs to profile A only. A's idealista activity line shows its per-profile
  // count; B's shows none — the portal-global figure is NOT used per profile.
  await expect(page.getByTestId(`captura-activity-${profileAId}-idealista`)).toContainText(
    "1 propiedad de este perfil capturada",
  );
  await expect(page.getByTestId(`captura-activity-${profileBId}-idealista`)).toContainText(
    "sin capturas de este perfil todavía",
  );

  // Launch a capture from an expanded connector: records the run + opens the URL.
  const aliButton = bAliConn.locator('[data-testid^="captura-task-run-"]').first();
  await aliButton.click();
  // onExecute records the run (awaited POST) before window.open fires, so poll.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toEqual(expect.arrayContaining([expect.stringContaining("alisedainmobiliaria.com")]));

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
