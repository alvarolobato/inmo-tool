/**
 * E2E: guided capture worklist page (issue #237, D-041).
 *
 * Drives a real Next.js server against a real Postgres, seeding
 * capture_worklist rows directly via `pg`. Asserts the two things every
 * user-facing surface in this repo is held to (D-041): no error surface, and
 * real content present (the seeded URLs + their statuses + the progress
 * summary). Also exercises the manual-add path end-to-end.
 *
 * Admin-gated (middleware.ts `/etl/:path*` + `/api/etl/:path*`), so the test
 * sets the `ps_admin` cookie the way /admin/login does. Skips cleanly when
 * Postgres is unreachable or ADMIN_API_KEY is unset, matching the other specs.
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

const PORTAL = "aliseda";
// Unique test URLs (kept out of any real listing space) so cleanup is precise.
const SEED = [
  { path: "/inmueble/E2E-WL-PENDING", status: "pending" },
  { path: "/inmueble/E2E-WL-CAPTURED", status: "captured" },
  { path: "/inmueble/E2E-WL-FAILED", status: "failed" },
];
const ADD_URL = "https://www.alisedainmobiliaria.com/inmueble/E2E-WL-ADDED";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();
const seededIds: number[] = [];

async function purge(): Promise<void> {
  await pool.query(
    "DELETE FROM capture_worklist WHERE url LIKE '%E2E-WL-%'",
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[worklist.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  for (const { path, status } of SEED) {
    const url = `https://www.alisedainmobiliaria.com${path}`;
    // match_key is NOT NULL UNIQUE; mirror lib/worklist.ts's canonical form
    // (host w/o www + path, no trailing slash) for these fixed test URLs.
    const matchKey = `alisedainmobiliaria.com${path}`;
    const res = await pool.query<{ id: number }>(
      `INSERT INTO capture_worklist (url, match_key, source_portal, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [url, matchKey, PORTAL, status],
    );
    seededIds.push(res.rows[0].id);
  }
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("renders the seeded worklist URLs and their statuses with no error surface", async ({
  page,
}) => {
  await page.goto("/etl/captura");
  await expect(page.getByTestId("worklist-page")).toBeVisible();

  // Real content: each seeded row renders, with its URL and status.
  const [pendingId, capturedId, failedId] = seededIds;
  await expect(page.getByTestId(`worklist-row-${pendingId}`)).toBeVisible();
  await expect(page.getByTestId(`worklist-status-${pendingId}`)).toHaveText("Pendiente");
  await expect(page.getByTestId(`worklist-status-${capturedId}`)).toHaveText("Capturada");
  await expect(page.getByTestId(`worklist-status-${failedId}`)).toHaveText("Fallida");

  // The "Abrir" link points at the real listing URL.
  await expect(page.getByTestId(`worklist-open-${pendingId}`)).toHaveAttribute(
    "href",
    "https://www.alisedainmobiliaria.com/inmueble/E2E-WL-PENDING",
  );

  // Progress summary shows a per-portal roll-up (captured/total).
  const summary = page.getByTestId(`worklist-summary-${PORTAL}`);
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("capturadas");

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});

test("the human-paced 'Siguiente' button is enabled and targets a pending URL (issue #254)", async ({
  page,
}) => {
  await page.goto("/etl/captura");
  await expect(page.getByTestId("worklist-page")).toBeVisible();

  // With a seeded pending row present, the advance button is enabled. It opens
  // exactly one tab per click (window.open) — a deliberately human-paced
  // advance, not an auto-runner — so we assert the affordance is present and
  // actionable rather than navigating to a real external listing.
  const nextBtn = page.getByTestId("worklist-open-next");
  await expect(nextBtn).toBeVisible();
  await expect(nextBtn).toBeEnabled();

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
});

test("manual paste adds a new URL to the worklist", async ({ page }) => {
  await page.goto("/etl/captura");
  await page.getByTestId("worklist-paste").fill(ADD_URL);
  await page.getByTestId("worklist-add-btn").click();

  // The add-result line confirms it landed, and the new row renders.
  await expect(page.getByTestId("worklist-add-result")).toContainText("añadida");
  await expect(page.getByRole("link", { name: ADD_URL })).toBeVisible();

  // And it's really in the DB as a pending manual entry.
  await expect
    .poll(async () => {
      const r = await pool.query(
        "SELECT status, added_via FROM capture_worklist WHERE url = $1",
        [ADD_URL],
      );
      return r.rows[0] ? `${r.rows[0].status}/${r.rows[0].added_via}` : null;
    })
    .toBe("pending/manual");
});
