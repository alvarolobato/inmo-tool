/**
 * E2E: connector management page (issue #100).
 *
 * The owner's actual ask behind this feature was "where do I manage the
 * connectors? they should all be disabled until I define the search
 * filters, I don't want it loading the whole site." So the load-bearing
 * test here is not "a checkbox saves" — it's that toggling a connector off
 * in the UI genuinely stops the ETL from running it. That assertion
 * inspects exactly what `etl/orchestrator.py::_scopes_for_connector` reads
 * (`connector_config.enabled`), which is the same row the orchestrator
 * consults before ever deriving a scope or calling discover().
 *
 * This page is admin-gated (middleware.ts `/etl/:path*` + `/api/etl/:path*`),
 * so the test sets the `ps_admin` session cookie the same way /admin/login
 * does. Requires ADMIN_API_KEY to be set for the server under test, and a
 * reachable Postgres — skips cleanly otherwise, matching the other specs.
 */
import { test, expect } from "@playwright/test";
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

const CONNECTOR = "e2e-conn-fotocasa";
const CAPTURE_ONLY = "e2e-conn-captureonly";
const PROFILE_NAME = "e2e-connectors-profile";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[connectors.spec] Postgres unreachable — skipping");
    return;
  }

  await pool.query("DELETE FROM connector_freshness_state WHERE connector_name = ANY($1)", [
    [CONNECTOR, CAPTURE_ONLY],
  ]);
  await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1)", [
    [CONNECTOR, CAPTURE_ONLY],
  ]);
  await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1)", [
    [CONNECTOR, CAPTURE_ONLY],
  ]);
  await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);

  // Stand in for what etl/main.py publishes at startup via
  // orchestrator.sync_connector_registry().
  // CONNECTOR is a tunable HTTP connector: it publishes a grammar, advertises a
  // pinnable host, and (issue #513) its discover() consumes the pin — so it must
  // show the grammar / preview / pin capability badges. CAPTURE_ONLY has none of
  // those (no discovery) → "captura extensión".
  await pool.query(
    `INSERT INTO connector_registry
       (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
        supports_discovery, supported_filters,
        override_host_suffix, supports_search_override, search_url_grammar)
     VALUES ($1, true, 20, false, true, '["rooms"]'::jsonb,
             'fotocasa.es', true,
             '{"build_template":"https://www.fotocasa.es/x-{geography}/","parse_pattern":"^https?://(?:www\\.)?fotocasa\\.es/x-(?<geography>[^/]+)/$","params":{"geography":{"label":"Municipio","source":"profile"}}}'::jsonb),
            ($2, true, 20, false, false, '[]'::jsonb,
             NULL, false, NULL)`,
    [CONNECTOR, CAPTURE_ONLY],
  );

  // Freshness cadence state (issue #295, D-050): CONNECTOR is fresh (last cycle
  // 1h ago, no cycle in progress); CAPTURE_ONLY is mid-cycle (started 1h ago) so
  // the page renders both a "fresco" and a "refrescando…" state — the two states
  // EC-5/EC-6 require, with no error surface.
  await pool.query(
    `INSERT INTO connector_freshness_state
        (connector_name, last_fresh_at, cycle_started_at, cycle_target_scope_count)
     VALUES ($1, NOW() - interval '1 hour', NULL, NULL),
            ($2, NULL, NOW() - interval '1 hour', 3)`,
    [CONNECTOR, CAPTURE_ONLY],
  );

  // One active profile, so the connector has a profile-derived default
  // scope to display (and to be visibly overridden later).
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
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM connector_freshness_state WHERE connector_name = ANY($1)", [
      [CONNECTOR, CAPTURE_ONLY],
    ]);
    await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1)", [
      [CONNECTOR, CAPTURE_ONLY],
    ]);
    await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1)", [
      [CONNECTOR, CAPTURE_ONLY],
    ]);
    await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);
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

test("lists registered connectors with no error surface", async ({ page }) => {
  await page.goto("/etl/connectors");
  await expect(page.getByTestId("connectors-page")).toBeVisible();
  await expect(page.getByTestId(`connector-${CONNECTOR}`)).toBeVisible();
  await expect(page.getByTestId(`connector-${CAPTURE_ONLY}`)).toBeVisible();

  // No error surface — the bar every user-facing page in this repo is held to.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);

  // A connector with no config row shows as enabled-by-default, which is
  // exactly what the ETL does with a missing row (issue #71's default).
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("activo");
});

