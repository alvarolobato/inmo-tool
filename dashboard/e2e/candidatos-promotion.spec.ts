/**
 * E2E: the candidate-type promotion review page (/admin/clasificacion), issue #399
 * (Fase 8 of #385), D-041.
 *
 * Drives a real Next.js server against a real Postgres. Seeds a property + a
 * redflags `ai_assessment` row whose `result.flags` carries N (≥ threshold)
 * `other` flags with the same `candidate_type` (plus its `candidate_definition`
 * and evidence quotes), then asserts:
 *
 *   - The page renders and lists the seeded slug with its count, definition and
 *     an evidence quote.
 *   - A below-threshold slug does NOT appear (the threshold filter works
 *     end-to-end, not just in the unit query test).
 *   - No error surface (ErrorDisplay / "Detalles técnicos" / "there is no
 *     parameter" / "HTTP 500" / "Error al cargar") — the D-041 bar.
 *
 * The default promotion threshold is 5 (config redflags.candidate_promotion_threshold);
 * the seed uses 6 for the qualifying slug and 1 for the noise slug so the test
 * is robust regardless of any other rows already in the shared test DB.
 *
 * Admin-gated (middleware gates every UI page on the ps_admin cookie), so the
 * test sets that cookie like /admin/login does. Skips cleanly when Postgres is
 * unreachable or ADMIN_API_KEY is unset, matching the other specs.
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

// Per-run nonce so the seeded slugs can't collide with real data or a parallel
// run, and cleanup is precise.
const NONCE = `e2e${Date.now().toString(36)}`;
const HIT = `servidumbre_paso_${NONCE}`; // 6 occurrences → over threshold (5)
const NOISE = `ideal_inversores_${NONCE}`; // 1 occurrence → below threshold
const HIT_DEF = "Un tercero tiene derecho de paso por la finca.";
const HIT_QUOTE = `existe una servidumbre de paso ${NONCE}`;
const ADDRESS = `Calle Candidato ${NONCE}`;

let pool: Pool;
let dbAvailable = false;
const createdPropertyIds: number[] = [];

function otherFlags(slug: string, n: number, definition: string, quote: string) {
  return Array.from({ length: n }, (_, i) => ({
    type: "other",
    description: `problema ${i}`,
    evidence: `${quote} #${i}`,
    evidence_source: "fotocasa",
    candidate_type: slug,
    candidate_definition: definition,
  }));
}

async function seedRow(flags: unknown[], address: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO property (address, property_type) VALUES ($1, 'piso') RETURNING id`,
    [address],
  );
  const propertyId = Number(rows[0].id);
  createdPropertyIds.push(propertyId);
  await pool.query(
    `INSERT INTO ai_assessment
        (property_id, assessment_type, result, confidence, model, prompt_version, generated_at)
     VALUES ($1, 'redflags', $2::jsonb, 0.8, 'e2e-model', 'redflags/v8', NOW())`,
    [propertyId, JSON.stringify({ flags, confidence: 0.8, reasoning: "x" })],
  );
  return propertyId;
}

async function purge(): Promise<void> {
  // #407: also clear any dismissal rows this spec created.
  await pool.query("DELETE FROM dismissed_candidate_type WHERE slug = ANY($1::text[])", [
    [HIT, NOISE],
  ]);
  if (createdPropertyIds.length === 0) return;
  await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
    createdPropertyIds,
  ]);
  await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[candidatos-promotion.spec] Postgres unreachable — skipping");
    return;
  }
  await seedRow(otherFlags(HIT, 6, HIT_DEF, HIT_QUOTE), ADDRESS);
  await seedRow(otherFlags(NOISE, 1, "ruido", "algo"), `Calle Ruido ${NONCE}`);
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

test("lists recurring candidate_types over the threshold with evidence (D-041)", async ({
  page,
}) => {
  await page.goto("/admin/clasificacion");
  await expect(page.getByTestId("clasificacion-page")).toBeVisible();

  // The qualifying slug's card renders, with slug, count, definition and quote.
  const card = page.getByTestId(`candidato-${HIT}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(HIT);
  await expect(card).toContainText("6 apariciones");
  await expect(card).toContainText(HIT_DEF);
  await expect(card).toContainText(HIT_QUOTE);

  // The below-threshold noise slug must NOT appear (threshold filter works e2e).
  await expect(page.getByTestId(`candidato-${NOISE}`)).toHaveCount(0);

  // ── D-041 bar: no error surface anywhere on the page. ──
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("Detalles técnicos");
  await expect(body).not.toContainText("there is no parameter");
  await expect(body).not.toContainText("HTTP 500");
  await expect(body).not.toContainText("Error al cargar");
});

test("#407: dismissing a candidate removes it from the list, no error surface (D-041)", async ({
  page,
}) => {
  // Accept the optional-reason window.prompt the dismiss button opens.
  page.on("dialog", (dialog) => dialog.accept("duplicado de otro eje"));

  await page.goto("/admin/clasificacion");
  await expect(page.getByTestId("clasificacion-page")).toBeVisible();

  // The candidate is present before dismissal.
  const card = page.getByTestId(`candidato-${HIT}`);
  await expect(card).toBeVisible();

  // Click "Descartar"; the page refreshes and the now-dismissed candidate is
  // excluded by getPromotionCandidates, so its card disappears.
  await page.getByTestId(`dismiss-${HIT}`).click();
  await expect(page.getByTestId(`candidato-${HIT}`)).toHaveCount(0);

  // The dismissal really persisted — a reload still shows it gone.
  await page.reload();
  await expect(page.getByTestId("clasificacion-page")).toBeVisible();
  await expect(page.getByTestId(`candidato-${HIT}`)).toHaveCount(0);

  // ── D-041 bar: no error surface anywhere on the page. ──
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("Detalles técnicos");
  await expect(body).not.toContainText("there is no parameter");
  await expect(body).not.toContainText("HTTP 500");
  await expect(body).not.toContainText("Error al cargar");
});
