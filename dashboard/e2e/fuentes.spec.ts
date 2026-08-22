/**
 * E2E: Fuentes — the merged connector-management + capture-worklist surface
 * (issue #642 P1, part of #636's admin-IA deletion pass).
 *
 * Replaces `e2e/connectors.spec.ts` (`/etl/connectors`) and
 * `e2e/worklist.spec.ts` (`/etl/captura`), both deleted — their essential
 * assertions are ported here, retargeted at the new routes:
 *   - `/admin/fuentes` — the lean list (identity, status, link to detail).
 *   - `/admin/fuentes/[name]` — the detail page: connector config
 *     (ConnectorCard, which now renders expanded — issue #264's
 *     "collapsed by default" served the `/etl/connectors` list this phase
 *     deletes), and the capture worklist ledger
 *     scoped to this one portal (no portal picker needed — the route param
 *     IS the scope).
 *
 * This is #642's EC-2 capability-parity spec: every control on the old
 * `/etl/connectors` AND `/etl/captura` (including paste-seeding and
 * skip/reactivate) must be reachable here.
 *
 * Admin-gated (middleware.ts gates every UI page), so tests set the
 * `ps_admin` session cookie the way `/admin/login` does. Requires
 * `ADMIN_API_KEY` for the server under test and a reachable Postgres — skips
 * cleanly otherwise, matching the other admin specs.
 */
import { test, expect, devices } from "@playwright/test";
import { Pool } from "pg";

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

const CONNECTOR = "e2e-fuentes-fotocasa";
// MUST be a real CAPTURE_PORTAL_NAMES entry, not a synthetic name: the
// worklist section's `showWorklist` gate (and `lib/db/worklist.ts`'s
// `listWorklist`/`addWorklistUrls`, which filter/resolve strictly against
// `CAPTURE_PORTAL_NAMES`/`portalForUrl`) never surface a portal it doesn't
// recognize — a synthetic "e2e-fuentes-aliseda" name silently renders NO
// worklist section at all (caught by this spec's own first run: every
// worklist-scoped test failed with "element not found", not a crash).
// Mirrors freshness-indicator.spec.ts's same real-portal-name constraint —
// this spec owns EVERY precondition (registry, config, freshness state) via
// save/restore rather than blind delete, exactly like that file, since
// "aliseda" may already carry real state on a shared/demo DB.
const CAPTURE_ONLY = "aliseda";
const PROFILE_NAME = "e2e-fuentes-profile";

// Real capture_worklist rows against aliseda's real host, so
// `portalForUrl`/`listWorklist` resolve them (issue #237/#454's own
// filtering — a fabricated host is invisible to both).
const SEED = [
  { path: "/inmueble/E2E-FUENTES-PENDING", status: "pending" },
  { path: "/inmueble/E2E-FUENTES-CAPTURED", status: "captured" },
  { path: "/inmueble/E2E-FUENTES-FAILED", status: "failed" },
];
const ADD_URL = "https://www.alisedainmobiliaria.com/inmueble/E2E-FUENTES-ADDED";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();
const seededWorklistIds: number[] = [];

let priorRegistry: { registered: boolean; supports_discovery: boolean } | null = null;
let hadRegistryRow = false;
let priorConfig: { enabled: boolean; capture_enabled: boolean | null } | null = null;
let hadConfigRow = false;

