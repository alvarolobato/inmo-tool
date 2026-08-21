/**
 * E2E (issue #667, revised after opus review of PR #668 — D-148) — the "Ver
 * novedades" button on `/profiles`: one tap from a profile row to that
 * profile's feed filtered to exactly the candidates that are new since the
 * owner's last visit, and nothing else.
 *
 * This spec deliberately exercises the TWO independent races opus review
 * found (both required to reproduce, and the original spec's fixture — a
 * straight copy of nuevos-count-feed-alignment.spec.ts's shape — was
 * decorative for both):
 *
 *   B1 (anchor shift): `previous_viewed_at` shifts forward the moment the
 *   profile detail page's own `GET /api/profiles/[id]` runs
 *   (`touchProfileViewedAt`), which happens BEFORE the candidate feed's own
 *   fetch. `previous_viewed_at` = 3 days ago, `last_viewed_at` = 2 hours ago
 *   below means clicking through shifts the LIVE anchor to 2 hours ago — so
 *   candidates seeded strictly BETWEEN the two (the "gap") are new under the
 *   original (3-day) anchor `new_count` used, but would silently vanish from
 *   a naive onlyNew filter that re-reads the anchor live post-shift. The
 *   fix (D-148) freezes the anchor into the link (`?newSince=`); this spec
 *   asserts the gap candidates SURVIVE.
 *
 *   B2 (rejected candidates): `new_count` used to count matched properties
 *   regardless of feedback state; the feed hides `reject`-verdict properties
 *   by default (D-094). This spec seeds one newly-first-seen candidate that
 *   is ALSO rejected and asserts it counts toward NEITHER the row's
 *   "N nuevos" NOR the onlyNew feed.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars). Skips cleanly if none is
 * reachable, matching nuevos-count-feed-alignment.spec.ts / mobile-profiles.spec.ts.
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

const MADRID_SOL: [number, number] = [40.4168, -3.7038];
const NAME_PREFIX = "e2e-ver-novedades-";

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// The visit anchor pair (mirrors nuevos-count-feed-alignment.spec.ts): a
// visited-before profile (never-visited would trigger #425 cold-start
// suppression), with last_viewed_at old enough (>30 min) that the FIRST
// navigation into the profile detail page shifts previous_viewed_at forward
// — the exact B1 race.
const PREVIOUS_VIEWED_AT = iso(3 * DAYS);
const LAST_VIEWED_AT = iso(2 * HOURS);

// "Now" candidates: after BOTH anchors — new under the frozen anchor AND
// would still be new even if the filter (wrongly) re-derived the live,
// already-shifted one. NEW_NOW_COUNT + GAP_COUNT + 1 (rejected) stays under
// the #425 60%-fresh cold-start threshold relative to the 8 total matched
// (raw is_new share ~37%), so novelty display isn't suppressed either.
const NEW_NOW_COUNT = 2;
// "Gap" candidates: after the FROZEN (3-day) anchor, but BEFORE the live
// anchor once shifted to ~2 hours ago. Only correct with the B1 fix.
const GAP_COUNT = 2;
// A newly-first-seen candidate that is ALSO rejected — must count toward
// NEITHER new_count NOR the onlyNew feed once B2 is fixed.
const REJECTED_NEW_COUNT = 1;
// Old candidates: before every anchor in play — never new.
const OLD_COUNT = 3;

const EXPECTED_NEW_COUNT = NEW_NOW_COUNT + GAP_COUNT; // 4 — rejected + old excluded

let pool: Pool;
let dbAvailable = false;
let profileWithNewId: number;
let profileZeroNewId: number;
const nowPropertyIds: number[] = [];
const gapPropertyIds: number[] = [];
let rejectedPropertyId: number;
const oldPropertyIds: number[] = [];

async function seedMatched(profileId: number, firstSeenAt: string, price: number): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 68, $3) RETURNING id`,
    [MADRID_SOL[0], MADRID_SOL[1], `${NAME_PREFIX}Calle Mayor, Madrid`],
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4::timestamptz, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price, firstSeenAt],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
    [profileId, propertyId],
  );
  return propertyId;
}

async function seedProfile(name: string): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      name,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      PREVIOUS_VIEWED_AT,
      LAST_VIEWED_AT,
    ],
  );
  return res.rows[0].id;
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[ver-novedades.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  profileWithNewId = await seedProfile(`${NAME_PREFIX}with-new-${Date.now()}`);

  for (let i = 0; i < NEW_NOW_COUNT; i++) {
    nowPropertyIds.push(await seedMatched(profileWithNewId, iso(0), 300000 + i * 1000));
  }
  // B1: inside the anchor-shift gap — after the frozen 3-day anchor, before
  // the live anchor once it shifts to ~2 hours ago.
  for (let i = 0; i < GAP_COUNT; i++) {
    gapPropertyIds.push(await seedMatched(profileWithNewId, iso(1 * DAYS), 220000 + i * 1000));
  }
  // B2: newly-first-seen, but rejected.
  rejectedPropertyId = await seedMatched(profileWithNewId, iso(0), 260000);
  await pool.query(
    `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'reject')`,
    [profileWithNewId, rejectedPropertyId],
  );
  for (let i = 0; i < OLD_COUNT; i++) {
    oldPropertyIds.push(await seedMatched(profileWithNewId, iso(10 * DAYS), 200000 + i * 1000));
  }

  // Second profile: same visit-anchor pair, but every matched candidate is
  // OLD — new_count = 0, so the row must show no "Ver novedades" button.
  profileZeroNewId = await seedProfile(`${NAME_PREFIX}zero-new-${Date.now()}`);
  for (let i = 0; i < 2; i++) {
    await seedMatched(profileZeroNewId, iso(10 * DAYS), 210000 + i * 1000);
  }
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM feedback_event WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
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

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
  // Re-pin BOTH profiles' visit-anchor pair before every test. Necessary
  // because navigating into a profile detail page for real (as the "B1"
  // test below does) permanently SHIFTS previous_viewed_at in the DB —
  // exactly the mechanism this whole spec exists to test — so a later test
  // in the same run would otherwise silently inherit an already-shifted
  // anchor and stop exercising the gap this spec seeds. Each test therefore
  // starts from the identical, deterministic pre-shift state regardless of
  // execution order.
  if (dbAvailable) {
    await pool.query(
      `UPDATE search_profile SET previous_viewed_at = $2::timestamptz, last_viewed_at = $3::timestamptz
        WHERE id = ANY($1::bigint[])`,
      [[profileWithNewId, profileZeroNewId], PREVIOUS_VIEWED_AT, LAST_VIEWED_AT],
    );
  }
});

function rowFor(page: Page, profileId: number) {
  return page.locator(`[data-testid="profile-row"][data-profile-id="${profileId}"]`);
}

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/there is no parameter|http 500|error al cargar|detalles técnicos/i),
  ).toHaveCount(0);
}

/** Exact match on the "N nuevos" span's <strong> — a substring check here
 * (e.g. toContainText("0")) would false-positive-pass against "10"/"20". */
