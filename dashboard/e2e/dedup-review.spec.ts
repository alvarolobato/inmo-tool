/**
 * E2E: the dedup review-queue UI (/admin/dedup) — the "missing half of the
 * dedup workflow". PR #187 wired the dedup engine into the pipeline; a real
 * run against the owner's live data produced 585 `suggested_merge` rows with
 * no UI anywhere that could act on one. Issue #605 Part 2 then regrouped
 * the queue by PROPERTY pair (#600 measured 892 pending listing-pair rows
 * collapsing to 669 distinct property-pair questions, one pair alone
 * repeating the identical question 38 times) — this spec was rewritten
 * accordingly: cards are keyed on `data-pair-key`, not a single
 * `suggestion-id`, and a dedicated test proves the collapse itself.
 *
 * The confirm/reject flows are the only tests here that do NOT run against
 * a mocked or simulated backend for the merge itself. Confirming/rejecting
 * in the browser only enqueues `suggested_merge_action` row(s) (see
 * lib/dedup.ts's module docstring) — the actual merge/reject is performed
 * by the ETL container's `etl/dedup/actions.py` poll loop, which is Python
 * and does not run as part of `npm run dev` / this Playwright config's
 * `webServer`. Rather than mock that boundary away, these tests invoke the
 * REAL Python processor once via `python -m etl.dedup.cli process-actions`
 * (the exact code path `ps dedup process-actions` and the container's
 * background poll loop both call — see `runDedupActionProcessorOnce`
 * below) against the SAME Postgres the dev server is pointed at, then
 * assert the real DB result.
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

/** The pair_key the grouped queue derives — canonical lower-id-first
 * property order, matching lib/dedup.ts's `PENDING_PAIR_CTE`. */
function pairKeyOf(propA: number, propB: number): string {
  const [lo, hi] = [propA, propB].sort((a, b) => a - b);
  return `${lo}-${hi}`;
}

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
  await expect(page.getByTestId("dedup-pair-card")).toHaveCount(0);
});