test("capability badges distinguish a tunable connector from a capture-only one (issue #513)", async ({
  page,
}) => {
  await page.goto("/etl/connectors");
  await expect(page.getByTestId("connectors-page")).toBeVisible();

  // The tunable HTTP connector advertises grammar + preview + pin, and is NOT
  // "filtrado por datos".
  const tunableCaps = page.getByTestId(`capabilities-${CONNECTOR}`);
  await expect(tunableCaps).toBeVisible();
  await expect(tunableCaps.locator('[data-capability="grammar"]')).toBeVisible();
  await expect(tunableCaps.locator('[data-capability="preview"]')).toBeVisible();
  await expect(tunableCaps.locator('[data-capability="pin"]')).toBeVisible();
  await expect(tunableCaps.locator('[data-capability="data-filter"]')).toHaveCount(0);

  // The capture-only connector advertises "captura extensión" and no preview.
  const captureCaps = page.getByTestId(`capabilities-${CAPTURE_ONLY}`);
  await expect(captureCaps.locator('[data-capability="harvest"]')).toBeVisible();
  await expect(captureCaps.locator('[data-capability="preview"]')).toHaveCount(0);

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("rows are compact by default and expand on click to reveal detail (issue #264)", async ({
  page,
}) => {
  await page.goto("/etl/connectors");
  await expect(page.getByTestId("connectors-page")).toBeVisible();

  const card = page.getByTestId(`connector-${CONNECTOR}`);
  await expect(card).toBeVisible();

  // Collapsed by default: the full detail region is not rendered, so the list
  // stays skimmable (the whole point of #264).
  await expect(page.getByTestId(`connector-detail-${CONNECTOR}`)).toHaveCount(0);
  await expect(page.getByTestId(`expand-${CONNECTOR}`)).toHaveAttribute("aria-expanded", "false");

  // Expanding one row reveals its configuration without navigating away.
  await page.getByTestId(`expand-${CONNECTOR}`).click();
  await expect(page.getByTestId(`expand-${CONNECTOR}`)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId(`connector-detail-${CONNECTOR}`)).toBeVisible();
  await expect(card.getByTestId("scope-summary")).toBeVisible();

  // Still no error surface after the interaction.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);

  // And it collapses again on a second click.
  await page.getByTestId(`expand-${CONNECTOR}`).click();
  await expect(page.getByTestId(`connector-detail-${CONNECTOR}`)).toHaveCount(0);
});

test("shows which active profiles the default scope derives from", async ({ page }) => {
  await page.goto("/etl/connectors");
  const card = page.getByTestId(`connector-${CONNECTOR}`);
  // Scope detail now lives behind the chevron (issue #264) — expand first.
  await card.getByTestId(`expand-${CONNECTOR}`).click();
  // The visibility gap issue #96 was about: an operator could not see what
  // "derived from profiles" actually resolved to without reading ETL logs.
  await expect(card.getByTestId("scope-summary")).toContainText(PROFILE_NAME);
  // And the whole-city caveat is stated before anything is enabled.
  await expect(page.getByTestId(`whole-city-warning-${CONNECTOR}`)).toContainText("ciudad completa");
});

test("a capture-only connector offers no scope or filter controls", async ({ page }) => {
  await page.goto("/etl/connectors");
  const card = page.getByTestId(`connector-${CAPTURE_ONLY}`);
  // Expand to reach the detail region (issue #264).
  await card.getByTestId(`expand-${CAPTURE_ONLY}`).click();
  await expect(card.getByTestId("scope-summary")).toContainText("Solo captura");
  // Controls that could never take effect must not be rendered at all.
  await expect(page.getByTestId(`edit-scope-${CAPTURE_ONLY}`)).toHaveCount(0);
  await expect(page.getByTestId(`rooms-${CAPTURE_ONLY}`)).toHaveCount(0);
  await expect(page.getByTestId(`whole-city-warning-${CAPTURE_ONLY}`)).toHaveCount(0);
});

test("single toggle per connector — capture-only has no separate crawl button (issue #319)", async ({
  page,
}) => {
  await page.goto("/etl/connectors");
  await expect(page.getByTestId("connectors-page")).toBeVisible();

  // Both connector types expose exactly ONE Activar/Desactivar toggle.
  await expect(page.getByTestId(`toggle-${CONNECTOR}`)).toBeVisible();
  await expect(page.getByTestId(`toggle-${CAPTURE_ONLY}`)).toBeVisible();

  // The old two-toggle layout is gone: no separate crawl/capture button on
  // the capture-only connector — that confusion is exactly what #319 removed.
  await expect(page.getByTestId(`capture-toggle-${CAPTURE_ONLY}`)).toHaveCount(0);
  await expect(page.getByTestId(`capture-status-${CAPTURE_ONLY}`)).toHaveCount(0);

  // A capture-only connector with no config row reads as active (its
  // capture_enabled default is TRUE) and keeps its descriptive badge.
  await expect(page.getByTestId(`status-${CAPTURE_ONLY}`)).toContainText("activo");
  await expect(page.getByTestId(`connector-${CAPTURE_ONLY}`).getByText("solo captura")).toBeVisible();

  // No error surface — the D-041 bar for a user-facing dashboard surface.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("the capture-only toggle writes capture_enabled, leaving the crawl flag alone (issue #319)", async ({
  page,
}) => {
  await page.goto("/etl/connectors");

  // No config row yet → capture-only reads as active by default.
  await expect(page.getByTestId(`status-${CAPTURE_ONLY}`)).toContainText("activo");

  await page.getByTestId(`toggle-${CAPTURE_ONLY}`).click();
  await expect(page.getByTestId(`status-${CAPTURE_ONLY}`)).toContainText("desactivado");

  // The load-bearing assertion: the single toggle wrote capture_enabled (the
  // knob the capture poller reads), NOT the crawl `enabled` flag.
  const row = await pool.query(
    "SELECT enabled, capture_enabled FROM connector_config WHERE connector_name = $1",
    [CAPTURE_ONLY],
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].capture_enabled).toBe(false);

  // Survives a reload, and re-enabling is symmetric.
  await page.reload();
  await expect(page.getByTestId(`status-${CAPTURE_ONLY}`)).toContainText("desactivado");
  await page.getByTestId(`toggle-${CAPTURE_ONLY}`).click();
  await expect(page.getByTestId(`status-${CAPTURE_ONLY}`)).toContainText("activo");
  const reEnabled = await pool.query(
    "SELECT capture_enabled FROM connector_config WHERE connector_name = $1",
    [CAPTURE_ONLY],
  );
  expect(reEnabled.rows[0].capture_enabled).toBe(true);
});