async function purgeWorklist(): Promise<void> {
  await pool.query("DELETE FROM capture_worklist WHERE url LIKE '%E2E-FUENTES-%'");
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[fuentes.spec] Postgres unreachable — skipping");
    return;
  }

  await pool.query("DELETE FROM connector_freshness_state WHERE connector_name = $1", [CONNECTOR]);
  await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [CONNECTOR]);
  await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CONNECTOR]);
  await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);

  // Save aliseda's prior registry/config state (own every precondition,
  // restore in afterAll — freshness-indicator.spec.ts's own pattern).
  const reg = await pool.query<{ registered: boolean; supports_discovery: boolean }>(
    "SELECT registered, supports_discovery FROM connector_registry WHERE connector_name = $1",
    [CAPTURE_ONLY],
  );
  hadRegistryRow = reg.rows.length > 0;
  priorRegistry = reg.rows[0] ?? null;
  const cfg = await pool.query<{ enabled: boolean; capture_enabled: boolean | null }>(
    "SELECT enabled, capture_enabled FROM connector_config WHERE connector_name = $1",
    [CAPTURE_ONLY],
  );
  hadConfigRow = cfg.rows.length > 0;
  priorConfig = cfg.rows[0] ?? null;

  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters)
     VALUES ($1, true, 20, false, true, '["rooms"]'::jsonb)`,
    [CONNECTOR],
  );
  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters)
     VALUES ($1, true, 12, false, false, '[]'::jsonb)
     ON CONFLICT (connector_name) DO UPDATE
        SET registered = true, supports_discovery = false`,
    [CAPTURE_ONLY],
  );
  // Deterministic starting toggle state for the "toggling persists" test.
  await pool.query(
    `INSERT INTO connector_config (connector_name, enabled, capture_enabled)
     VALUES ($1, true, true)
     ON CONFLICT (connector_name) DO UPDATE SET capture_enabled = true`,
    [CAPTURE_ONLY],
  );

  await pool.query(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb)`,
    [
      PROFILE_NAME,
      JSON.stringify({
        geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
        property_types: ["piso"],
      }),
    ],
  );

  await purgeWorklist();
  for (const { path, status } of SEED) {
    const url = `https://www.alisedainmobiliaria.com${path}`;
    const matchKey = `alisedainmobiliaria.com${path}`;
    const res = await pool.query<{ id: number }>(
      `INSERT INTO capture_worklist (url, match_key, source_portal, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [url, matchKey, CAPTURE_ONLY, status],
    );
    seededWorklistIds.push(res.rows[0].id);
  }
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM connector_freshness_state WHERE connector_name = $1", [CONNECTOR]);
    await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [CONNECTOR]);
    await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CONNECTOR]);
    await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);
    await purgeWorklist();

    // Restore aliseda's prior state rather than deleting it outright — it
    // may be a real, live connector on the DB under test.
    if (hadConfigRow && priorConfig) {
      await pool.query(
        "UPDATE connector_config SET enabled = $2, capture_enabled = $3 WHERE connector_name = $1",
        [CAPTURE_ONLY, priorConfig.enabled, priorConfig.capture_enabled],
      );
    } else {
      await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [CAPTURE_ONLY]);
    }
    if (hadRegistryRow && priorRegistry) {
      await pool.query(
        "UPDATE connector_registry SET registered = $2, supports_discovery = $3 WHERE connector_name = $1",
        [CAPTURE_ONLY, priorRegistry.registered, priorRegistry.supports_discovery],
      );
    } else {
      await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CAPTURE_ONLY]);
    }
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("list: shows both sources with no error surface, and links to their detail pages", async ({
  page,
}) => {
  await page.goto("/admin/fuentes");
  await expect(page.getByTestId("fuentes-page")).toBeVisible();
  await expect(page.getByTestId(`fuente-row-${CONNECTOR}`)).toBeVisible();
  await expect(page.getByTestId(`fuente-row-${CAPTURE_ONLY}`)).toBeVisible();
  await expect(page.getByTestId(`fuente-status-${CONNECTOR}`)).toContainText("activo");

  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);

  await page.getByTestId(`fuente-row-${CONNECTOR}`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/fuentes/${CONNECTOR}$`));
  await expect(page.getByTestId("fuente-detail-page")).toBeVisible();
});

