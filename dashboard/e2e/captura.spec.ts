/**
 * E2E: /captura ⇄ /etl/captura reconciliation (issue #512, D-041).
 *
 * #512 makes the two capture screens' roles explicit and coherent:
 *   - /captura       = plan + launch (the TopBar surface capture runs from);
 *   - /etl/captura   = the admin "libro de capturas" ledger (observe + repair).
 *
 * This spec pins the two behaviours the issue's exit criteria call out:
 *   - EC-1: /captura no longer claims config lives in "Admin · Captura"; its
 *           pointers land on Conectores and the extension setup CTA.
 *   - EC-3: a per-connector queue chip on /captura deep-links to the ledger
 *           filtered to that portal's PENDING rows.
 *
 * Drives a real Next.js server against a real Postgres, seeding one search
 * profile (so its aliseda connector renders DUE → expanded, exposing the chip)
 * plus aliseda worklist rows (one pending, one captured) so the ledger filter is
 * observable. Admin-gated like every page; skips cleanly when Postgres is
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

const PROFILE = "E2E-CAP512";
const SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 10 },
  property_types: ["piso"],
  price_max: 300000,
};

// Aliseda worklist rows: one pending (must show under the ?status=pending
// deep-link) and one captured (must be filtered OUT by it).
const WL_SEED = [
  { path: "/inmueble/E2E-CAP512-PENDING", status: "pending" },
  { path: "/inmueble/E2E-CAP512-CAPTURED", status: "captured" },
];
const PENDING_URL = "https://www.alisedainmobiliaria.com/inmueble/E2E-CAP512-PENDING";
const CAPTURED_URL = "https://www.alisedainmobiliaria.com/inmueble/E2E-CAP512-CAPTURED";

let pool: Pool;
let dbAvailable = false;
let profileId: number | null = null;

async function purge(): Promise<void> {
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM search_profile WHERE name = $1",
    [PROFILE],
  );
  const ids = existing.rows.map((r) => r.id);
  if (profileId !== null && !ids.includes(profileId)) ids.push(profileId);
  for (const id of ids) {
    await pool.query("DELETE FROM capture_task_run WHERE profile_id = $1", [id]);
    for (const table of ["profile_listing_state", "feedback_event"]) {
      await pool.query(`DELETE FROM ${table} WHERE profile_id = $1`, [id]).catch(() => undefined);
    }
  }
  await pool.query("DELETE FROM capture_worklist WHERE url LIKE '%E2E-CAP512-%'");
  await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[captura.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [PROFILE, JSON.stringify(SCOPE)],
  );
  profileId = r.rows[0].id;

  for (const { path, status } of WL_SEED) {
    const url = `https://www.alisedainmobiliaria.com${path}`;
    await pool.query(
      `INSERT INTO capture_worklist (url, match_key, source_portal, status)
       VALUES ($1, $2, $3, $4)`,
      [url, `alisedainmobiliaria.com${path}`, "aliseda", status],
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
  await seedAdminSession(page, baseURL);
});

test("corrected pointers: /captura points at Conectores + the ledger, not 'Admin · Captura' for config", async ({
  page,
}) => {
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // The old, WRONG pointer is gone: it claimed connector/extension/key config
  // lived in Admin · Captura — none of it does.
  await expect(
    page.getByText("La configuración (extensión, clave, conectores) vive en"),
  ).toHaveCount(0);

  // Connector config now points at Conectores…
  const connectorsLink = page.getByTestId("captura-to-connectors");
  await expect(connectorsLink).toBeVisible();
  await expect(connectorsLink).toHaveAttribute("href", "/etl/connectors");

  // …and the ledger cross-link points at the admin worklist (framed as the
  // "libro de capturas", not the place you capture).
  const ledgerLink = page.getByTestId("captura-to-ledger");
  await expect(ledgerLink).toBeVisible();
  await expect(ledgerLink).toHaveAttribute("href", "/etl/captura");
  await expect(ledgerLink).toHaveText("Captura (admin)");

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("queue chip deep-link: a connector's chip opens the ledger filtered to that portal's pending rows", async ({
  page,
}) => {
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // The seeded profile's aliseda connector is DUE (nothing run) → expanded, so
  // its queue chip is on screen. Click it.
  const chip = page.getByTestId(`captura-queue-link-${profileId}-aliseda`);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute(
    "href",
    "/etl/captura?portal=aliseda&status=pending",
  );
  await chip.click();

  // Lands on the ledger, focused on aliseda + the Pendientes filter preset.
  await page.waitForURL(/\/etl\/captura\?portal=aliseda&status=pending/);
  await expect(page.getByTestId("worklist-page")).toBeVisible();
  await expect(page.getByTestId("worklist-portal-focus")).toBeVisible();
  await expect(page.getByTestId("worklist-filter-pending")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // The pending aliseda row shows; the captured one is filtered out.
  await expect(page.getByRole("link", { name: PENDING_URL })).toBeVisible();
  await expect(page.getByRole("link", { name: CAPTURED_URL })).toHaveCount(0);

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
