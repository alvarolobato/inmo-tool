/**
 * E2E: the six-section admin IA (issue #508 → #653 → #642 P1 → #642 P2, D-041).
 *
 * This file is #642's EC-1: the strip shows exactly Estado / Fuentes /
 * Actividad / Revisión / LLM / Configuración, and every retired route
 * redirects to its named home. P2 is where that end state is finally reached —
 * by deleting, not by adding: `/etl`, `/etl/[id]`, `/etl/salud` and
 * `/etl/extension` are gone from the route table entirely.
 *
 * Drives a real Next.js server against a real Postgres. Asserts the admin strip
 * is rendered from the single shared nav source (lib/admin-nav.ts):
 *
 *   - the strip shows exactly the six sections, in order, and none of the
 *     fourteen labels that came before them;
 *   - `/admin/candidatos`, `/admin/interactions`, `/admin/tool-calls`,
 *     `/admin/captured-urls` and `/admin/slow-queries` are gone outright
 *     (404) — no replacement PAGE, per #653 (0 rows ever in the tables they
 *     viewed, a redirect stub nothing linked to any more, or content that
 *     folded into `/admin/llm` as a disclosure with no route of its own);
 *   - `/admin/usage` is NOT the same case: `llm_usage` is live, so it
 *     redirects to `/admin/llm` and the redirect TARGET is asserted to
 *     actually render (not just that the old path is gone — a redirect
 *     nobody tests is a 404 waiting to happen);
 *   - both Revisión queues are reachable, though only one has a tab;
 *   - the retired `/etl` tree 308s ON THE WIRE (status + Location asserted,
 *     not just where a browser lands) to the homes #642's disposition table
 *     names, and each of those targets actually renders;
 *   - no error surface anywhere (the D-041 bar).
 *
 * The strip list is asserted EXHAUSTIVELY, so a tab cannot appear or vanish
 * without a deliberate edit here.
 *
 * Admin-gated (middleware gates every UI page on the ps_admin cookie), so the
 * test seeds that cookie like /admin/login does. Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset, matching the other admin specs.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { adminKey, seedAdminSession } from "./helpers/admin-session";

// The tabs the admin strip ships, in strip order — #636's six sections, and
// nothing else. How each of the eight it replaced got here:
//   Extensión + Descubrimiento removed (#509 / #511); "URLs capturadas",
//   "Interacciones", "Herramientas LLM", "Consultas lentas" deleted outright
//   (#653); "Conectores" + "Captura (admin)" merged into Fuentes (#642 P1);
//   "Monitor ETL" + "Salud de datos" deleted with the whole /etl tree (#642
//   P2); "Duplicados" + "Clasificación" grouped into one "Revisión" tab (#642
//   P2, with `<RevisionTabs/>` on both pages); "Diagnósticos" (#671) taken off
//   the strip and owned by Fuentes via matchPrefixes; and "Estado" ADDED,
//   because the landing since #638 had no tab of its own.
//
// This list is EXHAUSTIVE — `toHaveText` below compares it against every link
// in the strip, so adding an entry to `lib/admin-nav.ts` without adding it
// here fails this spec. That is deliberate: the strip is the one surface where
// a silently-appearing admin tab should be a conscious decision.
const EXPECTED_STRIP_LABELS = [
  "Estado",
  "Fuentes",
  "Actividad",
  "Revisión",
  "LLM",
  "Configuración",
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
  // Merged into "Fuentes" by #642 P1.
  "Conectores",
  "Captura (admin)",
  // Deleted with the /etl tree by #642 P2.
  "Monitor ETL",
  "Salud de datos",
  // Grouped into "Revisión" by #642 P2 — both queues still exist, but neither
  // has a strip tab of its own any more.
  "Duplicados",
  "Clasificación",
  // Off-strip since #642 P2, owned by Fuentes.
  "Diagnósticos",
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

test("EC-1: the Estado tab is present and marks itself active on the landing", async ({
  page,
}) => {
  // The gap #642 P2 closed: `/admin` has been the landing since #638 and the
  // strip never listed it, so the one surface the owner is sent to on login
  // was the one with no way back to it.
  await page.goto("/admin");
  const estado = strip(page).getByRole("link", { name: "Estado", exact: true });
  await expect(estado).toHaveAttribute("href", "/admin");
  await expect(estado).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("estado-board")).toBeVisible();
});

test("#642 P2: the whole /etl tree is gone from the route table and 308s on the wire", async ({
  page,
  request,
}) => {
  // The redirect trap this tracker has fallen into before: a page-level
  // `permanentRedirect()` is NOT a redirect on the wire — Next streams it as
  // an RSC instruction inside a 200, so a browser follows it and anything
  // else does not. `/etl/salud` MUST be a real 308 + Location: an installed
  // browser extension opens it from a notification handler and only picks up
  // the new URL when the owner reloads the zip (D-060). So this asserts the
  // STATUS AND HEADER, not just where a browser ends up.
  const wire: Array<[string, string]> = [
    ["/etl", "/admin/actividad"],
    ["/etl/salud", "/admin"],
    ["/etl/extension", "/admin/extension"],
    ["/etl/connectors", "/admin/fuentes"],
    ["/etl/captura", "/admin/fuentes"],
  ];
  for (const [from, to] of wire) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect(res.status(), `${from} should be a permanent redirect`).toBe(308);
    expect(res.headers()["location"], `${from} Location`).toBe(to);
  }

  // A numeric run id maps onto the moved drill-down, and only a numeric one:
  // the rule is constrained to \d+ so a future /etl/<word> can never resolve
  // to a run detail page for a non-numeric id.
  const run = await request.get("/etl/12345", { maxRedirects: 0 });
  expect(run.status()).toBe(308);
  expect(run.headers()["location"]).toBe("/admin/actividad/run/12345");

  // And the targets actually render — a redirect nobody follows is a 404
  // waiting to happen.
  await page.goto("/etl");
  await expect(page).toHaveURL(/\/admin\/actividad$/);
  await expect(page.getByTestId("actividad-page")).toBeVisible();

  await page.goto("/etl/salud");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("estado-board")).toBeVisible();

  await page.goto("/etl/extension");
  await expect(page).toHaveURL(/\/admin\/extension$/);
  await expect(page.getByTestId("extension-setup-page")).toBeVisible();

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("EC-3 (#642): a pre-update extension's block notification still lands on a live page", async ({
  request,
}) => {
  // Exactly what an already-installed build does: open `${apiUrl}/etl/salud`
  // in a tab. It must not 404, and it must not need JS to resolve.
  const res = await request.get("/etl/salud", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toBe("/admin");
});

test("#642 P2: Revisión groups both queues, and each is one tap from the other", async ({
  page,
}) => {
  await page.goto("/admin");
  const revision = strip(page).getByRole("link", { name: "Revisión", exact: true });
  await expect(revision).toHaveAttribute("href", "/admin/dedup");
  await revision.click();
  await expect(page).toHaveURL(/\/admin\/dedup$/);
  await expect(page.getByRole("heading", { name: "Revisión de duplicados" })).toBeVisible();

  // The other queue lost its strip tab, so it has to be reachable here — a
  // grouping, not a deletion.
  const tabs = page.getByTestId("revision-tabs");
  await expect(tabs).toBeVisible();
  await tabs.getByTestId("revision-tab-clasificacion").click();
  await expect(page).toHaveURL(/\/admin\/clasificacion$/);
  await expect(page.getByTestId("clasificacion-page")).toBeVisible();
  // …and the strip still shows Revisión as the active section from there.
  await expect(revision).toHaveAttribute("aria-current", "page");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("#642 P2: Diagnósticos and the extension setup keep Fuentes highlighted", async ({
  page,
}) => {
  // Both are off-strip deep links owned by Fuentes (lib/admin-nav.ts's
  // matchPrefixes). A deep link that highlights no tab reads as "you have left
  // the admin"; two extra tabs for two deep links is the sprawl #642 undoes.
  const fuentes = strip(page).getByRole("link", { name: "Fuentes", exact: true });
  for (const path of ["/admin/diagnostics", "/admin/extension"]) {
    await page.goto(path);
    await expect(fuentes, path).toHaveAttribute("aria-current", "page");
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
