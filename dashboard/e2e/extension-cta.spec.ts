/**
 * E2E: inline extension install/link CTA + heartbeat presence (issue #509, D-041).
 *
 * The Extensión admin tab was removed; its setup is now surfaced inline by
 * `<ExtensionCta/>` wherever capture happens. Presence is server-mediated: the
 * extension POSTs a heartbeat and the surfaces read GET /api/extension/status.
 *
 * This spec drives a real Next.js server + Postgres and asserts:
 *   - UNLINKED (no heartbeat row): /captura and /profiles/[id]/filtros show the
 *     CTA, and opening it reveals the setup (download + API URL + key);
 *   - LINKED (a fresh heartbeat row): the CTA is gone from /captura;
 *   - the admin strip no longer lists Extensión, and /etl/extension still
 *     renders the setup (routable as the modal's full-page deep link);
 *   - no error surface anywhere (the D-041 bar).
 *
 * Admin-gated (middleware gates every UI page on the ps_admin cookie). Skips
 * cleanly when Postgres is unreachable or ADMIN_API_KEY is unset.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

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

const NAME_PREFIX = "e2e-ext-cta-";
let pool: Pool;
let dbAvailable = false;
let profileId = 0;

async function clearHeartbeat(): Promise<void> {
  await pool.query("DELETE FROM extension_heartbeat");
}
async function seedHeartbeat(): Promise<void> {
  await pool.query(
    `INSERT INTO extension_heartbeat (id, last_seen_at, version)
       VALUES (1, NOW(), '0.13.2')
     ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW(), version = EXCLUDED.version`,
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[extension-cta.spec] Postgres unreachable — skipping");
    return;
  }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
       VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: [40.4, -3.7], radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = res.rows[0].id;
});

test.afterAll(async () => {
  if (dbAvailable) {
    await clearHeartbeat();
    await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("EC-1: unlinked shows the CTA + setup modal on /captura", async ({ page }) => {
  await clearHeartbeat();
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  const cta = page.getByTestId("extension-cta");
  await expect(cta).toBeVisible();
  await expect(page.getByTestId("extension-cta-button")).toBeVisible();

  // Opening it reveals the shared setup (download + API URL + key).
  await page.getByTestId("extension-cta-button").click();
  await expect(page.getByTestId("extension-setup-modal")).toBeVisible();
  await expect(page.getByTestId("extension-setup")).toBeVisible();
  await expect(page.getByTestId("extension-download-btn")).toBeVisible();
  await expect(page.getByTestId("extension-api-url")).toBeVisible();
  await expect(page.getByTestId("extension-cta-fullpage")).toHaveAttribute(
    "href",
    "/etl/extension",
  );

  // No error surface (D-041 bar).
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-1: unlinked shows the CTA on /profiles/[id]/filtros", async ({ page }) => {
  await clearHeartbeat();
  await page.goto(`/profiles/${profileId}/filtros`);
  await expect(page.getByTestId("validar-filtros-page")).toBeVisible();
  await expect(page.getByTestId("extension-cta")).toBeVisible();
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-2: a fresh heartbeat hides the CTA on /captura", async ({ page }) => {
  await seedHeartbeat();
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();
  // Linked → no CTA noise anywhere.
  await expect(page.getByTestId("extension-cta")).toHaveCount(0);
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-3: the admin strip has no Extensión tab; /etl/extension still renders the setup", async ({
  page,
}) => {
  await page.goto("/admin");
  const strip = page.locator('nav[aria-label="Administración"]');
  await expect(strip.getByRole("link", { name: "Extensión", exact: true })).toHaveCount(0);

  await page.goto("/etl/extension");
  await expect(page.getByTestId("extension-setup-page")).toBeVisible();
  await expect(page.getByTestId("extension-setup")).toBeVisible();
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});
