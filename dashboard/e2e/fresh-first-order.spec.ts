/**
 * E2E (D-041): the feed's fresh-first ORDERING (#425, plan #415 §3.2 — phase 3)
 * against a real Next.js server + seeded Postgres. This is the plan's
 * highest-risk change: the novelty tier becomes the LEADING sort key across
 * three call sites (list ORDER BY, the keyset cursor, and the detail page's
 * prev/next), and getting one wrong desynchronises them SILENTLY. This suite
 * covers BOTH silent failure modes the plan names, plus cold-start.
 *
 * What it proves:
 *   (a) paging ACROSS the tier boundary (fresh block → old block) yields NO
 *       duplicates and NO skips, and every fresh (tier-1) card sorts before
 *       every old (tier-0) card — the keyset cursor carries the tier correctly;
 *   (b) walking the detail page's prev/next visits the SAME properties in the
 *       SAME order as the list — the desync a list-only e2e can't catch (the
 *       fixture deliberately gives an OLD card a higher score than a FRESH card,
 *       so an adjacency that "forgot the tier" would interleave them and fail);
 *   (c) a cold-start profile (never visited / everything new) shows the single
 *       "Perfil nuevo: todo es reciente" line and does NOT highlight every card.
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the schema applied. Skips
 * cleanly if none is reachable, matching novelty-badge.spec.ts /
 * price-change-badge.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
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
const NAME_PREFIX = "e2e-freshorder-";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

let pool: Pool;
let dbAvailable = false;

// Profile A — pagination across the tier boundary (30 fresh + 30 old = 60).
let boundaryProfileId: number;
// Profile B — prev/next matches the list (3 fresh + 3 old, no pagination).
let adjacencyProfileId: number;
// Profile C — cold-start (never visited, everything new).
let coldStartProfileId: number;
// One tracked (accept) property in the cold-start profile — exempt from the
// suppression, so it must KEEP its fresh mark while the rest are suppressed.
let coldStartTrackedId: number;

async function seedProfile(
  prevViewedAt: string | null,
  lastViewedAt: string | null,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
      prevViewedAt,
      lastViewedAt,
    ],
  );
  return res.rows[0].id;
}

/**
 * Seeds one matched property with a single active-sale listing first-seen
 * `firstSeenAgo` before now, and (optionally) a learned score on the
 * profile_listing_state so the within-tier order is score-driven.
 */
