/**
 * E2E: the dedup review-queue UI (/admin/dedup) — the "missing half of the
 * dedup workflow". PR #187 wired the dedup engine into the pipeline; a real
 * run against the owner's live data produced 585 `suggested_merge` rows with
 * no UI anywhere that could act on one. This spec drives the real page
 * against a real Postgres and proves an operator can actually work the
 * queue: see both sides of a candidate pair, and confirm or reject.
 *
 * The confirm flow is the one test in this file that does NOT run against a
 * mocked or simulated backend for the merge itself. Confirming in the
 * browser only enqueues a `suggested_merge_action` row (see lib/dedup.ts's
 * module docstring) — the actual merge is performed by the ETL container's
 * `etl/dedup/actions.py` poll loop, which is Python and does not run as
 * part of `npm run dev` / this Playwright config's `webServer`. Rather than
 * mock that boundary away, this test invokes the REAL Python processor
 * once via `python -m etl.dedup.cli process-actions` (the exact code path
 * `ps dedup process-actions` and the container's background poll loop both
 * call — see `runDedupActionProcessorOnce` below) against the SAME
 * Postgres the dev server is pointed at, then asserts the real DB result:
 * one property with both listings, and a property_merge_log row. This is a
 * manually-triggered single tick of what the container's poll loop does
 * automatically every ~3s — documented here explicitly (per this project's
 * "don't claim a signal fires/converges without checking" discipline)
 * rather than silently waiting on a background process this test harness
 * doesn't start.
 *
 * Skips cleanly if no DB, or no Python venv with the etl package's
 * dependencies installed, is reachable — same pattern as candidates.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
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

// Repo root is one level up from dashboard/ — matches how scripts/
// test-with-isolated-db.ts resolves etl/schema/init.sql.
const REPO_ROOT = path.resolve(__dirname, "../..");
const VENV_PYTHON = path.join(REPO_ROOT, ".venv", "bin", "python");
const pythonAvailable = existsSync(VENV_PYTHON);

/**
 * Runs etl/dedup/actions.py's `process_pending_actions` exactly once,
 * against the same Postgres this test's Pool talks to — see file header
 * for why this is a real subprocess call, not a mock.
 */
function runDedupActionProcessorOnce(): void {
  execFileSync(VENV_PYTHON, ["-m", "etl.dedup.cli", "process-actions"], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: "pipe",
  });
}

const NAME_PREFIX = "e2e-dedup-";

let pool: Pool;
let dbAvailable = false;