test("renders both sides of a real photo_hash pair, ordered ahead of a weaker fuzzy one", async ({ page }) => {
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
  const photoPairKey = pairKeyOf(propA, propB);

  const propC = await insertProperty({ address: `${NAME_PREFIX}Calle Difuso A` });
  const propD = await insertProperty({ address: `${NAME_PREFIX}Calle Difuso B` });
  const listingC = await insertListing(propC, { source: "idealista", current_price: 150000 });
  const listingD = await insertListing(propD, { source: "fotocasa", current_price: 152000 });
  const fuzzySuggestionId = await insertSuggestion(listingC, listingD, {
    match_basis: "fuzzy",
    confidence: 0.58,
    detail: { address_similarity: 0.558 },
  });
  const fuzzyPairKey = pairKeyOf(propC, propD);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const cards = page.getByTestId("dedup-pair-card");
    await expect(cards.first()).toHaveAttribute("data-pair-key", photoPairKey);

    const photoCard = page.locator(`[data-pair-key="${photoPairKey}"]`);
    await expect(photoCard.getByTestId("dedup-match-basis")).toHaveText(/fotos/i);
    await expect(photoCard.getByTestId("dedup-side-source")).toHaveText(["milanuncios", "fotocasa"]);
    await expect(photoCard.getByTestId("dedup-side-price").first()).toHaveText(/218.500/);

    const fuzzyCard = page.locator(`[data-pair-key="${fuzzyPairKey}"]`);
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

test("collapses every pending listing-pair row for the same two properties into ONE card (issue #605 Part 2)", async ({
  page,
}) => {
  skipIfNoDb(test);

  // property A: 3 listings. property B: 1 listing. 3 listing-pair rows,
  // same property pair — must render as ONE card, not three. N=3 (not
  // N=2, PR #611 second review M-4) deliberately, so the badge's total
  // (pair_count) and the toggle's "others" count (pair_count - 1) are
  // distinctly different numbers (3 vs 2), and this fixture's own
  // assertion cross-checks both in the SAME string rather than baking a
  // discrepancy in without catching it, as every prior N=2 version did.
  const propA = await insertProperty({ address: `${NAME_PREFIX}Grupo A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Grupo B` });
  const listingA1 = await insertListing(propA, { source: "milanuncios", current_price: 180000 });
  const listingA2 = await insertListing(propA, { source: "idealista", current_price: 180000 });
  const listingA3 = await insertListing(propA, { source: "pisos", current_price: 180000 });
  const listingB1 = await insertListing(propB, { source: "fotocasa", current_price: 180000 });
  const weakId1 = await insertSuggestion(listingA1, listingB1, { match_basis: "fuzzy", confidence: 0.55 });
  const weakId2 = await insertSuggestion(listingA3, listingB1, { match_basis: "fuzzy", confidence: 0.6 });
  const strongId = await insertSuggestion(listingA2, listingB1, { match_basis: "photo_hash", confidence: 0.85 });
  const pairKey = pairKeyOf(propA, propB);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const card = page.locator(`[data-pair-key="${pairKey}"]`);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-pair-count", "3");
    // Leads with the strongest evidence (photo_hash 85%).
    await expect(card.getByTestId("dedup-match-basis")).toHaveText(/fotos/i);
    // Badge: the TOTAL (3), consistent noun ("pares", never "anuncios").
    await expect(card.getByTestId("dedup-pair-count-badge")).toHaveText(/3 pares corroborantes/i);

    // Toggle: the OTHER count (2, = 3 - 1, excluding the primary shown
    // above) AND the total (3) both appear together in the SAME string —
    // PR #611 second review M-4: if the total/others relationship ever
    // breaks (e.g. both start reading the same field), this single
    // assertion catches it instead of two independently-plausible
    // numbers that happen not to collide.
    const toggle = card.getByTestId("dedup-evidence-toggle");
    await expect(toggle).toHaveText(/otros 2 pares \(de 3 en total\)/i);

    // The weaker corroborating rows are not lost — reachable, collapsed.
    await expect(card.getByTestId("dedup-evidence-row")).toHaveCount(0);
    await toggle.click();
    await expect(card.getByTestId("dedup-evidence-row")).toHaveCount(2);
    await expect(card.getByTestId("dedup-evidence-row").first()).toContainText(/difuso/i);
  } finally {
    await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
      [weakId1, weakId2, strongId],
    ]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [
      [listingA1, listingA2, listingA3, listingB1],
    ]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
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
  const relevantKey = pairKeyOf(relA, relB);

  // Non-relevant pair: HIGHER confidence, neither side matches any profile.
  const irrA = await insertProperty({ address: `${NAME_PREFIX}Sin Perfil A` });
  const irrB = await insertProperty({ address: `${NAME_PREFIX}Sin Perfil B` });
  const lIrrA = await insertListing(irrA, { source: "idealista", current_price: 305000 });
  const lIrrB = await insertListing(irrB, { source: "fotocasa", current_price: 305000 });
  const irrelevantId = await insertSuggestion(lIrrA, lIrrB, { match_basis: "photo_hash", confidence: 0.9 });
  const irrelevantKey = pairKeyOf(irrA, irrB);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const relCard = page.locator(`[data-pair-key="${relevantKey}"]`);
    const irrCard = page.locator(`[data-pair-key="${irrelevantKey}"]`);
    await expect(relCard).toBeVisible();
    await expect(irrCard).toBeVisible(); // default view hides NOTHING

    // Ordering (mutation check): the relevant pair renders before the
    // higher-confidence non-relevant one. Without `profile_relevant DESC` in
    // the ORDER BY, pure confidence DESC would flip this.
    const order = await page
      .getByTestId("dedup-pair-card")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-pair-key")));
    expect(order.indexOf(relevantKey)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(relevantKey)).toBeLessThan(order.indexOf(irrelevantKey));

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

test("filter chip narrows the queue to groups whose strongest evidence is one match_basis", async ({ page }) => {
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
  const photoKey = pairKeyOf(propA, propB);

  const propC = await insertProperty({ address: `${NAME_PREFIX}Filtro Difuso A` });
  const propD = await insertProperty({ address: `${NAME_PREFIX}Filtro Difuso B` });
  const listingC = await insertListing(propC, { source: "idealista" });
  const listingD = await insertListing(propD, { source: "fotocasa" });
  const fuzzySuggestionId = await insertSuggestion(listingC, listingD, {
    match_basis: "fuzzy",
    confidence: 0.56,
  });
  const fuzzyKey = pairKeyOf(propC, propD);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);
    // toBeVisible auto-retries (unlike a bare .count(), which reads the DOM
    // once and can race the initial fetch) — waits for the async list fetch
    // to actually land before asserting anything about its contents.
    await expect(page.locator(`[data-pair-key="${fuzzyKey}"]`)).toBeVisible();

    await page.getByTestId("dedup-filter-photo_hash").click();
    await expect(page.locator(`[data-pair-key="${photoKey}"]`)).toBeVisible();
    await expect(page.locator(`[data-pair-key="${fuzzyKey}"]`)).toHaveCount(0);
    const visibleCards = page.getByTestId("dedup-pair-card");
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
  const pairKey = pairKeyOf(propA, propB);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const card = page.locator(`[data-pair-key="${pairKey}"]`);
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

test("confirm on a MULTI-ROW group merges via the representative row only, and the sibling clears from the queue immediately (issue #605 Part 2, D-133 point 2 — PR #611 review M4)", async ({
  page,
}) => {
  skipIfNoDb(test);
  test.skip(!pythonAvailable, `no Python venv at ${VENV_PYTHON} — cannot exercise the real confirm path`);

  // property A has 2 listings, property B has 1 — 2 pending listing-pair
  // rows for the same property pair. Confirming the CARD only submits the
  // strongest-evidence (photo_hash) row; the fuzzy sibling is never
  // itself confirmed — it clears because BOTH its listings end up sharing
  // a property once the representative's merge moves every listing off
  // the losing property (issue #605 Part 1's same-property filter),
  // before the dedup engine's next scheduled pass ever formally flips its
  // DB status.
  const propA = await insertProperty({ address: `${NAME_PREFIX}Confirmar Multi A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Confirmar Multi B` });
  const listingA1 = await insertListing(propA, { source: "milanuncios", current_price: 210000 });
  const listingA2 = await insertListing(propA, { source: "idealista", current_price: 210000 });
  const listingB1 = await insertListing(propB, { source: "fotocasa", current_price: 210000 });
  const weakSuggestion = await insertSuggestion(listingA1, listingB1, { match_basis: "fuzzy", confidence: 0.6 });
  const strongSuggestion = await insertSuggestion(listingA2, listingB1, {
    match_basis: "photo_hash",
    confidence: 0.85,
    detail: { match_ratio: 1.0 },
  });
  const pairKey = pairKeyOf(propA, propB);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const card = page.locator(`[data-pair-key="${pairKey}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-pair-count", "2");
    await card.getByTestId("dedup-confirm").click();

    // ONE action, against the strongest-evidence row — never one per
    // underlying suggestion.
    await expect
      .poll(async () => {
        const rows = await pool.query<{ count: string }>(
          "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = $1 AND action = 'confirm'",
          [strongSuggestion],
        );
        return Number(rows.rows[0].count);
      })
      .toBe(1);
    const weakActionRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = $1",
      [weakSuggestion],
    );
    expect(Number(weakActionRows.rows[0].count)).toBe(0);

    runDedupActionProcessorOnce();

    // The whole card clears — not just the representative row's half.
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await assertNoErrorSurface(page);

    // Real DB effect: all three listings end up on one surviving property.
    const listingRows = await pool.query<{ property_id: number }>(
      "SELECT DISTINCT property_id FROM listing WHERE id = ANY($1::bigint[])",
      [[listingA1, listingA2, listingB1]],
    );
    expect(listingRows.rows).toHaveLength(1);

    const strongStatus = await pool.query<{ status: string }>(
      "SELECT status FROM suggested_merge WHERE id = $1",
      [strongSuggestion],
    );
    expect(strongStatus.rows[0].status).toBe("confirmed");

    // The sibling was NEVER itself confirmed by an action — its DB status
    // may still genuinely read 'pending' at this instant (it formally
    // resolves on the dedup engine's own next scheduled pass, D-133 point
    // 2) — the point of this assertion is that the QUEUE already hid it,
    // proven above by the whole card disappearing in one poll cycle.
    const weakStatus = await pool.query<{ status: string }>(
      "SELECT status FROM suggested_merge WHERE id = $1",
      [weakSuggestion],
    );
    expect(["pending", "confirmed"]).toContain(weakStatus.rows[0].status);
  } finally {
    await pool.query("DELETE FROM property_merge_log WHERE property_id = ANY($1::bigint[]) " +
      "OR losing_property_id = ANY($1::bigint[])", [[propA, propB]]);
    await pool.query("DELETE FROM suggested_merge_action WHERE suggestion_id = ANY($1::bigint[])", [
      [weakSuggestion, strongSuggestion],
    ]);
    await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
      [weakSuggestion, strongSuggestion],
    ]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA1, listingA2, listingB1]]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
  }
});

test("reject requires a second, explicit tap — and the real DB round trip vetoes the WHOLE property pair, atomically, without merging", async ({
  page,
}) => {
  skipIfNoDb(test);
  test.skip(!pythonAvailable, `no Python venv at ${VENV_PYTHON} — cannot exercise the real reject path`);

  // A 2-row group: rejecting the CARD must reject BOTH underlying pairs
  // AND persist a property_merge_veto (issue #605 Part 2 revision, PR #611
  // review B1) — rejection is permanent, and a per-listing-pair-only
  // reject left OTHER listing combinations between the same two
  // properties free to resurface, which is exactly the bug the review
  // caught live.
  const propA = await insertProperty({ address: `${NAME_PREFIX}Rechazar A` });
  const propB = await insertProperty({ address: `${NAME_PREFIX}Rechazar B` });
  const listingA1 = await insertListing(propA, { source: "milanuncios" });
  const listingA2 = await insertListing(propA, { source: "idealista" });
  const listingB1 = await insertListing(propB, { source: "fotocasa" });
  const suggestion1 = await insertSuggestion(listingA1, listingB1, { match_basis: "fuzzy", confidence: 0.57 });
  const suggestion2 = await insertSuggestion(listingA2, listingB1, { match_basis: "fuzzy", confidence: 0.55 });
  const pairKey = pairKeyOf(propA, propB);

  try {
    await page.goto("/admin/dedup");
    await assertNoErrorSurface(page);

    const card = page.locator(`[data-pair-key="${pairKey}"]`);
    await expect(card).toBeVisible();

    // First tap: shows the "this is permanent, N pares" warning — does NOT
    // submit anything yet.
    await card.getByTestId("dedup-reject").click();
    await expect(card.getByTestId("dedup-reject-warning")).toBeVisible();
    await expect
      .poll(async () => {
        const rows = await pool.query<{ count: string }>(
          "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = ANY($1::bigint[])",
          [[suggestion1, suggestion2]],
        );
        return Number(rows.rows[0].count);
      })
      .toBe(0);

    // Second tap: submits ONE atomic action against the representative
    // (strongest-evidence) suggestion — never a fan-out — so no
    // partial-failure state to strand the card in (PR #611 review M3).
    await card.getByTestId("dedup-reject").click();
    await expect
      .poll(async () => {
        const rows = await pool.query<{ count: string }>(
          "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = $1 AND action = 'reject_pair'",
          [suggestion1],
        );
        return Number(rows.rows[0].count);
      })
      .toBe(1);
    // And never one for the sibling — the engine derives the whole group
    // server-side from the ONE action it receives.
    const siblingActionRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*) FROM suggested_merge_action WHERE suggestion_id = $1",
      [suggestion2],
    );
    expect(Number(siblingActionRows.rows[0].count)).toBe(0);

    runDedupActionProcessorOnce();

    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await assertNoErrorSurface(page);

    // BOTH underlying rows rejected, though only one was named in the
    // action — engine.reject_property_pair resolves the whole pair.
    const suggestionRows = await pool.query<{ id: number; status: string }>(
      "SELECT id, status FROM suggested_merge WHERE id = ANY($1::bigint[]) ORDER BY id",
      [[suggestion1, suggestion2]],
    );
    expect(suggestionRows.rows).toHaveLength(2);
    for (const row of suggestionRows.rows) {
      expect(row.status).toBe("rejected");
    }

    // The permanent property-level veto now exists.
    const [vetoLo, vetoHi] = [propA, propB].sort((a, b) => a - b);
    const vetoRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*) FROM property_merge_veto WHERE property_lo_id = $1 AND property_hi_id = $2",
      [vetoLo, vetoHi],
    );
    expect(Number(vetoRows.rows[0].count)).toBe(1);

    // No merge happened — the properties still stand alone.
    const listingRows = await pool.query<{ property_id: number }>(
      "SELECT DISTINCT property_id FROM listing WHERE id = ANY($1::bigint[])",
      [[listingA1, listingA2, listingB1]],
    );
    expect(listingRows.rows).toHaveLength(2);
  } finally {
    await pool.query("DELETE FROM property_merge_veto WHERE property_lo_id = ANY($1::bigint[]) " +
      "OR property_hi_id = ANY($1::bigint[])", [[propA, propB]]);
    await pool.query("DELETE FROM suggested_merge_action WHERE suggestion_id = ANY($1::bigint[])", [
      [suggestion1, suggestion2],
    ]);
    await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [[suggestion1, suggestion2]]);
    await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA1, listingA2, listingB1]]);
    await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
  }
});