/**
 * The queue-depth column (issue #642 P1 review). `/etl/captura`'s all-portals
 * view is gone and #640's Estado tile doesn't exist yet, so without this the
 * only way to answer "¿se atascó algo esta noche?" is opening every source in
 * turn. The number comes off the SAME unscoped worklist roll-up the list
 * already fetches — no new endpoint, no new computation.
 */
test("list: a capture source shows its queue depth; a drained/plain one shows none", async ({
  page,
}) => {
  await page.goto("/admin/fuentes");
  await expect(page.getByTestId("fuentes-page")).toBeVisible();

  // Counts are asserted against the API's OWN roll-up rather than a literal:
  // this spec seeds >=1 pending and >=1 failed aliseda row, but aliseda may
  // already carry real rows on a shared/demo DB (see CAPTURE_ONLY's note), so
  // the invariant worth pinning is "the chip shows what the roll-up says".
  const roll = await page.request.get("/api/etl/worklist");
  const summary = ((await roll.json()).summaries ?? []).find(
    (x: { source_portal: string }) => x.source_portal === CAPTURE_ONLY,
  );
  expect(summary, "the spec's own seed guarantees an aliseda roll-up").toBeTruthy();
  expect(summary.pending).toBeGreaterThanOrEqual(1);
  expect(summary.failed).toBeGreaterThanOrEqual(1);

  const chip = page.getByTestId(`fuente-queue-${CAPTURE_ONLY}`);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-pending", String(summary.pending));
  await expect(chip).toHaveAttribute("data-failed", String(summary.failed));
  await expect(chip).toContainText(`${summary.pending} en cola`);

  // A plain crawl connector has no capture queue at all — no chip, not a "0".
  await expect(page.getByTestId(`fuente-queue-${CONNECTOR}`)).toHaveCount(0);

  // The header cross-link, repointed by #642 P2: `/etl` is gone, and the run
  // history it offered is Actividad's now.
  await expect(page.getByTestId("fuentes-to-actividad")).toHaveAttribute(
    "href",
    "/admin/actividad",
  );
  await expect(page.getByTestId("fuentes-to-monitor")).toHaveCount(0);

  // #642 P2: the list row shows DERIVED freshness, not the last run's outcome.
  // Before P2 the same run outcome appeared here, on the detail card and on
  // Actividad's newest crawl row — three copies. #636's verdict picks which
  // to drop: run outcome is the explanation, never the headline, and it is
  // structurally blind to capture-only portals, which produce no run at all.
  const activity = page.getByTestId(`fuente-activity-${CONNECTOR}`);
  await expect(activity).toBeVisible();
  await expect(activity).toContainText("en 24h");
  await expect(activity).not.toContainText("descargados");
  await expect(page.getByTestId(`fuente-lastrun-${CONNECTOR}`)).toHaveCount(0);
});

