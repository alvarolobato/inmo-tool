/**
 * E2E: property detail page at phone width (#584).
 *
 * Owner report from his phone, production, 390px: two containment defects on
 * `/profiles/[id]/properties/[propertyId]`, same failure class as #572
 * (profile card) / #576 (dedup panels), different components:
 *
 * 1. LinkedListings.tsx: each row's left group packs up to 7 inline spans
 *    with no `flexWrap` and the outer row is a non-wrapping `space-between`
 *    flex row — at 390px every span's TEXT shrank internally into mid-token
 *    shards ("Visto desde 08 ago 2026" across four lines) and "Ver anuncio
 *    original →" clipped off-viewport. Fixed by wrapping the left group
 *    (real content-basis wrap, D-124-safe) and stacking the outer row into a
 *    column below 768px (`.linked-listing-row`/`.linked-listing-link` in
 *    globals.css).
 * 2. PropertyHeader.tsx's top row (price+🏷chip vs the extraction-quality/
 *    staleness badge group) is nowrap at every width; the price+chip unit's
 *    `minWidth: 0` wrapper lets its BOX shrink past its nowrap CONTENT at
 *    390px, so the content overflows the shrunken box and paints over the
 *    badges. Fixed by letting the ROW wrap below 768px
 *    (`.property-header-top-row`) — the badges drop to their own line
 *    instead. The price+chip unit itself stays one non-wrapping line inside
 *    PriceSignals — the #460 invariant this issue must not break.
 *
 * Seeds one profile-matched, multi-listing property priced well below three
 * filler comparables (so `below_market_pct` reliably qualifies — mirrors
 * property-detail.spec.ts's belowMarketPropertyId technique, MIN_POOL_SIZE=3
 * in lib/candidates.ts) with a graded listing (extraction-quality badge) and
 * a recent last_seen_at (staleness badge), so a single navigation exercises
 * every element these assertions need. Its two listings each carry a
 * reference code and both first/last-seen dates — the widest row shape the
 * bug report showed.
 *
 * Assertions use `document.documentElement.clientWidth`, never
 * `window.innerWidth` (reports 653 under this project's Chromium mobile
 * emulation — see mobile-dedup.spec.ts's identical note). Every check is a
 * real measured box/position, not just "no horizontal scroll" — the old
 * bug never overflowed the page either, it degraded internally.
 *
 * Skips cleanly if no DB is reachable — same pattern as the rest of this
 * project's e2e suite.
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

const NAME_PREFIX = "e2e-mobile-property-detail-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let targetPropertyId: number;
let idealistaListingId: number;
let fotocasaListingId: number;
const fillerPropertyIds: number[] = [];

async function insertProfile(): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  return result.rows[0].id;
}

async function insertProperty(address: string, m2Built = 70): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, rooms, bathrooms, address)
     VALUES (40.4168, -3.7038, 'piso', $1, 2, 1, $2) RETURNING id`,
    [m2Built, address],
  );
  return result.rows[0].id;
}

async function insertListing(
  propertyId: number,
  overrides: {
    source: string;
    status?: string;
    current_price?: number | null;
    listing_kind?: string | null;
    operation?: string;
    reference_code?: string | null;
    url?: string | null;
    first_seen_at?: string;
    last_seen_at?: string | null;
    raw_extra?: object;
  },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, listing_kind,
                           operation, reference_code, url, first_seen_at, last_seen_at, raw_extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
    [
      propertyId,
      overrides.source,
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      overrides.status ?? "active",
      overrides.current_price ?? null,
      overrides.listing_kind ?? null,
      overrides.operation ?? "sale",
      overrides.reference_code ?? null,
      overrides.url ?? null,
      overrides.first_seen_at ?? null,
      overrides.last_seen_at ?? null,
      JSON.stringify(overrides.raw_extra ?? {}),
    ],
  );
  return result.rows[0].id;
}

async function markMatched(profId: number, propId: number): Promise<void> {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profId, propId],
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
      "[mobile-property-detail.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  profileId = await insertProfile();

  // Three filler comparables at a typical price/m² so the pool median is
  // stable (MIN_POOL_SIZE=3, lib/candidates.ts) and the target property
  // below reliably qualifies for a below-market rating chip. Source
  // "idealista" deliberately — it carries no `connector_registry` row (it's
  // capture-only, not an ETL connector), so its listings are never excluded
  // by the below-market pool's `activeSourceClause` regardless of any other
  // worktree/session's connector_config state in this shared dev DB. A
  // registered connector like "fotocasa" IS disabled in this shared DB
  // today, which silently zeroed the pool during this spec's own
  // development (each filler's only listing dropped out of `mp.min_price`,
  // leaving pool.n=1 < MIN_POOL_SIZE) — a real trap for the next spec that
  // needs a below-market signal.
  for (let i = 0; i < 3; i++) {
    const fillerId = await insertProperty(`${NAME_PREFIX}Relleno ${i}, Madrid`);
    fillerPropertyIds.push(fillerId);
    await insertListing(fillerId, { source: "idealista", current_price: 250000 });
    await markMatched(profileId, fillerId);
  }

  // Target property: priced well below the filler median (below-market
  // chip), two linked listings each carrying a reference code and both
  // first/last-seen dates (the widest row shape from the owner's
  // screenshot), and a graded listing (extraction-quality badge). The
  // idealista listing's last_seen_at is recent so the staleness badge
  // renders too — all three header elements present at once, same as the
  // owner's screenshot.
  targetPropertyId = await insertProperty(`${NAME_PREFIX}Calle Ganga Movil, Madrid`);
  const oldFirstSeen = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recentLastSeen = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const olderLastSeen = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  idealistaListingId = await insertListing(targetPropertyId, {
    source: "idealista",
    status: "active",
    current_price: 150000,
    listing_kind: "agency",
    reference_code: `${NAME_PREFIX}REF-38271`,
    url: "https://www.idealista.com/inmueble/38271271/",
    first_seen_at: oldFirstSeen,
    last_seen_at: recentLastSeen,
    raw_extra: {
      extraction_quality: {
        grade: "B",
        score: 0.75,
        populated_fields: 7,
        total_fields: 9,
        weights_version: 1,
      },
    },
  });
  fotocasaListingId = await insertListing(targetPropertyId, {
    source: "fotocasa",
    status: "active",
    current_price: 152000,
    listing_kind: "particular",
    reference_code: `${NAME_PREFIX}NS603221`,
    url: "https://www.fotocasa.es/es/comprar/vivienda/madrid/99182271/",
    first_seen_at: oldFirstSeen,
    last_seen_at: olderLastSeen,
  });
  await markMatched(profileId, targetPropertyId);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id = $1",
    [profileId],
  );
  await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

async function assertNoErrorSurface(page: Page) {
  await expect(page.getByText(/error|hubo un problema|there is no parameter|http 500/i)).toHaveCount(0);
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test.describe("#584: property detail at phone width (iPhone 13 emulation)", () => {
  // Destructure out `defaultBrowserType` (webkit) — this project's single
  // Playwright project is chromium; see card-detail-ux.spec.ts / mobile-
  // dedup.spec.ts's identical iPhone 13 block for why.
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await seedAdminSession(page, baseURL);
  });

  test("linked listing rows wrap and contain at 390px", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${targetPropertyId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await assertNoErrorSurface(page);

    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(clientWidth).toBeLessThanOrEqual(400);

    const items = page.locator('[data-testid="linked-listing-item"]');
    await expect(items).toHaveCount(2);

    for (let i = 0; i < 2; i++) {
      const item = items.nth(i);
      await item.scrollIntoViewIfNeeded();

      // The old bug squeezed each span's own box below its text's natural
      // width, forcing the TEXT to wrap internally into shards ("Visto
      // desde 08 ago 2026" across four lines). With the group wrapping as a
      // whole, each span renders on its own intact single line — its own
      // box height stays a single line's worth, not a multi-line squeeze.
      const seenSpan = item.getByText(/^Visto desde/);
      await expect(seenSpan).toBeVisible();
      const seenBox = await seenSpan.boundingBox();
      expect(seenBox).not.toBeNull();
      expect(seenBox!.height).toBeLessThanOrEqual(20);

      // "Ver anuncio original →" is a fully visible, in-viewport tap
      // target — not clipped off the right edge (the old bug). Height alone
      // is not enough here: with the media queries neutered during this
      // PR's own red/green check, the link measured 44.98px TALL while its
      // text was shredded into three narrow lines (~45px wide) — a broken,
      // clipped link that still happened to satisfy a height-only floor.
      // Pairing it with a width floor (mirroring the dedicated full-width
      // test below) makes that failure mode actually fail here too.
      const itemBox = await item.boundingBox();
      const link = item.getByText(/Ver anuncio original/);
      await expect(link).toBeVisible();
      const linkBox = await link.boundingBox();
      expect(itemBox).not.toBeNull();
      expect(linkBox).not.toBeNull();
      expect(linkBox!.x).toBeGreaterThanOrEqual(0);
      expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(clientWidth + 1);
      expect(linkBox!.height).toBeGreaterThanOrEqual(44);
      expect(linkBox!.width).toBeGreaterThanOrEqual(itemBox!.width * 0.8);
    }

    // No horizontal overflow of the page content.
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  });

  test("original-ad link is a full-width 44px target on phone", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${targetPropertyId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const item = page.locator('[data-testid="linked-listing-item"]').first();
    await item.scrollIntoViewIfNeeded();
    const itemBox = await item.boundingBox();
    const link = item.getByText(/Ver anuncio original/);
    const linkBox = await link.boundingBox();
    expect(itemBox).not.toBeNull();
    expect(linkBox).not.toBeNull();

    // Full-width: the link's own box spans close to the row's full width
    // (stacked column, not squeezed to the right edge of a cramped row).
    expect(linkBox!.width).toBeGreaterThanOrEqual(itemBox!.width * 0.8);
    expect(linkBox!.height).toBeGreaterThanOrEqual(44);
    expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("header price chip and badges do not overlap on phone", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${targetPropertyId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await assertNoErrorSurface(page);

    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(clientWidth).toBeLessThanOrEqual(400);

    const rating = page.getByTestId("price-rating");
    const qualityBadge = page.getByTestId("property-extraction-quality");
    const stalenessBadge = page.getByTestId("property-staleness");
    await expect(rating).toBeVisible();
    await expect(qualityBadge).toBeVisible();
    await expect(stalenessBadge).toBeVisible();
    // Below-market for real: this property (150k/70m²) is well under the
    // filler pool's median (250k/70m²).
    await expect(rating).toHaveAttribute("data-rating", "below");

    const ratingBox = await rating.boundingBox();
    const qualityBox = await qualityBadge.boundingBox();
    const stalenessBox = await stalenessBadge.boundingBox();
    expect(ratingBox).not.toBeNull();
    expect(qualityBox).not.toBeNull();
    expect(stalenessBox).not.toBeNull();

    expect(boxesOverlap(ratingBox!, qualityBox!)).toBe(false);
    expect(boxesOverlap(ratingBox!, stalenessBox!)).toBe(false);

    // The badges dropped BELOW the price line, not just side-stepped it.
    expect(qualityBox!.y).toBeGreaterThanOrEqual(ratingBox!.y);
  });

  test("price and its below-market chip stay on one non-wrapping line (#460 invariant)", async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${targetPropertyId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    // #460's invariant this issue must not break: the price and its 🏷
    // rating chip are one unit, never separated onto different lines, even
    // though the row around them now wraps. A geometry-only check here is
    // decorative once the outer row wraps below 768px (PriceSignals then
    // gets the whole ~302px column, and this fixture's "150.000 €" + chip
    // is far too short to ever need a second line regardless of the CSS
    // property) — reverting PriceSignals.tsx's `flexWrap: "nowrap"` to
    // "wrap" still passed a geometry-only version of this test 5/5. Assert
    // the actual CSS property directly so a revert of THAT declaration is
    // what this test exists to catch, not incidental fixture width.
    const priceSignals = page.getByTestId("price-signals").first();
    const h1 = priceSignals.locator("h1");
    const rating = priceSignals.getByTestId("price-rating");
    await expect(h1).toBeVisible();
    await expect(rating).toBeVisible();

    // The nowrap unit is the FIRST direct-child <span> of price-signals
    // (PriceSignals.tsx's price-mode branch: [price][rating] wrapped in one
    // `flexWrap: "nowrap"` span, with the optional direction chip as a
    // second, separately-wrapping sibling).
    const nowrapUnit = priceSignals.locator("> span").first();
    const computedFlexWrap = await nowrapUnit.evaluate((el) => getComputedStyle(el).flexWrap);
    expect(computedFlexWrap).toBe("nowrap");

    // Geometry as a secondary, human-readable confirmation (kept alongside
    // the computed-style assertion above, not instead of it): price and
    // chip visually share one line.
    const h1Box = await h1.boundingBox();
    const ratingBox = await rating.boundingBox();
    expect(h1Box).not.toBeNull();
    expect(ratingBox).not.toBeNull();
    const h1Center = h1Box!.y + h1Box!.height / 2;
    const ratingCenter = ratingBox!.y + ratingBox!.height / 2;
    expect(Math.abs(h1Center - ratingCenter)).toBeLessThanOrEqual(h1Box!.height);
  });
});

test.describe("#584: desktop breakpoint boundary (768px) and unchanged (1280px)", () => {
  // 768px is the exact edge of both `.linked-listing-row` and
  // `.property-header-top-row`'s `@media (max-width: 767px)` cutoff — the
  // width most likely to catch a breakpoint-boundary regression, and the
  // width that would have caught this PR's own B1 review finding (the
  // outer per-item row correctly stays a single ROW here per D-121, but the
  // left field group's plain, non-gated `flexWrap: "wrap"` still activates
  // in the 768-950px band on this fixture — taller rows with every field
  // whole, an improvement over main's mid-token shearing in that same band,
  // not a regression). This test asserts the two properties that ARE
  // breakpoint-gated and must NOT change at 768px; it deliberately does
  // NOT assert pixel-for-pixel identity with main's un-gated inner wrap,
  // since main and this PR genuinely differ there by design.
  test("768px: outer row stays a single row, header stays non-wrapping, no mid-token shard", async ({
    page,
    baseURL,
  }) => {
    skipIfNoDb(test);
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await page.setViewportSize({ width: 768, height: 900 });
    await seedAdminSession(page, baseURL);

    await page.goto(`/profiles/${profileId}/properties/${targetPropertyId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await assertNoErrorSurface(page);

    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(clientWidth).toBe(768);

    // The two breakpoint-GATED properties (`.linked-listing-row`'s
    // flex-direction, `.property-header-top-row`'s flex-wrap) read their
    // desktop (>=768px) values here — computed style, not geometry, so this
    // is exactly what would fail if the `max-width: 767px` cutoff drifted.
    const row = page.locator('[data-testid="linked-listing-item"]').first();
    const rowFlexDirection = await row.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(rowFlexDirection).toBe("row");

    const headerRow = page.locator(".property-header-top-row");
    const headerFlexWrap = await headerRow.evaluate((el) => getComputedStyle(el).flexWrap);
    expect(headerFlexWrap).toBe("nowrap");

    // The genuinely-improved, NOT breakpoint-gated invariant (left field
    // group's plain `flexWrap: "wrap"`, B1): every field still renders
    // whole on its own line-fragment — no internal text-shearing — even
    // though the row itself is taller than main's in this band.
    const seenSpan = row.getByText(/^Visto desde/);
    await expect(seenSpan).toBeVisible();
    const seenBox = await seenSpan.boundingBox();
    expect(seenBox).not.toBeNull();
    expect(seenBox!.height).toBeLessThanOrEqual(20);

    // The link is still fully in-viewport and to the right of the field
    // group (row layout, not stacked) — never clipped.
    const link = row.getByText(/Ver anuncio original/);
    await expect(link).toBeVisible();
    const linkBox = await link.boundingBox();
    expect(linkBox).not.toBeNull();
    expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(clientWidth + 1);

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  });

  test("desktop layout unchanged", async ({ page, baseURL }) => {
    skipIfNoDb(test);
    test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedAdminSession(page, baseURL);

    await page.goto(`/profiles/${profileId}/properties/${targetPropertyId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await assertNoErrorSurface(page);

    // Linked listings: single row per item — the link sits to the right of
    // the field group, not stacked below it.
    const item = page.locator('[data-testid="linked-listing-item"]').first();
    const link = item.getByText(/Ver anuncio original/);
    const seenSpan = item.getByText(/^Visto desde/);
    const linkBox = await link.boundingBox();
    const seenBox = await seenSpan.boundingBox();
    expect(linkBox).not.toBeNull();
    expect(seenBox).not.toBeNull();
    // Same row: vertical centers close together (stacked layout would put
    // the link well below the field group instead).
    const linkCenter = linkBox!.y + linkBox!.height / 2;
    const seenCenter = seenBox!.y + seenBox!.height / 2;
    expect(Math.abs(linkCenter - seenCenter)).toBeLessThanOrEqual(seenBox!.height * 2);
    // Right-aligned, not full width.
    expect(linkBox!.width).toBeLessThan(200);

    // Header: price chip and badges share the same row (no wrap at this
    // width) — badges sit beside, not below, the price+chip unit.
    const rating = page.getByTestId("price-rating");
    const qualityBadge = page.getByTestId("property-extraction-quality");
    const ratingBox = await rating.boundingBox();
    const qualityBox = await qualityBadge.boundingBox();
    expect(ratingBox).not.toBeNull();
    expect(qualityBox).not.toBeNull();
    const ratingCenter = ratingBox!.y + ratingBox!.height / 2;
    const qualityCenter = qualityBox!.y + qualityBox!.height / 2;
    expect(Math.abs(ratingCenter - qualityCenter)).toBeLessThanOrEqual(Math.max(ratingBox!.height, qualityBox!.height));
    expect(boxesOverlap(ratingBox!, qualityBox!)).toBe(false);
  });
});
