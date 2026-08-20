/**
 * E2E: `/admin/dedup` at phone width (#576).
 *
 * `/admin/dedup` carries a 28k-row suggested-merge backlog that can only be
 * worked by eye, confirm/reject, one pair at a time — the kind of task an
 * operator does on a phone with a spare five minutes. It was unusable there:
 * `SuggestionCard`'s comparison row was `flexWrap: "wrap"` but each panel
 * had `flex: 1` (flex-basis 0%), which made the wrap inert — the panels
 * always "fit" by shrinking to ~140px instead of ever wrapping, and the
 * `repeat(4, 1fr)` photo grid inside that produced ~32px thumbnails. Nothing
 * overflowed and nothing errored, so it silently degraded rather than
 * failing loudly.
 *
 * This spec seeds one profile-relevant, confidence-1.0 `suggested_merge`
 * row (sorts to the very top of the default queue — see lib/dedup.ts's
 * `ORDER BY profile_relevant DESC, top_confidence DESC, latest_created_at
 * DESC` — so the assertions don't depend on queue contents at test time)
 * and drives the real page under `devices["iPhone 13"]` emulation, keyed
 * on `data-pair-key` since issue #605 Part 2 regrouped the queue by
 * property pair (a card's identity is no longer one `suggestion-id`).
 * Asserts against
 * `document.documentElement.clientWidth` — NOT `window.innerWidth`, which
 * reports 653 under this project's Chromium mobile emulation and would
 * silently hide every one of these failures (see card-detail-ux.spec.ts's
 * iPhone 13 block for the same emulation pattern, and #576's own writeup of
 * this exact `innerWidth` trap).
 *
 * "No horizontal overflow" alone would already pass on the OLD, broken
 * layout — it never overflowed, it just shrank. Every assertion here checks
 * an actual size/position number instead.
 *
 * Skips cleanly if no DB is reachable — same pattern as dedup-review.spec.ts.
 */
import { test, expect, devices, type Page } from "@playwright/test";
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

