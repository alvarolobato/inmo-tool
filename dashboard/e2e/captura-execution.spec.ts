/**
 * E2E: top-level guided-capture EXECUTION page (issue #268, D-041, D-045).
 *
 * Drives a real Next.js server against a real Postgres. Seeds one search
 * profile (so `GET /api/profiles/[id]/search-urls` returns real pre-filtered
 * URLs for idealista + aliseda) plus a few `capture_worklist` rows for aliseda
 * (so the per-portal progress roll-up has real content), then:
 *   - navigates to the NEW top-level `/captura` page (not the admin
 *     `/etl/captura`);
 *   - asserts the profile's per-portal cards render with a real "Abrir
 *     búsqueda" link, the aliseda worklist progress, and the loosened-search
 *     note (aliseda always loosens geography — issue #267);
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

const PROFILE_NAME = "E2E-CAPTURA-268";
const SCOPE = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 10 },
  property_types: ["piso"],
  price_max: 200000,
};

const PORTAL = "aliseda";
const WL_SEED = [
  { path: "/inmueble/E2E-CAP-PENDING", status: "pending" },
  { path: "/inmueble/E2E-CAP-CAPTURED", status: "captured" },
];

let pool: Pool;
let dbAvailable = false;
let profileId: number | null = null;

async function purge(): Promise<void> {
  await pool.query("DELETE FROM capture_worklist WHERE url LIKE '%E2E-CAP-%'");
  await pool.query("DELETE FROM search_profile WHERE name = $1", [PROFILE_NAME]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[captura-execution.spec] Postgres unreachable — skipping");
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
      [url, matchKey, PORTAL, status],
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

test("renders the profile's per-portal capture cards, open-search links and progress with no error surface", async ({
  page,
}) => {
  await page.goto("/captura");
  await expect(page.getByTestId("captura-page")).toBeVisible();

  // Select our seeded profile explicitly (the page auto-selects the first,
  // which may be another profile in a shared DB).
  await expect(page.getByTestId("captura-profile-select")).toBeVisible();
  await page.getByTestId("captura-profile-select").selectOption({ label: PROFILE_NAME });

  // Both capture portals render as cards.
  await expect(page.getByTestId("captura-portal-idealista")).toBeVisible();
  const alisedaCard = page.getByTestId("captura-portal-aliseda");
  await expect(alisedaCard).toBeVisible();

  // Each card renders one "Abrir búsqueda" link per pre-filtered search task
  // (a portal searches one section at a time — issue #277). Scope to the
  // aliseda card and pick its first task link; the test-id is the stable task
  // id, so we locate by role/text instead of a hard-coded id.
  const alisedaOpen = alisedaCard.getByRole("link", { name: /Abrir búsqueda/ }).first();
  await expect(alisedaOpen).toBeVisible();
  await expect(alisedaOpen).toHaveAttribute("href", /alisedainmobiliaria\.com\/comprar-viviendas/);
  await expect(alisedaOpen).toHaveAttribute("target", "_blank");

  // Aliseda always loosens geography (issue #267) — surfaced, never hidden.
  await expect(alisedaCard).toContainText("búsqueda ampliada");

  // Worklist progress for aliseda: 1 of 2 captured from the seed.
  await expect(page.getByTestId("captura-captured-aliseda")).toContainText("1/2 capturadas");
  const bar = page.getByTestId("captura-progress-aliseda");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuenow", /\d+/);

  // Totals strip renders.
  await expect(page.getByTestId("captura-totals")).toBeVisible();

  // Cross-link to the admin setup surface exists.
  await expect(page.getByTestId("captura-setup-link")).toBeVisible();

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