function newCountStrong(page: Page, profileId: number) {
  return rowFor(page, profileId).getByTestId("profile-metric-new").locator("strong");
}

test.describe("desktop", () => {
  test("'Ver novedades' is visible only on the profile row with new candidates, and the row's own count already excludes the rejected one (B2)", async ({
    page,
  }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    await assertNoErrorSurface(page);

    const withNewRow = rowFor(page, profileWithNewId);
    await expect(withNewRow).toBeVisible();
    // EXPECTED_NEW_COUNT (4) = 2 "now" + 2 "gap" — NOT the rejected one, NOT
    // the 3 old ones. Exact match, not a substring (B3 fix).
    await expect(newCountStrong(page, profileWithNewId)).toHaveText(String(EXPECTED_NEW_COUNT));
    await expect(withNewRow.getByTestId("profile-ver-novedades")).toBeVisible();
    const href = await withNewRow.getByTestId("profile-ver-novedades").getAttribute("href");
    expect(href).toMatch(new RegExp(`^/profiles/${profileWithNewId}\\?onlyNew=true&newSince=`));

    const zeroRow = rowFor(page, profileZeroNewId);
    await expect(zeroRow).toBeVisible();
    await expect(newCountStrong(page, profileZeroNewId)).toHaveText("0");
    await expect(zeroRow.getByTestId("profile-ver-novedades")).toHaveCount(0);
  });

  test("B1: clicking through survives the anchor shift — 'gap' candidates (new under the frozen anchor, not the live one) still appear; old and rejected stay absent", async ({
    page,
  }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    await rowFor(page, profileWithNewId).getByTestId("profile-ver-novedades").click();

    // The frozen anchor travels in the URL — this is the B1 fix itself.
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileWithNewId}\\?onlyNew=true&newSince=`));
    await assertNoErrorSurface(page);

    const cards = page.locator('[data-testid="candidate-card"]');
    await expect(cards).toHaveCount(EXPECTED_NEW_COUNT);
    for (const id of [...nowPropertyIds, ...gapPropertyIds]) {
      await expect(page.locator(`[data-testid="candidate-card"][data-property-id="${id}"]`)).toBeVisible();
    }
    // The old ones are absent (the decorative-fixture trap this spec exists
    // to avoid: asserting only presence would pass even with B1 unfixed).
    for (const id of oldPropertyIds) {
      await expect(page.locator(`[data-testid="candidate-card"][data-property-id="${id}"]`)).toHaveCount(0);
    }
    // B2: the rejected-but-new candidate is absent too.
    await expect(
      page.locator(`[data-testid="candidate-card"][data-property-id="${rejectedPropertyId}"]`),
    ).toHaveCount(0);

    await expect(page.getByTestId("filter-chip-onlyNew")).toContainText("Solo nuevos");
  });

  test("the onlyNew feed count matches the profile row's new_count exactly (both B1 and B2 accounted for)", async ({
    page,
  }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    await expect(newCountStrong(page, profileWithNewId)).toHaveText(String(EXPECTED_NEW_COUNT));

    await rowFor(page, profileWithNewId).getByTestId("profile-ver-novedades").click();
    await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(EXPECTED_NEW_COUNT);
  });

  test("the onlyNew chip clears the filter and restores the full (still reject-hiding, D-094) feed", async ({
    page,
  }) => {
    skipIfNoDb(test);
    // Deep-link with an already-frozen anchor, as the button itself would send.
    await page.goto(`/profiles/${profileWithNewId}?onlyNew=true&newSince=${encodeURIComponent(PREVIOUS_VIEWED_AT)}`);
    await assertNoErrorSurface(page);
    await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(EXPECTED_NEW_COUNT);

    await page.getByTestId("filter-chip-clear-onlyNew").click();

    await expect(page).not.toHaveURL(/onlyNew/);
    // Clearing onlyNew removes ONLY that filter — the feed's own default
    // reject-exclusion (D-094, `view=all`/no `includeRejected`) is untouched,
    // so the rejected candidate stays hidden even here: 2 now + 2 gap + 3 old
    // = 7, NOT +1 rejected.
    const total = NEW_NOW_COUNT + GAP_COUNT + OLD_COUNT;
    await expect(page.locator('[data-testid="candidate-card"]')).toHaveCount(total);
    for (const id of oldPropertyIds) {
      await expect(page.locator(`[data-testid="candidate-card"][data-property-id="${id}"]`)).toBeVisible();
    }
    await expect(
      page.locator(`[data-testid="candidate-card"][data-property-id="${rejectedPropertyId}"]`),
    ).toHaveCount(0);
  });

  test("a bare onlyNew=true with no newSince snapshot (no button, no chip involved) falls back to the live anchor — documented best-effort, not asserted race-free", async ({
    page,
  }) => {
    skipIfNoDb(test);
    // No newSince: the live-anchor fallback path. Whatever it returns must at
    // least not error and must still exclude the rejected candidate (B2 is
    // anchor-independent).
    await page.goto(`/profiles/${profileWithNewId}?onlyNew=true`);
    await assertNoErrorSurface(page);
    await expect(
      page.locator(`[data-testid="candidate-card"][data-property-id="${rejectedPropertyId}"]`),
    ).toHaveCount(0);
  });
});

// Device emulation gotcha (see mobile-profiles.spec.ts's file header): under
// this project's chromium mobile emulation, `window.innerWidth` does NOT
// track the emulated viewport — always read `document.documentElement.clientWidth`.
test.describe("iPhone 13", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  async function clientWidth(page: Page): Promise<number> {
    return page.evaluate(() => document.documentElement.clientWidth);
  }

  test("no horizontal overflow and the button meets the 44px tap target", async ({ page }) => {
    skipIfNoDb(test);
    await page.goto("/profiles");
    const width = await clientWidth(page);
    expect(width).toBeLessThan(768); // sanity: this really is the mobile viewport

    const button = rowFor(page, profileWithNewId).getByTestId("profile-ver-novedades");
    await expect(button).toBeVisible();

    // Scoped to <main> — TopBar's own pre-existing mobile overflow (#571) is
    // explicitly out of scope here, same discipline mobile-profiles.spec.ts
    // uses.
    const offenders = await page.evaluate((clientW) => {
      const main = document.querySelector("main");
      if (!main) return [];
      const bad: { tag: string; testid: string | null; right: number }[] = [];
      main.querySelectorAll("*").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > clientW + 1) {
          bad.push({ tag: el.tagName, testid: el.getAttribute("data-testid"), right: rect.right });
        }
      });
      return bad;
    }, width);
    expect(offenders).toEqual([]);

    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // Tap target >= 44px (D-124's floor — he is using a thumb).
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