async function seedMatched(
  profileId: number,
  firstSeenAgo: number,
  score: number | null,
  price = 300000,
): Promise<number> {
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
    [
      MADRID_SOL[0],
      MADRID_SOL[1],
      `${NAME_PREFIX}Calle ${Math.random().toString(36).slice(2)}, Madrid`,
    ],
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, last_seen_at)
     VALUES ($1, 'fotocasa', $2, 'active', 'sale', $3, $4::timestamptz, NOW())`,
    [
      propertyId,
      `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
      price,
      iso(firstSeenAgo),
    ],
  );
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score)
     VALUES ($1, $2, true, $3)`,
    [profileId, propertyId, score],
  );
  return propertyId;
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[fresh-first-order.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // Profile A: visited 2h ago (outside the 30-min debounce, so the page-GET
  // touch keeps the anchor at 2h ago). 30 fresh (first-seen 1h ago > anchor)
  // + 30 old (first-seen 3d ago < anchor). Coverage 50% < 60% → NOT cold-start,
  // so the tier is live. One full page (30) is exactly the fresh block, so
  // "Cargar más" pages across the tier boundary into the old block.
  boundaryProfileId = await seedProfile(iso(2 * HOURS), iso(2 * HOURS));
  for (let i = 0; i < 30; i++)
    await seedMatched(boundaryProfileId, 1 * HOURS, null); // fresh, tier 1
  for (let i = 0; i < 30; i++)
    await seedMatched(boundaryProfileId, 3 * DAYS, null); // old, tier 0

  // Profile B: same anchoring, only 6 rows (no pagination). Scores chosen so an
  // OLD card (0.8) outranks a FRESH card (0.5) on effective_score alone — the
  // list still puts all fresh first (tier leads), so an adjacency that ordered
  // on effective_score WITHOUT the tier would visit them in a DIFFERENT order.
  adjacencyProfileId = await seedProfile(iso(2 * HOURS), iso(2 * HOURS));
  await seedMatched(adjacencyProfileId, 1 * HOURS, 0.9); // fresh
  await seedMatched(adjacencyProfileId, 1 * HOURS, 0.7); // fresh
  await seedMatched(adjacencyProfileId, 1 * HOURS, 0.5); // fresh (below the old 0.8 on score alone)
  await seedMatched(adjacencyProfileId, 3 * DAYS, 0.8); // old (outscores the 0.5 fresh)
  await seedMatched(adjacencyProfileId, 3 * DAYS, 0.6); // old
  await seedMatched(adjacencyProfileId, 3 * DAYS, 0.4); // old

  // Profile C: NEVER visited (previous_viewed_at NULL) → cold-start by rule,
  // regardless of coverage. A handful of fresh rows, one of them tracked
  // (accept) — that one is EXEMPT from the cold-start suppression and must keep
  // its fresh mark while the untracked rows are quietened.
  coldStartProfileId = await seedProfile(null, null);
  coldStartTrackedId = await seedMatched(coldStartProfileId, 1 * HOURS, null);
  await pool.query(
    `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'accept')`,
    [coldStartProfileId, coldStartTrackedId],
  );
  for (let i = 0; i < 4; i++)
    await seedMatched(coldStartProfileId, 1 * HOURS, null);
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
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

// Every UI page is admin-gated (middleware.ts) — see e2e/helpers/admin-session.ts.
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

// D-041: assert no error surface is rendered anywhere on the page.
async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(
      /there is no parameter|http 500|error al cargar|detalles técnicos/i,
    ),
  ).toHaveCount(0);
}

const allCards = (page: Page) => page.locator('[data-testid="candidate-card"]');

/** Ordered property ids of every card currently rendered. */
async function renderedPropertyIds(page: Page): Promise<number[]> {
  const raw = await allCards(page).evaluateAll((els) =>
    els.map((el) => Number(el.getAttribute("data-property-id"))),
  );
  return raw;
}

/** True for each rendered card: does it carry the fresh (data-novelty) mark? */
async function renderedNoveltyFlags(page: Page): Promise<boolean[]> {
  return allCards(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-novelty") !== null),
  );
}

test("(a) paging across the tier boundary has no duplicates, no skips, and keeps every fresh card above every old card", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${boundaryProfileId}`);
  await assertNoErrorSurface(page);

  // Page 1 is exactly the 30-strong fresh (tier-1) block.
  await expect(allCards(page)).toHaveCount(30);
  const page1Ids = await renderedPropertyIds(page);
  expect(new Set(await renderedNoveltyFlags(page))).toEqual(new Set([true])); // all fresh

  // "Cargar más" pages across the boundary into the 30 old (tier-0) rows.
  const loadMore = page.getByRole("button", { name: /cargar más/i });
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await expect(allCards(page)).toHaveCount(60);
  await assertNoErrorSurface(page);

  const allIds = await renderedPropertyIds(page);
  const flags = await renderedNoveltyFlags(page);

  // No duplicates, no skips: 60 distinct ids across the two pages.
  expect(allIds).toHaveLength(60);
  expect(new Set(allIds).size).toBe(60);
  // Page 1's ids are the first 30 of the full list, in the same order (the
  // cursor resumed exactly where page 1 stopped — no row repeated or skipped).
  expect(allIds.slice(0, 30)).toEqual(page1Ids);
  // Fresh-first: the first 30 are all fresh (tier 1), the last 30 all old
  // (tier 0). A cursor that dropped the tier column would interleave them.
  expect(flags.slice(0, 30)).toEqual(Array(30).fill(true));
  expect(flags.slice(30)).toEqual(Array(30).fill(false));
});