test("disabling a connector in the UI actually stops the ETL running it", async ({ page }) => {
  await page.goto("/etl/connectors");

  // Precondition: nothing stored yet, so the ETL would run it (no row =
  // issue #71's default = enabled).
  const before = await pool.query("SELECT enabled FROM connector_config WHERE connector_name = $1", [
    CONNECTOR,
  ]);
  expect(before.rowCount).toBe(0);

  await page.getByTestId(`toggle-${CONNECTOR}`).click();
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("desactivado");

  // The load-bearing assertion: the row the orchestrator actually reads
  // (etl/orchestrator.py::_scopes_for_connector) now says disabled, so the
  // connector is skipped entirely before any scope is derived or discover()
  // is called. Not "the API returned 200".
  const after = await pool.query("SELECT enabled FROM connector_config WHERE connector_name = $1", [
    CONNECTOR,
  ]);
  expect(after.rowCount).toBe(1);
  expect(after.rows[0].enabled).toBe(false);

  // And it survives a reload rather than being optimistic-only UI state.
  await page.reload();
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("desactivado");

  // Re-enabling works symmetrically.
  await page.getByTestId(`toggle-${CONNECTOR}`).click();
  await expect(page.getByTestId(`status-${CONNECTOR}`)).toContainText("activo");
  const reEnabled = await pool.query(
    "SELECT enabled FROM connector_config WHERE connector_name = $1",
    [CONNECTOR],
  );
  expect(reEnabled.rows[0].enabled).toBe(true);
});

test("saving a rooms filter persists exactly what the ETL will read", async ({ page }) => {
  await page.goto("/etl/connectors");

  // The rooms filter lives in the expanded detail (issue #264).
  await page.getByTestId(`expand-${CONNECTOR}`).click();
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

  // Clearing the field removes the filter rather than persisting rooms=0
  // (`Number("") === 0` — the coercion bug class fixed in PR #103).
  await page.getByTestId(`rooms-${CONNECTOR}`).fill("");
  await page.getByTestId(`save-rooms-${CONNECTOR}`).click();

  await expect
    .poll(async () => {
      const r = await pool.query("SELECT filters FROM connector_config WHERE connector_name = $1", [
        CONNECTOR,
      ]);
      return r.rows[0]?.filters?.rooms ?? "absent";
    })
    .toBe("absent");
});

test("shows freshness state and accepts an interval override (issue #295, EC-5)", async ({
  page,
}) => {
  await page.goto("/etl/connectors");
  await expect(page.getByTestId("connectors-page")).toBeVisible();

  // The seeded fresh connector reports "fresco" behind the chevron.
  await page.getByTestId(`expand-${CONNECTOR}`).click();
  await expect(page.getByTestId(`freshness-state-${CONNECTOR}`)).toContainText("fresco");

  // The mid-cycle capture-only connector reports "refrescando…".
  await page.getByTestId(`expand-${CAPTURE_ONLY}`).click();
  await expect(page.getByTestId(`freshness-state-${CAPTURE_ONLY}`)).toContainText(
    "refrescando",
  );

  // Set a per-connector "frescura deseada" value — it must land in the exact
  // column the ETL reads (connector_config.freshness_interval_hours), not just
  // return 200.
  await page
    .getByTestId(`freshness-interval-${CONNECTOR}`)
    .selectOption("6");
  await expect
    .poll(async () => {
      const r = await pool.query(
        "SELECT freshness_interval_hours FROM connector_config WHERE connector_name = $1",
        [CONNECTOR],
      );
      return r.rows[0]?.freshness_interval_hours ?? null;
    })
    .toBe(6);

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("no error surface with an active or stuck cycle (issue #295, EC-6)", async ({ page }) => {
  await page.goto("/etl/connectors");
  await expect(page.getByTestId("connectors-page")).toBeVisible();

  // Both seeded connectors render real content (their identity rows), one
  // fresh and one mid-cycle, with no error surface anywhere on the page.
  await expect(page.getByTestId(`connector-${CONNECTOR}`)).toBeVisible();
  await expect(page.getByTestId(`connector-${CAPTURE_ONLY}`)).toBeVisible();

  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