const NAME_PREFIX = "e2e-mobile-dedup-";

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
  overrides: { match_basis?: string; confidence?: number } = {},
): Promise<number> {
  const [lo, hi] = [listingA, listingB].sort((a, b) => a - b);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suggested_merge (listing_id_a, listing_id_b, match_basis, confidence, detail)
     VALUES ($1, $2, $3, $4, '{"match_ratio": 1.0}'::jsonb) RETURNING id`,
    [lo, hi, overrides.match_basis ?? "photo_hash", overrides.confidence ?? 1.0],
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
      "[mobile-dedup.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

// Destructure out `defaultBrowserType` (webkit) — this project's single
// Playwright project is chromium (playwright.config.ts); see
// card-detail-ux.spec.ts's identical iPhone 13 block for why.
const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
test.use({ ...iPhone13 });

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

test.describe("#576: /admin/dedup at phone width (iPhone 13 emulation)", () => {
  test("comparison panels stack at phone width", async ({ page }) => {
    skipIfNoDb(test);

    const profileId = await insertProfile();
    const propA = await insertProperty({ address: `${NAME_PREFIX}Calle Movil A` });
    const propB = await insertProperty({ address: `${NAME_PREFIX}Calle Movil B` });
    const listingA = await insertListing(propA, {
      source: "milanuncios",
      current_price: 199000,
      photo_urls: [
        "https://img.example.com/mobile-a1.jpg",
        "https://img.example.com/mobile-a2.jpg",
        "https://img.example.com/mobile-a3.jpg",
        "https://img.example.com/mobile-a4.jpg",
      ],
    });
    const listingB = await insertListing(propB, {
      source: "fotocasa",
      current_price: 199000,
      photo_urls: [
        "https://img.example.com/mobile-b1.jpg",
        "https://img.example.com/mobile-b2.jpg",
      ],
    });
    await markProfileMatch(profileId, propA);
    const suggestionId = await insertSuggestion(listingA, listingB);
    const pairKey = pairKeyOf(propA, propB);

    try {
      await page.goto("/admin/dedup");
      await assertNoErrorSurface(page);

      // Never window.innerWidth here — under this project's Chromium mobile
      // emulation it reports 653 (the layout viewport before scaling), which
      // silently hides every failure this spec exists to catch.
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(clientWidth).toBeLessThanOrEqual(400);

      const card = page.locator(`[data-pair-key="${pairKey}"]`);
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();

      const panels = card.locator(".dedup-side-panel");
      await expect(panels).toHaveCount(2);
      const panelABox = await panels.nth(0).boundingBox();
      const panelBBox = await panels.nth(1).boundingBox();
      expect(panelABox).not.toBeNull();
      expect(panelBBox).not.toBeNull();

      // Stacked, not side-by-side: the second panel starts below the first
      // one ends (the old bug rendered them on the same row).
      expect(panelBBox!.y).toBeGreaterThan(panelABox!.y + panelABox!.height - 1);

      // Each panel is close to the full available row width, not squeezed
      // to a ~140px sliver (the old flex-basis-0 bug). 300px is issue
      // #576's own stated bar (not just "bigger than the bug") — this
      // layout ships at ~308px locally, so there's a real but tight margin;
      // tightening further would make the assertion chase this specific
      // build's rounding rather than the actual requirement.
      expect(panelABox!.width).toBeGreaterThanOrEqual(300);
      expect(panelBBox!.width).toBeGreaterThanOrEqual(300);

      // Photos: legible, not ~32px thumbnails. 130x95 is comfortably below
      // the ~148x111 a fixed layout renders locally and comfortably above
      // the old bug's ~32px, so it still catches a regression partway back
      // toward the bug without pinning this exact build's pixel values.
      const photos = card.locator(".dedup-photo-grid img");
      const photoCount = await photos.count();
      expect(photoCount).toBeGreaterThan(0);
      for (let i = 0; i < photoCount; i++) {
        const box = await photos.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(130);
        expect(box!.height).toBeGreaterThanOrEqual(95);
      }

      // No horizontal overflow of the PAGE CONTENT this PR owns. Checked in
      // ADDITION to the above, never instead of it — the old broken layout
      // never overflowed either (it degraded by shrinking, not by
      // spilling), so this alone would have passed on the bug.
      //
      // Scoped to `main.main-content` rather than `document.documentElement`
      // on purpose: TopBar (issue #571, explicitly out of scope for #576 —
      // see AGENTS.md's in-flight-branch list) renders a desktop-width nav
      // row even at this viewport and overflows the DOCUMENT today,
      // independent of anything this spec's card touches. A document-wide
      // check would fail on that pre-existing, separately-owned bug and
      // mask whether THIS PR's own layout overflows, which is what this
      // assertion exists to catch.
      const hasHorizontalOverflow = await page.evaluate(() => {
        const main = document.querySelector("main.main-content");
        return main !== null && main.scrollWidth > main.clientWidth;
      });
      expect(hasHorizontalOverflow).toBe(false);
    } finally {
      await pool.query("DELETE FROM suggested_merge WHERE id = $1", [suggestionId]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
      await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
      await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA, listingB]]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
    }
  });

  test("review actions are tappable", async ({ page }) => {
    skipIfNoDb(test);

    const profileId = await insertProfile();
    const propA = await insertProperty({ address: `${NAME_PREFIX}Calle Tappable A` });
    const propB = await insertProperty({ address: `${NAME_PREFIX}Calle Tappable B` });
    const listingA = await insertListing(propA, { source: "milanuncios", current_price: 150000 });
    const listingB = await insertListing(propB, { source: "fotocasa", current_price: 150000 });
    await markProfileMatch(profileId, propA);
    const suggestionId = await insertSuggestion(listingA, listingB);
    const pairKey = pairKeyOf(propA, propB);

    try {
      await page.goto("/admin/dedup");
      await assertNoErrorSurface(page);

      const card = page.locator(`[data-pair-key="${pairKey}"]`);
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();

      // WCAG 2.5.5's 44px minimum target size — confirm/reject are a
      // destructive-ish decision taken with a thumb. The old layout measured
      // ~29-33px tall.
      const confirmBox = await card.getByTestId("dedup-confirm").boundingBox();
      const rejectBox = await card.getByTestId("dedup-reject").boundingBox();
      expect(confirmBox).not.toBeNull();
      expect(rejectBox).not.toBeNull();
      expect(confirmBox!.height).toBeGreaterThanOrEqual(44);
      expect(confirmBox!.width).toBeGreaterThanOrEqual(44);
      expect(rejectBox!.height).toBeGreaterThanOrEqual(44);
      expect(rejectBox!.width).toBeGreaterThanOrEqual(44);
    } finally {
      await pool.query("DELETE FROM suggested_merge WHERE id = $1", [suggestionId]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
      await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
      await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA, listingB]]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
    }
  });

  test("a multi-row group's badge, evidence toggle, evidence list and reject warning are all usable at phone width (issue #605 Part 2 revision, PR #611 review M2)", async ({
    page,
  }) => {
    skipIfNoDb(test);

    // property A has 2 listings, property B has 1 — 2 pending listing-pair
    // rows for the SAME property pair, the exact multi-row-group shape
    // nothing at phone width exercised before this test (M2: both prior
    // mobile tests seeded exactly one listing pair per property pair).
    const propA = await insertProperty({ address: `${NAME_PREFIX}Grupo Movil A` });
    const propB = await insertProperty({ address: `${NAME_PREFIX}Grupo Movil B` });
    const listingA1 = await insertListing(propA, { source: "milanuncios", current_price: 175000 });
    const listingA2 = await insertListing(propA, { source: "idealista", current_price: 175000 });
    const listingB1 = await insertListing(propB, { source: "fotocasa", current_price: 175000 });
    const weakSuggestion = await insertSuggestion(listingA1, listingB1, { match_basis: "fuzzy", confidence: 0.6 });
    const strongSuggestion = await insertSuggestion(listingA2, listingB1, {
      match_basis: "photo_hash",
      confidence: 0.9,
    });
    const pairKey = pairKeyOf(propA, propB);

    try {
      await page.goto("/admin/dedup");
      await assertNoErrorSurface(page);

      const card = page.locator(`[data-pair-key="${pairKey}"]`);
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await expect(card).toHaveAttribute("data-pair-count", "2");

      // Badge: correct count, consistent noun ("pares", never "anuncios" —
      // PR #611 review B3).
      await expect(card.getByTestId("dedup-pair-count-badge")).toHaveText(/2 pares corroborantes/i);

      // Evidence toggle: a real 44px tap target (measured 18px before this
      // fix, PR #611 review M1) — it's the ONLY route to the corroborating
      // evidence a bulk decision should be informed by.
      const toggle = card.getByTestId("dedup-evidence-toggle");
      const toggleBox = await toggle.boundingBox();
      expect(toggleBox).not.toBeNull();
      expect(toggleBox!.height).toBeGreaterThanOrEqual(44);

      await expect(card.getByTestId("dedup-evidence-row")).toHaveCount(0);
      await toggle.click();
      await expect(card.getByTestId("dedup-evidence-row")).toHaveCount(1);
      await expect(card.getByTestId("dedup-evidence-row")).toContainText(/difuso/i);

      // Reject warning: names the true pair count with the same noun as
      // the badge/button.
      await card.getByTestId("dedup-reject").click();
      await expect(card.getByTestId("dedup-reject-warning")).toHaveText(/2 pares/i);
      await expect(card.getByTestId("dedup-reject")).toHaveText(/sí, rechazar/i);
      // Cancel — this test only proves the UI is usable at phone width,
      // not the real reject round trip (dedup-review.spec.ts's desktop
      // test already covers that, including the Python subprocess call).
      await card.getByTestId("dedup-reject-cancel").click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const main = document.querySelector("main.main-content");
        return main !== null && main.scrollWidth > main.clientWidth;
      });
      expect(hasHorizontalOverflow).toBe(false);
    } finally {
      await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
        [weakSuggestion, strongSuggestion],
      ]);
      await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA1, listingA2, listingB1]]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
    }
  });
});