test("list: the global 'Ejecutar todo ahora' sweep lives here (#642 P2)", async ({ page }) => {
  // The one control `/etl` owned that had no home anywhere else. Deleting it
  // would have been a capability loss, which #642's own constraints forbid.
  // The trigger-row contract is asserted in e2e/run-now.spec.ts; this just
  // pins that the affordance is on the list, and tappable on a phone.
  await page.goto("/admin/fuentes");
  const btn = page.getByTestId("run-now-all");
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("detail: connector config starts expanded (no click needed), shows scope + freshness", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await expect(page.getByTestId("fuente-detail-page")).toBeVisible();
  await expect(page.getByTestId(`connector-${CONNECTOR}`)).toBeVisible();

  // No expand click: the detail region is already visible (a single-source
  // page has nothing left to collapse behind).
  await expect(page.getByTestId(`connector-detail-${CONNECTOR}`)).toBeVisible();
  await expect(page.getByTestId("scope-summary")).toContainText(PROFILE_NAME);
  await expect(page.getByTestId(`freshness-interval-${CONNECTOR}`)).toBeVisible();

  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

test("detail: a capture-only source shows no scope/rooms controls and the 'solo captura' note", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
  await expect(page.getByTestId(`connector-${CAPTURE_ONLY}`)).toBeVisible();
  await expect(page.getByTestId("scope-summary")).toContainText("Solo captura");
  await expect(page.getByTestId(`edit-scope-${CAPTURE_ONLY}`)).toHaveCount(0);
  await expect(page.getByTestId(`rooms-${CAPTURE_ONLY}`)).toHaveCount(0);
});

test("detail: toggling the single Activar/Desactivar switch persists (issue #319/#100 parity)", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("activo");

  await page.getByTestId(`toggle-${CONNECTOR}`).click();
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("desactivado");

  const after = await pool.query("SELECT enabled FROM connector_config WHERE connector_name = $1", [
    CONNECTOR,
  ]);
  expect(after.rows[0].enabled).toBe(false);

  await page.reload();
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("desactivado");
  await page.getByTestId(`toggle-${CONNECTOR}`).click();
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("activo");
});

test("detail: saving a rooms filter persists exactly what the ETL will read", async ({ page }) => {
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await page.getByTestId(`rooms-${CONNECTOR}`).fill("2");
  await page.getByTestId(`save-rooms-${CONNECTOR}`).click();

  await expect
    .poll(async () => {
      const r = await pool.query("SELECT filters FROM connector_config WHERE connector_name = $1", [
        CONNECTOR,
      ]);
      return r.rows[0]?.filters?.rooms ?? null;
    })
    .toBe(2);
});

test("detail: capture worklist ledger — seeded rows, statuses, and per-portal summary (issue #237/#260 parity)", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
  await expect(page.getByTestId("fuente-worklist")).toBeVisible();

  const [pendingId, capturedId, failedId] = seededWorklistIds;
  await expect(page.getByTestId(`worklist-row-${pendingId}`)).toBeVisible();
  await expect(page.getByTestId(`worklist-status-${pendingId}`)).toHaveText("Pendiente");
  await expect(page.getByTestId(`worklist-status-${capturedId}`)).toHaveText("Capturada");
  await expect(page.getByTestId(`worklist-status-${failedId}`)).toHaveText("Fallida");

  await expect(page.getByTestId(`worklist-open-${pendingId}`)).toHaveAttribute(
    "href",
    "https://www.alisedainmobiliaria.com/inmueble/E2E-FUENTES-PENDING",
  );

  const summary = page.getByTestId(`worklist-summary-${CAPTURE_ONLY}`);
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("capturadas");

  // Cross-link back to the execution page (D-045: setup lives here, execution
  // at /captura) — capability parity with the old ledger's framing.
  await expect(page.getByTestId("worklist-to-captura")).toHaveAttribute("href", "/captura");
  await expect(page.getByTestId(`worklist-portal-captura-${CAPTURE_ONLY}`)).toHaveAttribute(
    "href",
    "/captura",
  );

  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

/**
 * The regression this guards (issue #642 P1 review): `listWorklist(portal)`
 * scoped `rows` but not `summaries`, so a per-source page rendered EVERY
 * portal's progress card — and the new card had dropped the portal name, so
 * two bars showing different numbers sat on one source's page with nothing
 * distinguishing them. Wrong numbers under the wrong heading.
 *
 * Needs a SECOND capture portal carrying rows, so it seeds one (a real
 * `CAPTURE_PORTAL_NAMES` entry — `portalForUrl`/`listWorklist` ignore anything
 * else) and cleans it up. The `E2E-FUENTES-` marker keeps `purgeWorklist`'s
 * afterAll sweep covering it too.
 */
test("detail: the progress card is scoped to THIS portal and names it (no cross-portal leak)", async ({
  page,
}) => {
  const otherUrl = "https://www.idealista.com/inmueble/E2E-FUENTES-OTHER-PORTAL/";
  await pool.query(
    `INSERT INTO capture_worklist (url, match_key, source_portal, status)
     VALUES ($1, $2, $3, 'pending')`,
    [otherUrl, "idealista.com/inmueble/E2E-FUENTES-OTHER-PORTAL", "idealista"],
  );
  try {
    // Precondition: the other portal really is in the global roll-up, so a
    // leak would be observable.
    const global = await page.request.get("/api/etl/worklist");
    const globalPortals = ((await global.json()).summaries ?? []).map(
      (s: { source_portal: string }) => s.source_portal,
    );
    expect(globalPortals).toContain("idealista");
    expect(globalPortals).toContain(CAPTURE_ONLY);

    // The scoped read returns ONLY this portal's roll-up.
    const scoped = await page.request.get(`/api/etl/worklist?portal=${CAPTURE_ONLY}`);
    const scopedSummaries = (await scoped.json()).summaries ?? [];
    expect(scopedSummaries.map((s: { source_portal: string }) => s.source_portal)).toEqual([
      CAPTURE_ONLY,
    ]);

    // ...and the page renders exactly one card, for this portal, NAMED.
    await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
    await expect(page.getByTestId("fuente-worklist")).toBeVisible();
    await expect(page.getByTestId(`worklist-summary-${CAPTURE_ONLY}`)).toBeVisible();
    await expect(page.getByTestId("worklist-summary-idealista")).toHaveCount(0);
    await expect(page.locator('[data-testid^="worklist-summary-"]')).toHaveCount(1);
    await expect(page.getByTestId(`worklist-summary-${CAPTURE_ONLY}`)).toContainText(CAPTURE_ONLY);

    // The bar carries the portal in its accessible name — an unlabelled
    // progress bar is what made the leak dangerous rather than just noisy.
    const bar = page.getByTestId(`worklist-progress-${CAPTURE_ONLY}`);
    await expect(bar).toHaveAttribute("aria-label", new RegExp(`^${CAPTURE_ONLY}: \\d+% capturadas$`));
  } finally {
    await pool.query("DELETE FROM capture_worklist WHERE url = $1", [otherUrl]);
  }
});

test("detail: status filter tabs scope the ledger to one status", async ({ page }) => {
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
  const [pendingId, capturedId, failedId] = seededWorklistIds;

  await page.getByTestId("worklist-filter-captured").click();
  await expect(page.getByTestId(`worklist-row-${capturedId}`)).toBeVisible();
  await expect(page.getByTestId(`worklist-row-${pendingId}`)).toHaveCount(0);
  await expect(page.getByTestId(`worklist-row-${failedId}`)).toHaveCount(0);

  await page.getByTestId("worklist-filter-all").click();
  await expect(page.getByTestId(`worklist-row-${pendingId}`)).toBeVisible();
  await expect(page.getByTestId(`worklist-row-${failedId}`)).toBeVisible();
});

test("detail: ?status= deep-link preset (portal comes from the route, not a query param)", async ({
  page,
}) => {
  const [, capturedId, failedId] = seededWorklistIds;
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}?status=captured`);
  await expect(page.getByTestId(`worklist-filter-captured`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId(`worklist-row-${capturedId}`)).toBeVisible();
  await expect(page.getByTestId(`worklist-row-${failedId}`)).toHaveCount(0);
});

test("detail: the manual-fallback 'Siguiente pendiente' button targets a pending URL (D-043 parity)", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
  const nextBtn = page.getByTestId("worklist-open-next");
  await expect(nextBtn).toBeVisible();
  await expect(nextBtn).toBeEnabled();
});

test("detail: manual paste adds a new URL to this source's worklist (paste-seeding parity, EC-2)", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
  await page.getByTestId("worklist-paste").fill(ADD_URL);
  await page.getByTestId("worklist-add-btn").click();

  await expect(page.getByTestId("worklist-add-result")).toContainText("añadida");
  await expect(page.getByRole("link", { name: ADD_URL })).toBeVisible();

  await expect
    .poll(async () => {
      const r = await pool.query(
        "SELECT status, added_via, source_portal FROM capture_worklist WHERE url = $1",
        [ADD_URL],
      );
      return r.rows[0] ? `${r.rows[0].status}/${r.rows[0].added_via}` : null;
    })
    .toBe("pending/manual");
});

test("detail: skip and reactivate a worklist row persist status (skip/reactivate parity, EC-2)", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
  const [pendingId] = seededWorklistIds;

  await page.getByTestId(`worklist-skip-${pendingId}`).click();
  await expect
    .poll(async () => {
      const r = await pool.query("SELECT status FROM capture_worklist WHERE id = $1", [pendingId]);
      return r.rows[0]?.status ?? null;
    })
    .toBe("skipped");

  await page.reload();
  await page.getByTestId(`worklist-reset-${pendingId}`).click();
  await expect
    .poll(async () => {
      const r = await pool.query("SELECT status FROM capture_worklist WHERE id = $1", [pendingId]);
      return r.rows[0]?.status ?? null;
    })
    .toBe("pending");
});

/**
 * An absence assertion is only worth anything if it can fail. `goto` +
 * `toHaveCount(0)` cannot: it resolves on the first poll, before
 * `fetchWorklist` returns, so it passes green on a page that renders the
 * section a moment later — which is exactly what the pre-fix build did (the
 * `showWorklist` gate read a globally-scoped `summaries`, so ANY capture
 * portal having a queue turned the whole Captura block on for every source).
 *
 * So: wait for a POSITIVE settle first — the page's own
 * `data-worklist-loaded` flag, which flips once the worklist fetch resolves
 * whether or not a section renders — and only then assert the absence. The
 * aliseda rows this spec seeds are still in `capture_worklist` at this point,
 * so the global-summaries regression would be live if it came back.
 */
test("detail: a source with no capture activity (fotocasa, plain crawl) shows no worklist section", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CONNECTOR}`);

  // Positive settle #1: the page itself rendered.
  await expect(page.getByTestId("fuente-detail-page")).toBeVisible();
  // Positive settle #2: the worklist fetch has RESOLVED. Without this the
  // assertion below is unfalsifiable.
  await expect(page.getByTestId("fuente-detail-page")).toHaveAttribute(
    "data-worklist-loaded",
    "true",
  );
  // Positive settle #3: a capture portal DOES have a queue right now, so the
  // old `|| summaries.length > 0` fallback would be true if it returned.
  const globalQueue = await page.request.get("/api/etl/worklist");
  expect(globalQueue.ok()).toBe(true);
  expect(((await globalQueue.json()).summaries ?? []).length).toBeGreaterThan(0);

  // Only now is the absence meaningful.
  await expect(page.getByTestId("fuente-worklist")).toHaveCount(0);
  await expect(page.getByTestId("worklist-open-next")).toHaveCount(0);
});

