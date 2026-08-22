/**
 * E2E: inline extension install/link CTA + heartbeat presence (issue #509, D-041).
 *
 * The Extensión admin tab was removed; its setup is now surfaced inline by
 * `<ExtensionCta/>` wherever capture happens. Presence is server-mediated: the
 * extension POSTs a heartbeat and the surfaces read GET /api/extension/status.
 *
 * This spec drives a real Next.js server + Postgres and asserts (issue #527:
 * the CTA must NEVER fully hide — it is the only path to install/update):
 *   - UNLINKED (no heartbeat row): /captura and /profiles/[id]/filtros show the
 *     install CTA, and opening it reveals the setup (download + API URL + key);
 *   - LINKED + up to date: /captura shows a discreet "vinculada" chip with a
 *     manage/update link (opens the same setup) — no install button, no update
 *     prompt;
 *   - LINKED + outdated (installed version < served version): /captura shows an
 *     "Actualización disponible" prompt with the update link;
 *   - the admin strip no longer lists Extensión, and /admin/extension still
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
/**
 * Seed a fresh (linked) heartbeat with an explicit reported version. Tests use
 * deliberately extreme versions so the served-version comparison is robust
 * against real manifest bumps: "999.0.0" always reads as up to date, "0.0.1"
 * always reads as an update being available.
 */
async function seedHeartbeat(version = "999.0.0"): Promise<void> {
  await pool.query(
    `INSERT INTO extension_heartbeat (id, last_seen_at, version)
       VALUES (1, NOW(), $1)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW(), version = EXCLUDED.version`,
    [version],
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
    "/admin/extension",
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

test("EC-2: linked + up to date shows the discreet chip + manage link on /captura", async ({
  page,
}) => {
  // A version that can never be older than the served one → up-to-date chip.
  await seedHeartbeat("999.0.0");
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // The CTA never fully hides (#527): a discreet linked chip is present, with a
  // manage/update link so reinstall/update is always reachable — but no install
  // button and no "update available" prompt.
  const cta = page.getByTestId("extension-cta");
  await expect(cta).toBeVisible();
  await expect(page.getByTestId("extension-cta-linked")).toBeVisible();
  await expect(page.getByTestId("extension-cta-manage")).toBeVisible();
  await expect(page.getByTestId("extension-cta-button")).toHaveCount(0);
  await expect(page.getByTestId("extension-cta-update")).toHaveCount(0);

  // The manage link opens the same setup modal (reinstall/update path).
  await page.getByTestId("extension-cta-manage").click();
  await expect(page.getByTestId("extension-setup-modal")).toBeVisible();
  await expect(page.getByTestId("extension-setup")).toBeVisible();

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-4: linked + outdated shows the update-available prompt on /captura", async ({ page }) => {
  // A version that can never be newer than the served one → update prompt.
  await seedHeartbeat("0.0.1");
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  const update = page.getByTestId("extension-cta-update");
  await expect(update).toBeVisible();
  await expect(update).toContainText("Actualización disponible");
  // The update link opens the same setup modal.
  await page.getByTestId("extension-cta-manage").click();
  await expect(page.getByTestId("extension-setup-modal")).toBeVisible();

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-3: the admin strip has no Extensión tab; /admin/extension still renders the setup", async ({
  page,
}) => {
  await page.goto("/admin");
  const strip = page.locator('nav[aria-label="Administración"]');
  await expect(strip.getByRole("link", { name: "Extensión", exact: true })).toHaveCount(0);

  await page.goto("/admin/extension");
  await expect(page.getByTestId("extension-setup-page")).toBeVisible();
  await expect(page.getByTestId("extension-setup")).toBeVisible();
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});