async function insertProperty(overrides: { address: string; m2_built?: number }): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO property (property_type, m2_built, address) VALUES ('piso', $1, $2) RETURNING id`,
    [overrides.m2_built ?? 70, overrides.address],
  );
  return result.rows[0].id;
}

async function insertListing(
  propertyId: number,
  overrides: { source: string; current_price?: number; photo_urls?: string[] },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, current_price, photo_urls)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      propertyId,
      overrides.source,
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      overrides.current_price ?? 200000,
      overrides.photo_urls ?? null,
    ],
  );
  return result.rows[0].id;
}

async function insertSuggestion(
  listingA: number,
  listingB: number,
  overrides: { match_basis: string; confidence: number; detail?: Record<string, unknown> },
): Promise<number> {
  const [lo, hi] = [listingA, listingB].sort((a, b) => a - b);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suggested_merge (listing_id_a, listing_id_b, match_basis, confidence, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [lo, hi, overrides.match_basis, overrides.confidence, JSON.stringify(overrides.detail ?? {})],
  );
  return result.rows[0].id;
}

async function insertProfile(): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}perfil-${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center: [36.51, -4.88], radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  return result.rows[0].id;
}

async function markProfileMatch(profileId: number, propertyId: number): Promise<void> {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[dedup-review.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM suggested_merge_action WHERE suggestion_id IN " +
      "(SELECT sm.id FROM suggested_merge sm JOIN listing l ON l.id = sm.listing_id_a " +
      "WHERE l.external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM suggested_merge WHERE listing_id_a IN (SELECT id FROM listing WHERE external_id LIKE $1) " +
      "OR listing_id_b IN (SELECT id FROM listing WHERE external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM property_merge_log WHERE property_id IN " +
      "(SELECT property_id FROM listing WHERE external_id LIKE $1) " +
      "OR losing_property_id IN (SELECT property_id FROM listing WHERE external_id LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  // profile_listing_state FKs property_id — delete it before the properties.
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test("empty state — a fresh queue with no pending suggestions renders the empty message, not an error", async ({
  page,
}) => {
  skipIfNoDb(test);
  const before = await pool.query<{ count: string }>(
    "SELECT COUNT(*) FROM suggested_merge WHERE status = 'pending'",
  );
  test.skip(Number(before.rows[0].count) > 0, "queue is not empty at this point in the suite — not a clean read");

  await page.goto("/admin/dedup");
  await assertNoErrorSurface(page);
  await expect(page.getByTestId("dedup-empty-state")).toBeVisible();
  await expect(page.getByTestId("dedup-suggestion-card")).toHaveCount(0);
});

test("renders both sides of a real photo_hash suggestion, ordered ahead of a weaker fuzzy one", async ({ page }) => {
  skipIfNoDb(test);

  const propA = await insertProperty({ address: `${NAME_PREFIX}Calle Foto A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Calle Foto B` });
  const listingA = await insertListing(propA, {
    source: "milanuncios",
    current_price: 218500,
    photo_urls: ["https://img.example.com/a1.jpg", "https://img.example.com/a2.jpg"],
  });
  const listingB = await insertListing(propB, {
    source: "fotocasa",
    current_price: 218500,
    photo_urls: ["https://img.example.com/b1.jpg"],
  });
  const photoSuggestionId = await insertSuggestion(listingA, listingB, {
    match_basis: "photo_hash",
    confidence: 0.8,
    detail: { match_ratio: 1.0 },
  });

  const propC = await insertProperty({ address: `${NAME_PREFIX}Calle Difuso A` });
  const propD = await insertProperty({ address: `${NAME_PREFIX}Calle Difuso B` });
  const listingC = await insertListing(propC, { source: "idealista", current_price: 150000 });
  const listingD = await insertListing(propD, { source: "fotocasa", current_price: 152000 });
  const fuzzySuggestionId = await insertSuggestion(listingC, listingD, {
    match_basis: "fuzzy",
    confidence: 0.58,
    detail: { address_similarity: 0.558 },
  });

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const cards = page.getByTestId("dedup-suggestion-card");
    await expect(cards.first()).toHaveAttribute("data-suggestion-id", String(photoSuggestionId));

    const photoCard = page.locator(`[data-suggestion-id="${photoSuggestionId}"]`);
    await expect(photoCard.getByTestId("dedup-match-basis")).toHaveText(/fotos/i);
    await expect(photoCard.getByTestId("dedup-side-source")).toHaveText(["milanuncios", "fotocasa"]);
    await expect(photoCard.getByTestId("dedup-side-price").first()).toHaveText(/218.500/);

    const fuzzyCard = page.locator(`[data-suggestion-id="${fuzzySuggestionId}"]`);
    await expect(fuzzyCard).toBeVisible();
    await expect(fuzzyCard.getByTestId("dedup-match-basis")).toHaveText(/difuso/i);
  } finally {
    await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
      [photoSuggestionId, fuzzySuggestionId],
    ]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [
      [listingA, listingB, listingC, listingD],
    ]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB, propC, propD]]);
  }
});

test("profile-relevant pairs sort first, and the 'solo mis perfiles' toggle filters them (issue #246)", async ({
  page,
}) => {
  skipIfNoDb(test);

  const profileId = await insertProfile();

  // Relevant pair: LOWER confidence, but one side matches an active profile.
  const relA = await insertProperty({ address: `${NAME_PREFIX}Perfil Relevante A` });
  const relB = await insertProperty({ address: `${NAME_PREFIX}Perfil Relevante B` });
  const lRelA = await insertListing(relA, { source: "milanuncios", current_price: 210000 });
  const lRelB = await insertListing(relB, { source: "fotocasa", current_price: 210000 });
  await markProfileMatch(profileId, relA);
  const relevantId = await insertSuggestion(lRelA, lRelB, { match_basis: "fuzzy", confidence: 0.55 });

  // Non-relevant pair: HIGHER confidence, neither side matches any profile.
  const irrA = await insertProperty({ address: `${NAME_PREFIX}Sin Perfil A` });
  const irrB = await insertProperty({ address: `${NAME_PREFIX}Sin Perfil B` });
  const lIrrA = await insertListing(irrA, { source: "idealista", current_price: 305000 });
  const lIrrB = await insertListing(irrB, { source: "fotocasa", current_price: 305000 });
  const irrelevantId = await insertSuggestion(lIrrA, lIrrB, { match_basis: "photo_hash", confidence: 0.9 });

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const relCard = page.locator(`[data-suggestion-id="${relevantId}"]`);
    const irrCard = page.locator(`[data-suggestion-id="${irrelevantId}"]`);
    await expect(relCard).toBeVisible();
    await expect(irrCard).toBeVisible(); // default view hides NOTHING

    // Ordering (mutation check): the relevant pair renders before the
    // higher-confidence non-relevant one. Without `profile_relevant DESC` in
    // the ORDER BY, pure confidence DESC would flip this.
    const order = await page
      .getByTestId("dedup-suggestion-card")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-suggestion-id")));
    expect(order.indexOf(String(relevantId))).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(String(relevantId))).toBeLessThan(order.indexOf(String(irrelevantId)));

    // The relevant card is badged; the non-relevant one is not.
    await expect(relCard.getByTestId("dedup-profile-relevant-badge")).toBeVisible();
    await expect(irrCard.getByTestId("dedup-profile-relevant-badge")).toHaveCount(0);

    // Toggle to "solo mis perfiles": the non-relevant pair is filtered out.
    await page.getByTestId("dedup-toggle-relevant").click();
    await expect(relCard).toBeVisible();
    await expect(irrCard).toHaveCount(0);

    // Back to "ver todos": both reappear.
    await page.getByTestId("dedup-toggle-all").click();
    await expect(relCard).toBeVisible();
    await expect(irrCard).toBeVisible();
  } finally {
    await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
      [relevantId, irrelevantId],
    ]);
    await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
    await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [
      [lRelA, lRelB, lIrrA, lIrrB],
    ]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[relA, relB, irrA, irrB]]);
  }
});

test("filter chip narrows the queue to one match_basis", async ({ page }) => {
  skipIfNoDb(test);

  const propA = await insertProperty({ address: `${NAME_PREFIX}Filtro Foto A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Filtro Foto B` });
  const listingA = await insertListing(propA, { source: "milanuncios" });
  const listingB = await insertListing(propB, { source: "fotocasa" });
  const photoSuggestionId = await insertSuggestion(listingA, listingB, {
    match_basis: "photo_hash",
    confidence: 0.79,
    detail: { match_ratio: 0.95 },
  });

  const propC = await insertProperty({ address: `${NAME_PREFIX}Filtro Difuso A` });
  const propD = await insertProperty({ address: `${NAME_PREFIX}Filtro Difuso B` });
  const listingC = await insertListing(propC, { source: "idealista" });
  const listingD = await insertListing(propD, { source: "fotocasa" });
  const fuzzySuggestionId = await insertSuggestion(listingC, listingD, {
    match_basis: "fuzzy",
    confidence: 0.56,
  });

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);
    // toBeVisible auto-retries (unlike a bare .count(), which reads the DOM
    // once and can race the initial fetch) — waits for the async list fetch
    // to actually land before asserting anything about its contents.
    await expect(page.locator(`[data-suggestion-id="${fuzzySuggestionId}"]`)).toBeVisible();

    await page.getByTestId("dedup-filter-photo_hash").click();
    await expect(page.locator(`[data-suggestion-id="${photoSuggestionId}"]`)).toBeVisible();
    await expect(page.locator(`[data-suggestion-id="${fuzzySuggestionId}"]`)).toHaveCount(0);
    const visibleCards = page.getByTestId("dedup-suggestion-card");
    const count = await visibleCards.count();
    for (let i = 0; i < count; i++) {
      await expect(visibleCards.nth(i)).toHaveAttribute("data-match-basis", "photo_hash");
    }
  } finally {
    await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
      [photoSuggestionId, fuzzySuggestionId],
    ]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [
      [listingA, listingB, listingC, listingD],
    ]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB, propC, propD]]);
  }
});

test("confirm — real DB round trip: one property with both listings, and a property_merge_log row", async ({
  page,
}) => {
  skipIfNoDb(test);
  test.skip(!pythonAvailable, `no Python venv at ${VENV_PYTHON} — cannot exercise the real confirm path`);

  const propA = await insertProperty({ address: `${NAME_PREFIX}Confirmar A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Confirmar B` });
  const listingA = await insertListing(propA, { source: "milanuncios", current_price: 195000 });
  const listingB = await insertListing(propB, { source: "fotocasa", current_price: 195000 });
  const suggestionId = await insertSuggestion(listingA, listingB, {
    match_basis: "photo_hash",
    confidence: 0.8,
    detail: { match_ratio: 1.0 },
  });

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const card = page.locator(`[data-suggestion-id="${suggestionId}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId("dedup-confirm").click();

    // The enqueue is immediate (a plain INSERT) — the action row exists
    // right away, in 'pending' status, before any Python process has run.
    await expect
      .poll(async () => {
        const rows = await pool.query<{ count: string }>(
          "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = $1",
          [suggestionId],
        );
        return Number(rows.rows[0].count);
      })
      .toBeGreaterThan(0);

    // Real, deliberate subprocess call — see file header. This is the exact
    // code path `ps dedup process-actions` / the container's poll loop use.
    runDedupActionProcessorOnce();

    // The frontend polls GET /api/dedup/actions/[id] every ~1.5s; give it a
    // few cycles to observe the 'done' status and remove the card.
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await assertNoErrorSurface(page);

    // The real DB effect: one surviving property carries both listings.
    const listingRows = await pool.query<{ property_id: number }>(
      "SELECT DISTINCT property_id FROM listing WHERE id = ANY($1::bigint[])",
      [[listingA, listingB]],
    );
    expect(listingRows.rows).toHaveLength(1);
    const survivorId = listingRows.rows[0].property_id;

    // A real property_merge_log row for this merge.
    const mergeLogRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*) FROM property_merge_log WHERE property_id = $1",
      [survivorId],
    );
    expect(Number(mergeLogRows.rows[0].count)).toBeGreaterThan(0);

    const suggestionRows = await pool.query<{ status: string }>(
      "SELECT status FROM suggested_merge WHERE id = $1",
      [suggestionId],
    );
    expect(suggestionRows.rows[0].status).toBe("confirmed");
  } finally {
    await pool.query("DELETE FROM property_merge_log WHERE property_id = ANY($1::bigint[]) " +
      "OR losing_property_id = ANY($1::bigint[])", [[propA, propB]]);
    await pool.query("DELETE FROM suggested_merge_action WHERE suggestion_id = $1", [suggestionId]);
    await pool.query("DELETE FROM suggested_merge WHERE id = $1", [suggestionId]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA, listingB]]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
  }
});

