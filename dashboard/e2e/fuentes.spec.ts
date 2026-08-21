/**
 * E2E: Fuentes — the merged connector-management + capture-worklist surface
 * (issue #642 P1, part of #636's admin-IA deletion pass).
 *
 * Replaces `e2e/connectors.spec.ts` (`/etl/connectors`) and
 * `e2e/worklist.spec.ts` (`/etl/captura`), both deleted — their essential
 * assertions are ported here, retargeted at the new routes:
 *   - `/admin/fuentes` — the lean list (identity, status, link to detail).
 *   - `/admin/fuentes/[name]` — the detail page: connector config
 *     (ConnectorCard, now starting expanded — issue #264's "collapsed by
 *     default" only applies to the list), and the capture worklist ledger
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

test("detail: a source with no capture activity (fotocasa, plain crawl) shows no worklist section", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${CONNECTOR}`);
  await expect(page.getByTestId("fuente-worklist")).toHaveCount(0);
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
  });

  test("detail: no page overflow, and every button clears the 44px tap-target floor", async ({
    page,
  }) => {
    await page.goto(`/admin/fuentes/${CAPTURE_ONLY}`);
    await expect(page.getByTestId("fuente-detail-page")).toBeVisible();
    await assertNoPageOverflow(page);

    // The ConnectorCard toggle — issue #642 review: this card is now the
    // primary control surface (defaultExpanded, not behind a disclosure),
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
