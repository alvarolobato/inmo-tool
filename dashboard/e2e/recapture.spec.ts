/**
 * E2E: cohort re-capture on the worklist page (issue #677, D-041).
 *
 * Proves the three properties a bulk write against production data has to
 * have, through the real UI against a real Postgres:
 *
 *   1. Nothing is written until an explicit confirm — "Calcular" alone leaves
 *      every row exactly as it was.
 *   2. The confirm names the count and the time cost BEFORE it arms, so a
 *      requeue of thousands of pages can never look free.
 *   3. A requeued row is visibly distinct from a never-captured one, even
 *      though both read "Pendiente".
 *
 * The phone geometry lives in mobile-recapture.spec.ts — `test.use({device})`
 * forces a new worker, so Playwright refuses it inside a describe block.
 *
 * Skips cleanly without Postgres or ADMIN_API_KEY, like every other spec here.
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

const MARK = "E2E-RECAP";
const HOST = "https://www.idealista.com";
const PROFILE = "e2e-recapture-profile";

let pool: Pool;
let dbAvailable = false;

async function purge(): Promise<void> {
  await pool.query(`DELETE FROM capture_worklist WHERE url LIKE '%${MARK}%'`);
  await pool.query(
    `DELETE FROM profile_listing_state WHERE property_id IN
       (SELECT property_id FROM listing WHERE external_id LIKE '${MARK}%')`,
  );
  const props = await pool.query<{ property_id: number }>(
    `SELECT property_id FROM listing WHERE external_id LIKE '${MARK}%'`,
  );
  await pool.query(`DELETE FROM listing WHERE external_id LIKE '${MARK}%'`);
  const ids = props.rows.map((r) => r.property_id);
  if (ids.length > 0) {
    await pool.query(`DELETE FROM property WHERE id = ANY($1)`, [ids]);
  }
  await pool.query(`DELETE FROM search_profile WHERE name = $1`, [PROFILE]);
}

/** One "captured but only 3 photos" listing + its worklist row. */
async function seedListing(
  suffix: string,
  profileId: number,
  worklistStatus: string,
): Promise<void> {
  const externalId = `${MARK}-${suffix}`;
  const url = `${HOST}/inmueble/${externalId}/`;
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property DEFAULT VALUES RETURNING id`,
  );
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, url, status, operation, photo_urls)
     VALUES ($1, 'idealista', $2, $3, 'active', 'sale', $4)`,
    [prop.rows[0].id, externalId, url, [`${HOST}/p/${externalId}.jpg`]],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, score, matched, pipeline_stage)
     VALUES ($1, $2, 0.9, true, 'new')`,
    [profileId, prop.rows[0].id],
  );
  await pool.query(
    `INSERT INTO capture_worklist (url, match_key, source_portal, status, added_via)
     VALUES ($1, $2, 'idealista', $3, 'derived')`,
    [url, `idealista.com/inmueble/${externalId}`, worklistStatus],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[recapture.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  const p = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope) VALUES ($1, '{}'::jsonb) RETURNING id`,
    [PROFILE],
  );
  await seedListing("A", p.rows[0].id, "captured");
  await seedListing("B", p.rows[0].id, "captured");
  // A never-captured row, so the "distinguishable" assertion has a control.
  await seedListing("C", p.rows[0].id, "pending");
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end().catch(() => {});
});

test.describe("cohort re-capture", () => {
  test.beforeEach(() => {
    test.skip(!dbAvailable, "Postgres unreachable");
    test.skip(!adminKey, "ADMIN_API_KEY unset");
  });

  test("previews a cohort, states the cost, and writes nothing until confirmed", async ({
    page,
    baseURL,
  }) => {
    await seedAdminSession(page, baseURL!);
    await page.goto("/admin/fuentes/idealista");

    const panel = page.getByTestId("recapture-panel");
    await expect(panel).toBeVisible();

    await page.getByTestId("recapture-portal").selectOption("idealista");
    await page.getByTestId("recapture-predicate").selectOption("few_photos");
    await page.getByTestId("recapture-threshold").fill("4");
    await page.getByTestId("recapture-calculate").click();

    // The count and the time cost are on screen BEFORE anything can be confirmed.
    const estimate = page.getByTestId("recapture-estimate");
    await expect(estimate).toBeVisible();
    await expect(page.getByTestId("recapture-count")).toContainText("2");
    await expect(estimate).toContainText("navegación continua");

    // Calcular is read-only: the rows are still 'captured'.
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM capture_worklist
        WHERE url LIKE '%${MARK}%' AND status = 'captured'`,
    );
    expect(before.rows[0].n).toBe(2);

    // The confirm needs a reason, and the first tap only arms it.
    const confirm = page.getByTestId("recapture-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("recapture-reason").fill("galería truncada (#625)");
    await expect(confirm).toBeEnabled();
    await expect(confirm).toContainText("2");

    await confirm.click();
    await expect(page.getByTestId("recapture-confirm-warning")).toBeVisible();
    // Still nothing written — the warning is the second half of the confirm.
    const midway = await pool.query(
      `SELECT count(*)::int AS n FROM capture_worklist
        WHERE url LIKE '%${MARK}%' AND requeued_at IS NOT NULL`,
    );
    expect(midway.rows[0].n).toBe(0);

    await confirm.click();
    await expect(page.getByTestId("recapture-result")).toBeVisible();

    await expect
      .poll(async () => {
        const r = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM capture_worklist
            WHERE url LIKE '%${MARK}%'
              AND status = 'pending' AND requeued_at IS NOT NULL`,
        );
        return r.rows[0].n;
      })
      .toBe(2);

    // The never-captured control is untouched: still pending, still no stamp.
    const control = await pool.query<{ requeued_at: string | null }>(
      `SELECT requeued_at FROM capture_worklist WHERE url LIKE '%${MARK}-C%'`,
    );
    expect(control.rows[0].requeued_at).toBeNull();

    // A requeued row is visibly distinct from the never-captured one, even
    // though both now read "Pendiente".
    const requeuedRow = await pool.query<{ id: number }>(
      `SELECT id FROM capture_worklist WHERE url LIKE '%${MARK}-A%'`,
    );
    const controlRow = await pool.query<{ id: number }>(
      `SELECT id FROM capture_worklist WHERE url LIKE '%${MARK}-C%'`,
    );
    await expect(
      page.getByTestId(`worklist-requeued-${requeuedRow.rows[0].id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`worklist-requeued-${controlRow.rows[0].id}`),
    ).toHaveCount(0);

    // D-041: no error surface anywhere on the page.
    await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
    await expect(page.getByText("Error al cargar")).toHaveCount(0);
    await expect(page.getByText("HTTP 500")).toHaveCount(0);
  });
});
