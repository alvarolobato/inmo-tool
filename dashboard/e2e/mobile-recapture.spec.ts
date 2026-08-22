/**
 * E2E (issue #677): the cohort re-capture panel fits a phone.
 *
 * Separate file from recapture.spec.ts so the phone-width fixture applies to
 * the whole file and cannot leak into the desktop specs. (The earlier note
 * here — that Playwright refuses `test.use({ ...devices[...] })` inside a
 * `describe` — was only true while the spread still carried
 * `defaultBrowserType`, which switches engines and so needs a fresh worker.
 * That field is destructured out below, as it is in every sibling spec.)
 *
 * Device emulation gotcha (D-120, repeated in every mobile spec here so it is
 * not reintroduced): under `devices["iPhone 13"]`, `window.innerWidth` does
 * NOT reflect the emulated 390px viewport (653 on a prior probe) — always read
 * `document.documentElement.clientWidth`.
 *
 * The panel is three selects plus a number input plus two buttons; side by
 * side they overflow 390px, so globals.css stacks them below 768px with an
 * explicit `flex-direction: column` (D-124: a flex-wrap over basis-0 children
 * never actually wraps). This spec is what proves that rule is in effect.
 */
import { test, expect, devices } from "@playwright/test";
import { seedAdminSession, adminKey } from "./helpers/admin-session";
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

// Destructure out `defaultBrowserType` (webkit) before spreading — this
// project's single Playwright project is chromium (playwright.config.ts) and
// CI only installs that one browser, so leaving the field in switches the
// worker to a webkit binary that does not exist on the runner (issue #681;
// same block as every other mobile spec here, e.g. mobile-dedup.spec.ts).
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } =
  devices["iPhone 13"];
test.use({ ...iPhone13 });

const MARK = "E2E-MRECAP";
const HOST = "https://www.idealista.com";
const PROFILE = "e2e-mobile-recapture-profile";

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

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[mobile-recapture.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();
  // One captured, under-photographed, live-candidate listing so "Calcular"
  // returns a non-empty cohort and the estimate + confirm block renders.
  const profile = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope) VALUES ($1, '{}'::jsonb) RETURNING id`,
    [PROFILE],
  );
  const externalId = `${MARK}-1`;
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
    [profile.rows[0].id, prop.rows[0].id],
  );
  await pool.query(
    `INSERT INTO capture_worklist (url, match_key, source_portal, status, added_via)
     VALUES ($1, $2, 'idealista', 'captured', 'derived')`,
    [url, `idealista.com/inmueble/${externalId}`],
  );
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end().catch(() => {});
});

test.beforeEach(() => {
  test.skip(!dbAvailable, "Postgres unreachable");
  test.skip(!adminKey, "ADMIN_API_KEY unset");
});

test("fits 390px with ≥44px targets", async ({ page, baseURL }) => {
  await seedAdminSession(page, baseURL!);
  await page.goto("/admin/fuentes/idealista");
  await expect(page.getByTestId("recapture-panel")).toBeVisible();

  // Emulation gotcha (D-120): window.innerWidth lies under device emulation.
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(clientWidth).toBeLessThanOrEqual(390);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  const assertTargets = async (ids: string[]) => {
    for (const id of ids) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} must be laid out`).not.toBeNull();
      expect(box!.height, `${id} tap target`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${id} must not overflow`).toBeLessThanOrEqual(390);
    }
  };

  await assertTargets([
    "recapture-portal",
    "recapture-predicate",
    "recapture-threshold",
    "recapture-calculate",
    // The checkbox is a real control the operator taps, so D-124 applies to
    // the INPUT, not to the <label> that happens to wrap it. Left out of this
    // list it measured 20x20 and nothing complained.
    "recapture-only-candidates",
  ]);

  // The estimate panel and the destructive confirm are the half of this
  // surface that only appears after "Calcular" — and the confirm is the one
  // that must never be a cramped mis-tap.
  await page.getByTestId("recapture-calculate").click();
  await expect(page.getByTestId("recapture-estimate")).toBeVisible();
  await assertTargets(["recapture-reason", "recapture-confirm"]);

  const after = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth + 1);
});