test("(b) the detail page's prev/next visits the SAME properties in the SAME order as the list", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${adjacencyProfileId}`);
  await assertNoErrorSurface(page);
  await expect(allCards(page)).toHaveCount(6);
  const listOrder = await renderedPropertyIds(page);
  expect(listOrder).toHaveLength(6);

  // Open a property's detail page and wait for the client-side /adjacent fetch
  // (which drives prev/next) to actually resolve before reading the links —
  // otherwise we'd read the disabled placeholder span before the neighbours load.
  async function gotoDetail(
    propertyId: number,
  ): Promise<{ prevPropertyId: number | null; nextPropertyId: number | null }> {
    const [resp] = await Promise.all([
      page.waitForResponse((r) =>
        r.url().includes(`/properties/${propertyId}/adjacent`),
      ),
      page.goto(`/profiles/${adjacencyProfileId}/properties/${propertyId}`),
    ]);
    // Read the body BEFORE any further page interaction, or Chromium may evict it.
    const body = await resp.json();
    await assertNoErrorSurface(page);
    return body;
  }

  // Assert the RENDERED prev/next link (auto-waiting past the React re-render
  // that follows the /adjacent response) matches the expected neighbour id, or
  // is the disabled placeholder (no href) at the ends of the ranking.
  const assertLink = async (testId: string, expectedId: number | null) => {
    const link = page.getByTestId(testId);
    if (expectedId === null) {
      await expect(link).not.toHaveAttribute("href", /properties/);
    } else {
      await expect(link).toHaveAttribute(
        "href",
        new RegExp(`properties/${expectedId}(?:$|\\?)`),
      );
    }
  };

  // Walk the detail page's "Siguiente →" from the first list item, collecting
  // the property id at each hop, and assert it reproduces the list order EXACTLY
  // — the failure D-057 clause 4 names (prev/next stepping in a different order
  // than the feed) when the tier is missing from the adjacency key.
  const walked: number[] = [listOrder[0]];
  let current = listOrder[0];
  for (let i = 0; i < listOrder.length; i++) {
    const adj = await gotoDetail(current);
    await assertLink("candidate-next", adj.nextPropertyId);
    if (adj.nextPropertyId === null) break; // end of the ranking
    walked.push(adj.nextPropertyId);
    current = adj.nextPropertyId;
  }

  expect(walked).toEqual(listOrder);

  // Reset to the list so the reverse walk's first hop is a genuine navigation
  // (the forward walk left us on the last property; re-goto'ing the same URL
  // would be a router no-op and fire no /adjacent request).
  await page.goto(`/profiles/${adjacencyProfileId}`);
  await expect(allCards(page)).toHaveCount(6);

  // And the reverse walk ("← Anterior") from the last item reproduces the
  // reversed list order — prev is the mirror of next on the same 3-column key.
  const walkedBack: number[] = [listOrder[listOrder.length - 1]];
  current = listOrder[listOrder.length - 1];
  for (let i = 0; i < listOrder.length; i++) {
    const adj = await gotoDetail(current);
    await assertLink("candidate-prev", adj.prevPropertyId);
    if (adj.prevPropertyId === null) break;
    walkedBack.push(adj.prevPropertyId);
    current = adj.prevPropertyId;
  }
  expect(walkedBack).toEqual([...listOrder].reverse());
});

test("(c) a cold-start profile shows the single note and does NOT highlight every card", async ({
  page,
}) => {
  skipIfNoDb(test);

  await page.goto(`/profiles/${coldStartProfileId}`);
  await assertNoErrorSurface(page);

  // Real content rendered (not a skeleton / empty state).
  await expect(allCards(page)).toHaveCount(5);
  // The single explanatory line stands in for highlighting everything.
  await expect(page.getByTestId("novelty-cold-start-note")).toBeVisible();
  await expect(page.getByTestId("novelty-cold-start-note")).toHaveText(
    /perfil nuevo/i,
  );
  // Suppressed for the UNTRACKED rows: the only fresh mark left belongs to the
  // one tracked (accept) property — tracked is exempt from the cold-start
  // suppression ("seguimiento nunca suprimido"), everything else is quietened.
  await expect(
    page.locator('[data-testid="candidate-card"][data-novelty]'),
  ).toHaveCount(1);
  await expect(
    page.locator(
      `[data-testid="candidate-card"][data-property-id="${coldStartTrackedId}"]`,
    ),
  ).toHaveAttribute("data-novelty", "new");
});