test.describe("phone width (iPhone 13 emulation, D-120/D-121/D-124)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!dbAvailable, "Postgres unavailable");
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await page.context().addCookies([
      { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
    ]);
  });

  /**
   * The real symptom of a page-level overflow bug (issue #606's class) is
   * the WHOLE PAGE needing horizontal scroll — `documentElement.scrollWidth
   * > clientWidth`. A naive "does any element's bounding rect extend past
   * the viewport" check (as used elsewhere in this repo, e.g.
   * `mobile-main-content-padding.spec.ts`) false-positives on legitimate
   * horizontally-scrollable regions: the worklist `<table>` here is
   * deliberately wider than its `overflowX: "auto"` wrapper (a table that
   * never needs its own scrollbar was never testing anything), and that
   * wrapper's own box correctly stays within the viewport — verified by
   * hand with a real browser before writing this assertion (see this PR's
   * body for the measurement), not assumed.
   */
  async function assertNoPageOverflow(page: import("@playwright/test").Page): Promise<void> {
    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth, "the whole page must not need horizontal scroll").toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }

  test("list: no page overflow, and rows are real tap targets", async ({ page }) => {
    await page.goto("/admin/fuentes");
    await expect(page.getByTestId("fuentes-page")).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(width, "sanity: this really is the mobile viewport").toBeLessThan(768);
    await assertNoPageOverflow(page);

    const row = page.getByTestId(`fuente-row-${CONNECTOR}`);
    const box = await row.boundingBox();
    expect(box!.height, "a list row is the whole tap target — must clear 44px").toBeGreaterThanOrEqual(44);

    // The queue-depth chip must not be what pushes a row past the viewport:
    // assertNoPageOverflow above already covers the page, so check the row's
    // own box stays inside it too (the chip is `flexShrink: 0`, so a
    // regression would show up here as a row wider than 390px).
    expect(box!.width).toBeLessThanOrEqual(390);
    await expect(page.getByTestId(`fuente-queue-${CAPTURE_ONLY}`)).toBeVisible();
    const chipBox = await page.getByTestId(`fuente-queue-${CAPTURE_ONLY}`).boundingBox();
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(390);
  });

  test("detail: no page overflow, and every button clears the 44px tap-target floor", async ({
    page,
  }) => {
    await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
    await expect(page.getByTestId("fuente-detail-page")).toBeVisible();
    await assertNoPageOverflow(page);

    // The ConnectorCard toggle — issue #642 review: this card is now the
    // primary control surface (rendered expanded, not behind a disclosure),
    // the exact class of 35-38px tap target #656 found in moved-verbatim
    // markup elsewhere. Caught and fixed here (ConnectorCard.tsx's shared
    // `buttonStyle`) before relocating, not after.
    const toggle = page.getByTestId(`toggle-${CAPTURE_ONLY}`);
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox!.height).toBeGreaterThanOrEqual(44);

    // The worklist ledger's own controls, moved from /etl/captura.
    for (const testid of ["worklist-open-next", "worklist-refresh", "worklist-add-btn"]) {
      const el = page.getByTestId(testid);
      const elBox = await el.boundingBox();
      expect(elBox!.height, testid).toBeGreaterThanOrEqual(44);
    }
    const [pendingId] = seededWorklistIds;
    const skipBox = await page.getByTestId(`worklist-skip-${pendingId}`).boundingBox();
    expect(skipBox!.height, "worklist-skip").toBeGreaterThanOrEqual(44);
  });
});

