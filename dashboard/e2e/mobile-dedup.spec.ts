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
  overrides: { source: string; current_price?: number; photo_urls?: string[]; url?: string },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, current_price, photo_urls, url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      propertyId,
      overrides.source,
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      overrides.current_price ?? 200000,
      overrides.photo_urls ?? null,
      overrides.url ?? null,
    ],
  );
  return result.rows[0].id;
}

async function insertSuggestion(
  listingA: number,
  listingB: number,
  overrides: { match_basis?: string; confidence?: number; detail?: Record<string, unknown> } = {},
): Promise<number> {
  const [lo, hi] = [listingA, listingB].sort((a, b) => a - b);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suggested_merge (listing_id_a, listing_id_b, match_basis, confidence, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [
      lo,
      hi,
      overrides.match_basis ?? "photo_hash",
      overrides.confidence ?? 1.0,
      JSON.stringify(overrides.detail ?? { match_ratio: 1.0 }),
    ],
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
    //
    // Profile-matched (PR #611 second review M-5): the queue's default
    // order is `profile_relevant DESC, top_confidence DESC, ...` with a
    // page size of 30 — without a profile match, this fixture's 0.9
    // confidence is no guarantee of landing on page 1 against a REAL
    // backlog (unlike a fresh isolated test DB, which this test also
    // runs against, but the other two tests in this file already made a
    // profile match a habit, and a real dev-server run against a live
    // DB is exactly the scenario this would otherwise be silently
    // flaky under).
    const profileId = await insertProfile();
    const propA = await insertProperty({ address: `${NAME_PREFIX}Grupo Movil A` });
    const propB = await insertProperty({ address: `${NAME_PREFIX}Grupo Movil B` });
    const listingA1 = await insertListing(propA, { source: "milanuncios", current_price: 175000 });
    const listingA2 = await insertListing(propA, { source: "idealista", current_price: 175000 });
    const listingB1 = await insertListing(propB, { source: "fotocasa", current_price: 175000 });
    await markProfileMatch(profileId, propA);
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
      // pair_count (2) stays on the card only as a debug/test attribute —
      // issue #615/D-135: never rendered as its own "N pares" number.
      await expect(card).toHaveAttribute("data-pair-count", "2");

      // Advert counts per side (2 ↔ 1), not the internal pair count.
      await expect(card.getByTestId("dedup-advert-counts")).toHaveText(/2 anuncios ↔ 1 anuncio/i);
      await expect(card.getByTestId("dedup-pair-count-badge")).toHaveCount(0);
      await expect(card).not.toContainText(/pares/i);

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

      // Reject warning: names the two sides' advert counts, not the raw
      // internal pair count (issue #615/D-135).
      await card.getByTestId("dedup-reject").click();
      await expect(card.getByTestId("dedup-reject-warning")).toHaveText(/anuncios \(2 ↔ 1\)/i);
      await expect(card.getByTestId("dedup-reject")).toHaveText(/sí, rechazar/i);
      // Cancel — this test only proves the UI is usable at phone width,
      // not the real reject round trip (dedup-review.spec.ts's desktop
      // test already covers that, including the Python subprocess call).
      // PR #611 second review M-5: assert the cancel actually did
      // something, not just that clicking it didn't throw — the warning
      // disappears and the button reverts to its normal (non-committing)
      // label, so a regression that makes cancel a no-op is caught here.
      await card.getByTestId("dedup-reject-cancel").click();
      await expect(card.getByTestId("dedup-reject-warning")).toHaveCount(0);
      await expect(card.getByTestId("dedup-reject-cancel")).toHaveCount(0);
      await expect(card.getByTestId("dedup-reject")).toHaveText(/^rechazar$/i);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const main = document.querySelector("main.main-content");
        return main !== null && main.scrollWidth > main.clientWidth;
      });
      expect(hasHorizontalOverflow).toBe(false);
    } finally {
      await pool.query("DELETE FROM suggested_merge WHERE id = ANY($1::bigint[])", [
        [weakSuggestion, strongSuggestion],
      ]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
      await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
      await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA1, listingA2, listingB1]]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
    }
  });

  test("issue #626: photo-match card shows EVERY photo (no cap), matched-first, buttons stay reachable, plus asymmetric advert counts, at phone width", async ({
    page,
  }) => {
    skipIfNoDb(test);

    // Deliberately asymmetric — 7 vs 13, the live case that motivated
    // #615 (property 1729: 7 sale listings, 4 fotocasa + 3 idealista;
    // property 1732: 13, 11 fotocasa + 2 idealista). A symmetric fixture
    // (#611 shipped N=2 on both sides) cannot catch a count that reads
    // the wrong field — 7 and 1 (or 2 and 2) can coincidentally agree
    // with the internal pair count on a small enough fixture.
    const profileId = await insertProfile();
    const propA = await insertProperty({ address: `${NAME_PREFIX}Foto Asimetrica A` });
    const propB = await insertProperty({ address: `${NAME_PREFIX}Foto Asimetrica B` });

    // The photo_hash-matching pair itself: 6 photos on one side, 14 on
    // the other — BOTH well above 4, issue #626's own bar: a <=4-photo
    // fixture would pass whether or not the cap was actually removed,
    // exactly the decorative-test shape the brief warns against. Direct
    // owner instruction (mid-#615): the true match must NOT sit at the
    // same index on both sides — here it's index 5 of the 6-photo side
    // against index 9 of the 14-photo side.
    const photosLo = Array.from({ length: 6 }, (_, i) => `https://img.example.com/626-lo-${i}.jpg`);
    const photosHi = Array.from({ length: 14 }, (_, i) => `https://img.example.com/626-hi-${i}.jpg`);
    const matchedUrlLo = photosLo[5];
    const matchedUrlHi = photosHi[9];
    const matchingA = await insertListing(propA, {
      source: "fotocasa",
      current_price: 220000,
      photo_urls: photosLo,
      // A real `url` here (PR #631 review fix 1) — this side also has a
      // matched active profile (markProfileMatch below), so BOTH the
      // portal link and the internal link render stacked in the same
      // panel, exactly the shape that measured as two adjacent
      // 16.5px-tall, 2px-apart tap targets before the fix.
      url: "https://www.fotocasa.es/es/comprar/vivienda/626-mobile-a",
    });
    const matchingB = await insertListing(propB, {
      source: "idealista",
      current_price: 220000,
      photo_urls: photosHi,
    });

    // The rest of each side's adverts — no photos needed, they only exist
    // to make listing_count_lo/hi genuinely 7 and 13 (not just pair_count
    // coincidentally matching).
    const restA = await Promise.all(
      Array.from({ length: 6 }, () => insertListing(propA, { source: "idealista", current_price: 220000 })),
    );
    const restB = await Promise.all(
      Array.from({ length: 12 }, () => insertListing(propB, { source: "fotocasa", current_price: 220000 })),
    );

    // Only propA matches an active profile — this also exercises the
    // #626 internal-link "unavailable" state on propB's side (no active
    // profile match -> no internal link, never a broken 404 route).
    await markProfileMatch(profileId, propA);
    // detail.matched_photos mirrors exactly what etl/dedup/signals/
    // photo_hash.py::matched_pairs persists — this e2e proves the
    // DASHBOARD'S consumption of that shape (resolveMatchedPhotos /
    // orderPhotosMatchedFirst / ListingSidePanel), not the perceptual
    // hashing itself (already unit-tested in
    // etl/tests/test_dedup_signals_photo_hash.py::TestMatchedPairs).
    const suggestionId = await insertSuggestion(matchingA, matchingB, {
      match_basis: "photo_hash",
      confidence: 1.0,
      detail: { match_ratio: 1.0, matched_photos: [{ url_a: matchedUrlLo, url_b: matchedUrlHi, distance: 0 }] },
    });
    const pairKey = pairKeyOf(propA, propB);
    const allListingIds = [matchingA, matchingB, ...restA, ...restB];

    try {
      await page.goto("/admin/dedup");
      await assertNoErrorSurface(page);

      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(clientWidth).toBeLessThanOrEqual(400);

      const card = page.locator(`[data-pair-key="${pairKey}"]`);
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();

      // The advert counts, not the internal pair count (which happens to
      // be 1 here — one suggestion row — precisely to prove the header
      // reads listing_count_lo/hi, not pair_count).
      await expect(card).toHaveAttribute("data-pair-count", "1");
      await expect(card.getByTestId("dedup-advert-counts")).toHaveText(/7 anuncios ↔ 13 anuncios/i);
      await expect(card.getByTestId("dedup-single-decision-note")).toBeVisible();
      await expect(card.getByTestId("dedup-pair-count-badge")).toHaveCount(0);
      await expect(card).not.toContainText(/pares/i);
      // This fixture's suggestion DOES carry detail.matched_photos, so the
      // "not computed yet" empty state (PR #621 review B1) must not show.
      await expect(card.getByTestId("dedup-photo-matches-pending")).toHaveCount(0);

      const panels = card.locator(".dedup-side-panel");
      await expect(panels).toHaveCount(2);
      const loPanel = panels.nth(0);
      const hiPanel = panels.nth(1);
      await expect(loPanel.getByTestId("dedup-side-photo-count")).toHaveText(/6 fotos/i);
      await expect(hiPanel.getByTestId("dedup-side-photo-count")).toHaveText(/14 fotos/i);

      // Issue #626: EVERY stored photo renders — the stated count
      // ("6 fotos"/"14 fotos" above) equals the number of thumbnails
      // actually in the grid, on BOTH sides, no cap and no "+N más". The
      // photo that actually matched is still visibly marked on both
      // sides even though it sits at index 5/9 (not 0) — matched-first
      // ordering (issue #615) is preserved even though nothing is capped
      // any more.
      await expect(loPanel.locator(".dedup-photo-grid img")).toHaveCount(6);
      await expect(hiPanel.locator(".dedup-photo-grid img")).toHaveCount(14);
      await expect(loPanel.getByTestId("dedup-photo-matched")).toHaveCount(1);
      await expect(hiPanel.getByTestId("dedup-photo-matched")).toHaveCount(1);
      await expect(loPanel.getByTestId("dedup-photo-matched")).toHaveAttribute("src", matchedUrlLo);
      await expect(hiPanel.getByTestId("dedup-photo-matched")).toHaveAttribute("src", matchedUrlHi);
      // The matched photo is the FIRST thumbnail in DOM order on both
      // sides (matched-first ordering, not just "somewhere in the grid").
      await expect(loPanel.locator(".dedup-photo-grid img").first()).toHaveAttribute("src", matchedUrlLo);
      await expect(hiPanel.locator(".dedup-photo-grid img").first()).toHaveAttribute("src", matchedUrlHi);
      // Every other rendered thumbnail is explicitly marked unmatched —
      // never ambiguous, never silently omitted, and now that nothing is
      // capped, ALL of the remaining photos are accounted for (5 and 13,
      // not just "3 of the visible 4").
      await expect(loPanel.getByTestId("dedup-photo-unmatched")).toHaveCount(5);
      await expect(hiPanel.getByTestId("dedup-photo-unmatched")).toHaveCount(13);

      // The old #615 cap/expand affordance is gone entirely — its own
      // testid must not exist anywhere on the card.
      await expect(card.getByTestId("dedup-photos-expand")).toHaveCount(0);

      // The 14-photo grid overflows its own capped height and scrolls
      // INTERNALLY rather than stretching the card to full-page height
      // (globals.css .dedup-photo-grid max-height + overflow-y) — this is
      // what keeps the requirement below (decision buttons reachable
      // without scrolling past the gallery) true regardless of how many
      // photos a fotocasa listing carries (#625: up to 27).
      const manyPhotoGrid = hiPanel.locator(".dedup-photo-grid");
      const [scrollHeight, clientHeight] = await manyPhotoGrid.evaluate((el) => [el.scrollHeight, el.clientHeight]);
      expect(scrollHeight).toBeGreaterThan(clientHeight);

      // Thumbnails stay legibly sized at phone width — same bar #576 set
      // (>=130x95) — checked on the first 4 rendered (matched-first, so
      // this includes the one photo that actually matters most).
      const photos = loPanel.locator(".dedup-photo-grid img");
      for (let i = 0; i < 4; i++) {
        const box = await photos.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(130);
        expect(box!.height).toBeGreaterThanOrEqual(95);
      }

      // Issue #626: "the decision buttons must stay reachable without
      // scrolling past the gallery" — proven by measuring the actual
      // vertical distance from the top of the card to the confirm
      // button. Each side's photo grid is capped to ~320px (mobile) by
      // globals.css regardless of photo count, so the total card height
      // stays bounded even with 6+14=20 photos across both sides — an
      // UNCAPPED grid (no max-height/overflow) would need roughly
      // 3 rows x ~155px for the 6-photo side and 7 rows x ~155px for the
      // 14-photo side, well over 1500px on the hi side ALONE. 2200px is
      // comfortably above what the capped layout needs (two ~320px
      // grids + labels/price/address/facts/links per side + header) and
      // comfortably below what an uncapped 14-photo grid would add on
      // its own.
      const cardBox = await card.boundingBox();
      const confirmBox = await card.getByTestId("dedup-confirm").boundingBox();
      expect(cardBox).not.toBeNull();
      expect(confirmBox).not.toBeNull();
      expect(confirmBox!.y - cardBox!.y).toBeLessThan(2200);
      // And the buttons are still a real, tappable 44px target (WCAG
      // 2.5.5), same bar as every other action on this card.
      expect(confirmBox!.height).toBeGreaterThanOrEqual(44);

      // Issue #626: internal property-page links, one per side. propA
      // matches the seeded active profile -> a real link, target=_blank
      // (owner decision: opens NEXT TO the card, keeps /admin/dedup's
      // queue state untouched — never a same-tab navigation). propB
      // matches no active profile -> an explicit "unavailable" note,
      // never a link that would 404.
      const loLink = loPanel.getByTestId("dedup-internal-link");
      await expect(loLink).toBeVisible();
      await expect(loLink).toHaveAttribute("href", `/profiles/${profileId}/properties/${propA}`);
      await expect(loLink).toHaveAttribute("target", "_blank");
      await expect(loLink).toHaveAttribute("rel", /noopener/);
      // Distinct label from the portal link ("ficha interna" vs. "anuncio
      // original") — never relying on the "↗" icon alone to distinguish
      // "our page" from "the portal's page".
      await expect(loLink).toHaveText(/ficha interna/i);
      await expect(loLink).not.toHaveText(/anuncio original/i);

      // PR #631 review fix 1: propA also has a real `url`, so the portal
      // link stacks directly above the internal link in this same panel —
      // measured 16.5px tall, 2px apart before the fix, the exact shape
      // WCAG 2.5.5 (and this card's own `.dedup-action-btn`/
      // `.dedup-evidence-toggle` precedent) exists to catch. Both links
      // must clear the 44px floor and not overlap/touch.
      const loPortalLink = loPanel.getByText(/ver anuncio original/i);
      await expect(loPortalLink).toBeVisible();
      const portalBox = await loPortalLink.boundingBox();
      const internalBox = await loLink.boundingBox();
      expect(portalBox).not.toBeNull();
      expect(internalBox).not.toBeNull();
      expect(portalBox!.height).toBeGreaterThanOrEqual(44);
      expect(internalBox!.height).toBeGreaterThanOrEqual(44);
      expect(internalBox!.y).toBeGreaterThanOrEqual(portalBox!.y + portalBox!.height);

      await expect(hiPanel.getByTestId("dedup-internal-link")).toHaveCount(0);
      await expect(hiPanel.getByTestId("dedup-internal-link-unavailable")).toBeVisible();

      // PR #621 review (also-fix): the reject warning must disclose the
      // real advert-level blast radius EVEN THOUGH pair_count is 1 here
      // (one pending suggestion row) — D-133's veto always binds the
      // WHOLE property pair regardless of pair_count, and the old
      // `pair_count > 1` gate left exactly this shape (measured live: 32%
      // of photo groups) showing only "Este rechazo es permanente.",
      // silent about which adverts it covers.
      await expect(card).toHaveAttribute("data-pair-count", "1");
      await card.getByTestId("dedup-reject").click();
      await expect(card.getByTestId("dedup-reject-warning")).toHaveText(/anuncios \(7 ↔ 13\)/i);
      await card.getByTestId("dedup-reject-cancel").click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const main = document.querySelector("main.main-content");
        return main !== null && main.scrollWidth > main.clientWidth;
      });
      expect(hasHorizontalOverflow).toBe(false);
    } finally {
      await pool.query("DELETE FROM suggested_merge WHERE id = $1", [suggestionId]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
      await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
      await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [allListingIds]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
    }
  });

  test("issue #626: both sides link to their own internal property page when both match an active profile", async ({
    page,
  }) => {
    skipIfNoDb(test);

    // Two DISTINCT profiles, one per side — proves the link is resolved
    // per-property (property_lo_profile_id/property_hi_profile_id), not
    // a single pair-wide profile id reused on both sides.
    const profileLo = await insertProfile();
    const profileHi = await insertProfile();
    const propA = await insertProperty({ address: `${NAME_PREFIX}Enlace Interno A` });
    const propB = await insertProperty({ address: `${NAME_PREFIX}Enlace Interno B` });
    const listingA = await insertListing(propA, { source: "fotocasa", current_price: 180000 });
    const listingB = await insertListing(propB, { source: "idealista", current_price: 180000 });
    await markProfileMatch(profileLo, propA);
    await markProfileMatch(profileHi, propB);
    const suggestionId = await insertSuggestion(listingA, listingB);
    const pairKey = pairKeyOf(propA, propB);

    try {
      await page.goto("/admin/dedup");
      await assertNoErrorSurface(page);

      const card = page.locator(`[data-pair-key="${pairKey}"]`);
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();

      const panels = card.locator(".dedup-side-panel");
      const loPanel = panels.nth(0);
      const hiPanel = panels.nth(1);

      await expect(loPanel.getByTestId("dedup-internal-link")).toHaveAttribute(
        "href",
        `/profiles/${profileLo}/properties/${propA}`,
      );
      await expect(hiPanel.getByTestId("dedup-internal-link")).toHaveAttribute(
        "href",
        `/profiles/${profileHi}/properties/${propB}`,
      );
      await expect(loPanel.getByTestId("dedup-internal-link")).toHaveAttribute("target", "_blank");
      await expect(hiPanel.getByTestId("dedup-internal-link")).toHaveAttribute("target", "_blank");
    } finally {
      await pool.query("DELETE FROM suggested_merge WHERE id = $1", [suggestionId]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
        [profileLo, profileHi],
      ]);
      await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [[profileLo, profileHi]]);
      await pool.query("DELETE FROM listing WHERE id = ANY($1::bigint[])", [[listingA, listingB]]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [[propA, propB]]);
    }
  });
});
