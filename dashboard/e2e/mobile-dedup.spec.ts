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

  test("issue #615: photo-match card shows the photos that ACTUALLY matched (not index 0), capped at 4 with the rest reachable, plus asymmetric advert counts, at phone width", async ({
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
    // the other. Direct owner instruction (mid-review, on THIS issue):
    // the true match must NOT sit at the same index on both sides — here
    // it's index 5 of the 6-photo side against index 9 of the 14-photo
    // side, exactly the "side A's photo 5 matches side B's photo 9"
    // shape the coordinator's follow-up named. A fixture where the match
    // happens to land at index 0 on both sides would pass even with no
    // real matched-pairs threading at all.
    const photosLo = Array.from({ length: 6 }, (_, i) => `https://img.example.com/615-lo-${i}.jpg`);
    const photosHi = Array.from({ length: 14 }, (_, i) => `https://img.example.com/615-hi-${i}.jpg`);
    const matchedUrlLo = photosLo[5];
    const matchedUrlHi = photosHi[9];
    const matchingA = await insertListing(propA, {
      source: "fotocasa",
      current_price: 220000,
      photo_urls: photosLo,
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

      // DEFAULT view: capped at 4 per side (owner's own stated bar —
      // "me muestras 4 fotos como máximo... está bien"), and the ONE
      // photo that actually matched is among those 4 AND visibly marked,
      // on BOTH sides, even though it sits at index 5/9 respectively —
      // never a naive first-4-in-storage-order slice (which would show
      // index 0-3 on each side and never include the real match at all).
      await expect(loPanel.locator(".dedup-photo-grid img")).toHaveCount(4);
      await expect(hiPanel.locator(".dedup-photo-grid img")).toHaveCount(4);
      await expect(loPanel.getByTestId("dedup-photo-matched")).toHaveCount(1);
      await expect(hiPanel.getByTestId("dedup-photo-matched")).toHaveCount(1);
      await expect(loPanel.getByTestId("dedup-photo-matched")).toHaveAttribute("src", matchedUrlLo);
      await expect(hiPanel.getByTestId("dedup-photo-matched")).toHaveAttribute("src", matchedUrlHi);
      // Every other visible thumbnail is explicitly marked unmatched —
      // never ambiguous, never silently omitted.
      await expect(loPanel.getByTestId("dedup-photo-unmatched")).toHaveCount(3);
      await expect(hiPanel.getByTestId("dedup-photo-unmatched")).toHaveCount(3);

      // "the rest need to be reachable" — a visible count of what's
      // hidden, not a silent truncation.
      await expect(loPanel.getByTestId("dedup-photos-expand")).toHaveText(/\+2 más/i);
      await expect(hiPanel.getByTestId("dedup-photos-expand")).toHaveText(/\+10 más/i);

      // Expand target size (WCAG 2.5.5, same bar as confirm/reject).
      const expandBox = await hiPanel.getByTestId("dedup-photos-expand").boundingBox();
      expect(expandBox).not.toBeNull();
      expect(expandBox!.height).toBeGreaterThanOrEqual(44);

      // Expanding the 14-photo side reveals the rest — the matched photo
      // stays marked, and the button stays as a real TOGGLE (PR #621
      // review nit) rather than a one-way expand that vanishes.
      await hiPanel.getByTestId("dedup-photos-expand").click();
      await expect(hiPanel.locator(".dedup-photo-grid img")).toHaveCount(14);
      await expect(hiPanel.getByTestId("dedup-photo-matched")).toHaveCount(1);
      await expect(hiPanel.getByTestId("dedup-photos-expand")).toHaveText(/mostrar menos/i);

      // Collapsing back returns to the capped, matched-first default view.
      await hiPanel.getByTestId("dedup-photos-expand").click();
      await expect(hiPanel.locator(".dedup-photo-grid img")).toHaveCount(4);
      await expect(hiPanel.getByTestId("dedup-photo-matched")).toHaveCount(1);
      await expect(hiPanel.getByTestId("dedup-photos-expand")).toHaveText(/\+10 más/i);

      // Re-expand for the remaining assertions below (scroll/overflow
      // checks against the full grid).
      await hiPanel.getByTestId("dedup-photos-expand").click();
      await expect(hiPanel.locator(".dedup-photo-grid img")).toHaveCount(14);

      // The expanded 14-photo grid overflows its own capped height and
      // scrolls internally rather than stretching the card to full-page
      // height (globals.css .dedup-photo-grid max-height + overflow-y).
      const manyPhotoGrid = hiPanel.locator(".dedup-photo-grid");
      const [scrollHeight, clientHeight] = await manyPhotoGrid.evaluate((el) => [el.scrollHeight, el.clientHeight]);
      expect(scrollHeight).toBeGreaterThan(clientHeight);

      // Thumbnails stay legibly sized at phone width — same bar #576 set
      // (>=130x95). Only the first 4 need to be on-screen to measure —
      // Playwright's boundingBox is null for anything scrolled fully out
      // of view inside the now-expanded, internally-scrolling grid.
      const photos = loPanel.locator(".dedup-photo-grid img");
      for (let i = 0; i < 4; i++) {
        const box = await photos.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(130);
        expect(box!.height).toBeGreaterThanOrEqual(95);
      }

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
});