test("reject — the pair disappears from the queue and is marked rejected, without merging", async ({ page }) => {
  skipIfNoDb(test);
  test.skip(!pythonAvailable, `no Python venv at ${VENV_PYTHON} — cannot exercise the real reject path`);

  const propA = await insertProperty({ address: `${NAME_PREFIX}Rechazar A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Rechazar B` });
  const listingA = await insertListing(propA, { source: "milanuncios" });
  const listingB = await insertListing(propB, { source: "fotocasa" });
  const suggestionId = await insertSuggestion(listingA, listingB, {
    match_basis: "fuzzy",
    confidence: 0.57,
  });

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const card = page.locator(`[data-suggestion-id="${suggestionId}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId("dedup-reject").click();

    await expect
      .poll(async () => {
        const rows = await pool.query<{ count: string }>(
          "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = $1",
          [suggestionId],
        );
        return Number(rows.rows[0].count);
      })
      .toBeGreaterThan(0);

    runDedupActionProcessorOnce();

    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await assertNoErrorSurface(page);

    const suggestionRows = await pool.query<{ status: string }>(
      "SELECT status FROM suggested_merge WHERE id = $1",
      [suggestionId],
    );
    expect(suggestionRows.rows[0].status).toBe("rejected");

    // No merge happened — both properties still stand alone.
    const listingRows = await pool.query<{ property_id: number }>(
      "SELECT DISTINCT property_id FROM listing WHERE id = ANY($1::bigint[])",
      [[listingA, listingB]],
    );
    expect(listingRows.rows).toHaveLength(2);
  } finally {
    await pool.query("DELETE FROM suggested_merge_action WHERE suggestion_id = $1", [suggestionId]);
    await pool.query("DELETE FROM suggested_merge WHERE id = $1", [suggestionId]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA, listingB]]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
  }
});
