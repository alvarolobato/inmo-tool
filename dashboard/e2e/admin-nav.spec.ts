/**
 * E2E: admin IA consolidation (issue #508), extended by #653/#636 Fase 0
 * borrado, D-041.
 *
 * Drives a real Next.js server against a real Postgres. Asserts the admin strip
 * is rendered from the single shared nav source (lib/admin-nav.ts):
 *
 *   - the strip shows the consolidated, renamed tab set (Captura (admin),
 *     Clasificación, Duplicados, LLM) and no longer the four separate LLM tabs,
 *     "URLs capturadas", or the old "Candidatos" label;
 *   - `/admin/candidatos`, `/admin/interactions`, `/admin/tool-calls`,
 *     `/admin/captured-urls` and `/admin/slow-queries` are gone outright
 *     (404) — no replacement PAGE, per #653 (0 rows ever in the tables they
 *     viewed, a redirect stub nothing linked to any more, or content that
 *     folded into `/admin/llm` as a disclosure with no route of its own);
 *   - `/admin/usage` is NOT the same case: `llm_usage` is live, so it
 *     redirects to `/admin/llm` and the redirect TARGET is asserted to
 *     actually render (not just that the old path is gone — a redirect
 *     nobody tests is a 404 waiting to happen);
 *   - Duplicados is reachable from the strip;
 *   - no error surface anywhere (the D-041 bar).
 *
 * Extensión (#509) and Descubrimiento (#511) have now been removed — their
 * function moved to inline CTAs / Salud de datos. Diagnósticos (#671) was
 * added on top. The strip's exact tab set is asserted here, exhaustively.
 *
 * Admin-gated (middleware gates every UI page on the ps_admin cookie), so the
 * test seeds that cookie like /admin/login does. Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset, matching the other admin specs.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

// The tabs the admin strip ships, in strip order. Extensión + Descubrimiento
// were removed by #509 / #511; "URLs capturadas" was deleted outright by #653;
// Diagnósticos was added by #671 (extension force-capture diagnostics, D-153).
//
// This list is EXHAUSTIVE — `toHaveText` below compares it against every link
// in the strip, so adding an entry to `lib/admin-nav.ts` without adding it
// here fails this spec. That is deliberate: the strip is the one surface where
// a silently-appearing admin tab should be a conscious decision.
const EXPECTED_STRIP_LABELS = [
  "Monitor ETL",
  "Conectores",
  "Captura (admin)",
  "Salud de datos",
  "Clasificación",
  "Duplicados",
  "LLM",
  "Configuración",
  "Diagnósticos",
];

// Labels that must NOT appear in the consolidated strip anymore.
const REMOVED_STRIP_LABELS = [
  "Candidatos",
  "Captura guiada",
  "Consultas lentas",
  "Herramientas LLM",
  "Uso LLM",
  "Interacciones",
  "URLs capturadas",
  // Removed by #509 / #511.
  "Extensión",
  "Descubrimiento",
];

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

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[admin-nav.spec] Postgres unreachable — skipping");
  }
});

test.afterAll(async () => {
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

/** The admin strip (not the global TopBar) — scoped by its aria-label. */
function strip(page: import("@playwright/test").Page) {
  return page.locator('nav[aria-label="Administración"]');
}

test("EC-1: strip renders the consolidated nav from the shared source", async ({ page }) => {
  await page.goto("/admin");

  const links = strip(page).getByRole("link");
  await expect(links).toHaveText(EXPECTED_STRIP_LABELS);

  for (const gone of REMOVED_STRIP_LABELS) {
    await expect(strip(page).getByRole("link", { name: gone, exact: true })).toHaveCount(0);
  }

  // No error surface (D-041 bar).
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-1: /admin index cards match the strip (single source, no drift)", async ({ page }) => {
  await page.goto("/admin");
  // The index grid links (excludes the strip nav) — every strip href appears.
  for (const label of EXPECTED_STRIP_LABELS) {
    await expect(page.getByRole("link", { name: label, exact: true }).first()).toBeVisible();
  }
});

test("EC-2: /admin/candidatos is gone outright (404, no redirect)", async ({ page }) => {
  // #653: the old #508 redirect stub (`/admin/candidatos` → `/admin/clasificacion`)
  // was deleted — its own header said "delete once no external link points
  // here", and the strip already links straight to `/admin/clasificacion`.
  const res = await page.goto("/admin/candidatos");
  expect(res?.status()).toBe(404);
});

