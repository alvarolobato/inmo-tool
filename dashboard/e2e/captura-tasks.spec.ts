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

// Portal-global rows seeded as a NEGATIVE CONTROL (#445): even though global
// capture activity + a worklist roll-up exist for these portals, the per-profile
// Captura page must show NONE of their numbers — only profile-scoped stats.
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

async function alisedaTaskIds(page: import("@playwright/test").Page, profileId: number): Promise<string[]> {
  const res = await page.request.get(`/api/profiles/${profileId}/search-urls`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { tasks: { id: string; portal: string }[] };
  return body.tasks.filter((t) => t.portal === "aliseda").map((t) => t.id);
}

async function lastRunAts(pool: Pool, profileId: number, taskIds: string[]): Promise<(Date | null)[]> {
  const res = await pool.query<{ task_id: string; last_run_at: Date }>(
    "SELECT task_id, last_run_at FROM capture_task_run WHERE profile_id = $1 AND task_id = ANY($2)",
    [profileId, taskIds],
  );
  const byId = new Map(res.rows.map((r) => [r.task_id, r.last_run_at]));
  return taskIds.map((id) => byId.get(id) ?? null);
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

  // Profile-scoped ONLY (#445): despite the seeded portal-global capture activity
  // and worklist roll-up (EC_SEED / WL_SEED), the connector line must surface NO
  // global numbers. The removed surfaces (portal activity + worklist/no-list) no
  // longer render, and none of their phrasing appears anywhere on the page.
  await expect(page.locator('[data-testid^="captura-activity-portal-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="captura-worklist-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="captura-nolist-"]')).toHaveCount(0);
  await expect(page.getByTestId("captura-page").getByText(/portal:/)).toHaveCount(0);
  await expect(page.getByTestId("captura-page").getByText(/\blista:/)).toHaveCount(0);
  await expect(page.getByTestId("captura-page").getByText(/en el portal/)).toHaveCount(0);
  await expect(page.getByTestId("captura-page").getByText(/pendientes/)).toHaveCount(0);

  // Capture-progress summary (issue #433): each connector line shows the three
  // reconciling numbers "capturados / total · N restantes". Profile A idealista
  // is HALF-DONE with one matched capture (capturedProfile=1) and one pending
  // task (dueCount=1) → "1 / 2 · 1 restantes"; the collapsed NOT-DUE profile B
  // idealista connector (nothing captured, nothing due) reads "0 / 0 · 0".
  const aSummary = page.getByTestId(`captura-connector-summary-${profileAId}-idealista`);
  await expect(aSummary).toBeVisible();
  await expect(aSummary).toContainText("1 / 2 · 1 restantes");
  const bSummary = page.getByTestId(`captura-connector-summary-${profileBId}-idealista`);
  await expect(bSummary).toBeVisible();
  await expect(bSummary).toContainText("0 / 0 · 0 restantes");

  // The three numbers must reconcile (captured + remaining === total) on every
  // rendered connector summary — the property that makes the line trustworthy.
  const summaries = await page.locator('[data-testid^="captura-connector-summary-"]').allInnerTexts();
  expect(summaries.length).toBeGreaterThan(0);
  for (const text of summaries) {
    const m = text.match(/(\d+)\s*\/\s*(\d+)\s*·\s*(\d+)\s+restantes/);
    expect(m, `summary "${text}" must match the "a / b · c restantes" format`).not.toBeNull();
    const [captured, total, remaining] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(captured + remaining).toBe(total);
  }

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

test("Abrir búsqueda opens the LISTING form for a drawn-zone Idealista task (#529)", async ({
  page,
}) => {
  // Both seeded profiles are drawn-zone searches → the Idealista builder emits a
  // /mapa-google?shape=((…)) MAP url. The map renders pins, not card anchors, so
  // capturing it would harvest nothing; the capture-open target must therefore be
  // the LISTING (card) form — /mapa-google stripped, shape= preserved — while the
  // canonical map url stays the task's displayed/pinned url (D-101). EC-1/EC-3.

  // Sanity: the API reports the canonical MAP url and a listing captureUrl.
  const res = await page.request.get(`/api/profiles/${profileAId}/search-urls`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    tasks: { portal: string; url: string; captureUrl: string }[];
  };
  const ideal = body.tasks.find((t) => t.portal === "idealista")!;
  expect(ideal.url).toContain("/mapa-google?shape=");
  expect(ideal.captureUrl).not.toContain("/mapa-google");
  expect(new URL(ideal.captureUrl).search).toBe(new URL(ideal.url).search);

  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // Make sure profile A's Idealista connector is expanded, then launch a task.
  const conn = page.getByTestId(`captura-connector-${profileAId}-idealista`);
  await expect(conn).toBeVisible();
  if ((await conn.getAttribute("data-expanded")) !== "true") {
    await page.getByTestId(`captura-connector-toggle-${profileAId}-idealista`).click();
    await expect(conn).toHaveAttribute("data-expanded", "true");
  }
  await conn.locator('[data-testid^="captura-task-run-"]').first().click();

  // The opened URL is the LISTING form (with the auto-start signal), never the map.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __opened: string[] }).__opened.some((u) =>
          u.includes("idealista.com/areas"),
        ),
      ),
    )
    .toBe(true);
  const opened = await page.evaluate(() =>
    (window as unknown as { __opened: string[] }).__opened.find((u) =>
      u.includes("idealista.com/areas"),
    ),
  );
  expect(opened).toBeTruthy();
  expect(opened).not.toContain("/mapa-google");
  expect(opened).toContain("shape=");
  expect(opened).toContain("inmo-capture"); // auto-start signal rides along

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test.describe("Capturar todo — profile-level batch button (issue #556)", () => {
  // Force a KNOWN, hermetic staleness state for profile A regardless of what
  // earlier tests in this file did: idealista's FIRST task freshly run (muted
  // / not ticked by default), every other idealista + aliseda task forced
  // stale (30 days old → due / ticked by default, same as never-run).
  async function forceState(profileId: number, taskIds: string[], daysAgo: number | null): Promise<void> {
    for (const taskId of taskIds) {
      const at = daysAgo === null ? "NOW()" : `NOW() - INTERVAL '${daysAgo} days'`;
      await pool.query(
        `INSERT INTO capture_task_run (profile_id, task_id, last_run_at)
         VALUES ($1, $2, ${at})
         ON CONFLICT (profile_id, task_id) DO UPDATE SET last_run_at = ${at}`,
        [profileId, taskId],
      );
    }
  }

  async function expandIfCollapsed(page: import("@playwright/test").Page, testId: string): Promise<void> {
    const el = page.getByTestId(testId);
    if ((await el.getAttribute("data-expanded")) === "false") {
      await page.getByTestId(testId.replace("captura-connector-", "captura-connector-toggle-")).click();
      await expect(el).toHaveAttribute("data-expanded", "true");
    }
  }

  test("default tick state mirrors due-ness; select-all/none; the count label; nothing ticked mutates nothing; a multi-task click opens ONE tab and records every ticked run", async ({
    page,
  }) => {
    const aIdealista = await idealistaTaskIds(page, profileAId!);
    const aAliseda = await alisedaTaskIds(page, profileAId!);
    expect(aIdealista.length).toBeGreaterThanOrEqual(2);
    expect(aAliseda.length).toBeGreaterThanOrEqual(1);

    await forceState(profileAId!, [aIdealista[0]], 0); // freshly run → muted / unticked
    await forceState(profileAId!, [...aIdealista.slice(1), ...aAliseda], 30); // stale → due / ticked

    await page.goto("/captura");
    await expect(page.getByTestId("captura-page")).toBeVisible();

    await expandIfCollapsed(page, `captura-connector-${profileAId}-idealista`);
    await expandIfCollapsed(page, `captura-connector-${profileAId}-aliseda`);

    // Default ticks: due tasks checked, the freshly-run one unchecked.
    await expect(page.getByTestId(`captura-task-check-${aIdealista[0]}`)).not.toBeChecked();
    for (const id of [...aIdealista.slice(1), ...aAliseda]) {
      await expect(page.getByTestId(`captura-task-check-${id}`)).toBeChecked();
    }
    const totalTasks = aIdealista.length + aAliseda.length;
    const dueCount = totalTasks - 1;
    const batchBtn = page.getByTestId(`captura-batch-run-${profileAId}`);
    await expect(batchBtn).toHaveText(`Capturar ${dueCount} tareas`);

    // Select-all → every task ticked, count == total.
    await page.getByTestId(`captura-batch-select-all-${profileAId}`).click();
    await expect(batchBtn).toHaveText(`Capturar ${totalTasks} tareas`);
    await expect(page.getByTestId(`captura-task-check-${aIdealista[0]}`)).toBeChecked();

    // Select-none → nothing ticked, count == 0.
    await page.getByTestId(`captura-batch-select-none-${profileAId}`).click();
    await expect(batchBtn).toHaveText("Capturar 0 tareas");

    // Nothing ticked → clicking Capturar todo shows a message and mutates nothing.
    const before = await lastRunAts(pool, profileAId!, [aIdealista[0], aIdealista[1]]);
    await batchBtn.click();
    await expect(page.getByTestId(`captura-batch-status-${profileAId}`)).toContainText(
      "No has marcado ninguna tarea",
    );
    const openedBeforeAny = await page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened.length,
    );
    const after = await lastRunAts(pool, profileAId!, [aIdealista[0], aIdealista[1]]);
    expect(after).toEqual(before); // no DB mutation

    // Tick exactly two idealista tasks (the muted one + one due one), leave
    // everything else untouched, then fire the batch.
    await page.getByTestId(`captura-task-check-${aIdealista[0]}`).click();
    await page.getByTestId(`captura-task-check-${aIdealista[1]}`).click();
    await expect(batchBtn).toHaveText("Capturar 2 tareas");

    await batchBtn.click();

    // Exactly ONE new tab opened — never one per ticked task.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.length))
      .toBe(openedBeforeAny + 1);
    const opened = await page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened.at(-1)!,
    );
    const u = new URL(opened);
    // D-113 review B2: the queue payload rides in the FRAGMENT (never sent to
    // the portal server); the auto-start signal falls back to the QUERY since
    // the fragment slot is taken.
    expect(u.hash.startsWith("#inmo-capture-queue=")).toBe(true);
    expect(u.searchParams.has("inmo-capture-queue")).toBe(false); // never in the query string
    expect(u.searchParams.get("inmo-capture")).toBe("1");
    const decodedQueue = JSON.parse(decodeURIComponent(u.hash.slice("#inmo-capture-queue=".length)));
    expect(decodedQueue).toHaveLength(1); // exactly the second ticked task

    // Both ticked tasks recorded a fresh capture_task_run — the ledger write
    // the single-task path already does, per taskId.
    await expect
      .poll(async () => {
        const [r0, r1] = await lastRunAts(pool, profileAId!, [aIdealista[0], aIdealista[1]]);
        return (
          r0 !== null &&
          r1 !== null &&
          r0.getTime() > (before[0]?.getTime() ?? 0) &&
          r1.getTime() > (before[1]?.getTime() ?? 0)
        );
      })
      .toBe(true);

    // No error surface — the D-041 bar.
    await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
    await expect(page.getByText("Error al cargar")).toHaveCount(0);
    await expect(page.getByText("HTTP 500")).toHaveCount(0);
  });
});