test("redirects: /etl/connectors and /etl/captura resolve to the new Fuentes surface (the #642 redirect trap — asserting the TARGET renders, not just that the old path 404s)", async ({
  page,
}) => {
  await page.goto("/etl/connectors");
  await expect(page).toHaveURL(/\/admin\/fuentes$/);
  await expect(page.getByTestId("fuentes-page")).toBeVisible();

  await page.goto(`/etl/captura?portal=${CAPTURE_ONLY}&status=pending`);
  // Next forwards the FULL original query string on a `redirects()` match,
  // including `portal=` itself (a `has` capture doesn't consume the param) —
  // verified with curl: destination is
  // `/admin/fuentes/<name>?portal=<name>&status=pending`, not just
  // `?status=pending`. The redundant `portal=` is harmless (nothing on the
  // page reads it — the route param IS the scope), but assert what the
  // server actually sends, not the tidier string it would be nice to see.
  await expect(page).toHaveURL(
    new RegExp(`/admin/fuentes/${CAPTURE_ONLY}\\?portal=${CAPTURE_ONLY}&status=pending$`),
  );
  await expect(page.getByTestId("fuente-detail-page")).toBeVisible();
  await expect(page.getByTestId(`worklist-filter-pending`)).toHaveAttribute("aria-pressed", "true");

  await page.goto("/etl/captura");
  await expect(page).toHaveURL(/\/admin\/fuentes$/);
  await expect(page.getByTestId("fuentes-page")).toBeVisible();
});