test("EC-2: /admin/interactions, /admin/tool-calls, /admin/captured-urls and /admin/slow-queries are gone (404)", async ({
  page,
}) => {
  // #653 DoD lists all five deleted routes (this file's other 404 test
  // covers /admin/candidatos separately, since it gets its own "no redirect"
  // framing). 0 rows ever in llm_interactions / llm_tool_calls;
  // captured_search_urls is a developer decode aid consulted by SQL now
  // (see docs/skills/search-url-builder.md); /admin/slow-queries's content
  // (pg_stat_statements) is a collapsed disclosure on /admin/llm now — no
  // replacement PAGE for any of the four.
  for (const path of [
    "/admin/interactions",
    "/admin/tool-calls",
    "/admin/captured-urls",
    "/admin/slow-queries",
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} should 404`).toBe(404);
  }
});

test("EC-2: /admin/usage permanently redirects to /admin/llm, which renders", async ({ page }) => {
  // Asserting the redirect TARGET renders is the point — a redirect nobody
  // tests is a 404 waiting to happen. `llm_usage` is live (17,391 rows as of
  // 2026-08-21), so this is a redirect, not a 404 (unlike interactions/
  // tool-calls/captured-urls above).
  //
  // What `res` actually is here (corrected per #656 review): Next's
  // `permanentRedirect()` is NOT a 308 + Location header on the wire for
  // this app-router page — it streams an RSC redirect instruction inside a
  // normal 200 HTML document for `/admin/usage` itself, and the navigation
  // to `/admin/llm` happens client-side once React hydrates. So `res` below
  // is `/admin/usage`'s OWN response (200, no Location) — a browser
  // (including Playwright) still ends up on `/admin/llm`, which is what
  // `toHaveURL` + the visibility assertion below prove; `res.status()` only
  // confirms the stub route itself didn't error. A non-browser client would
  // need to run JS to follow this — see the comment on
  // `app/admin/usage/page.tsx` for what that means going forward.
  const res = await page.goto("/admin/usage");
  await expect(page).toHaveURL(/\/admin\/llm$/);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("admin-llm-page")).toBeVisible();

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-3: Duplicados is reachable from the strip", async ({ page }) => {
  await page.goto("/admin");
  const dup = strip(page).getByRole("link", { name: "Duplicados", exact: true });
  await expect(dup).toHaveAttribute("href", "/admin/dedup");
  await dup.click();
  await expect(page).toHaveURL(/\/admin\/dedup$/);
  await expect(page.getByRole("heading", { name: "Revisión de duplicados" })).toBeVisible();
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("the consolidated LLM page renders usage, cost/coverage and the slow-queries disclosure", async ({
  page,
}) => {
  await page.goto("/admin/llm");
  await expect(page.getByTestId("admin-llm-page")).toBeVisible();

  // Usage content (formerly `/admin/usage`) leads the page.
  await expect(page.getByText("Configuración efectiva")).toBeVisible();

  // Cost/coverage panel (formerly on "Salud de datos") is present.
  await expect(page.getByTestId("llm-health")).toBeVisible();

  // Slow-queries disclosure (formerly `/admin/slow-queries`) is present,
  // collapsed by default, and opens on click.
  const slowQueries = page.getByTestId("admin-llm-slow-queries");
  await expect(slowQueries).toBeVisible();
  const toggle = page.getByTestId("slow-queries-disclosure-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // WCAG 2.5.5's 44px minimum tap target (review of #656 — this panel's
  // markup moved verbatim from a page nobody read on a phone onto one the
  // owner does; several of its interactive elements measured 35-38px).
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // A sort-header button (always rendered, regardless of row count) and the
  // nested guidance-panel toggle get the same floor.
  const sortHeaderBtn = page.getByRole("button", { name: /Media ms/ });
  const sortHeaderBox = await sortHeaderBtn.boundingBox();
  expect(sortHeaderBox!.height).toBeGreaterThanOrEqual(44);

  const guidanceToggle = page.getByText("¿Cómo actuar ante consultas lentas?");
  const guidanceBox = await guidanceToggle.boundingBox();
  expect(guidanceBox!.height).toBeGreaterThanOrEqual(44);

  // Visiting /admin/usage highlights the single LLM tab (aria-current="page").
  await page.goto("/admin/usage");
  const llmTab = strip(page).getByRole("link", { name: "LLM", exact: true });
  await expect(llmTab).toHaveAttribute("aria-current", "page");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});
