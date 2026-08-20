/**
 * E2E: the property-detail triage bar (#585).
 *
 * The owner's own framing: "lo que busco es una forma fácil de categorizar
 * todo" — he is triaging a long queue on a phone, with his thumb. This spec
 * proves the whole loop end to end: see price+score → vote → land on the
 * next candidate, on BOTH a phone viewport (390px, iPhone 13 emulation —
 * same pattern as e2e/mobile-topbar.spec.ts / mobile-dedup.spec.ts) and
 * desktop (the project's default Desktop Chrome viewport — #585 is
 * explicit the bar is not a mobile-only feature).
 *
 * MEASUREMENT TRAP (do not undo this): assert against
 * `document.documentElement.clientWidth`, never `window.innerWidth` — under
 * Chromium device emulation `innerWidth` reports the zoom-level layout
 * viewport (653 on this project's iPhone 13 emulation) and hides real
 * overflow. See mobile-topbar.spec.ts's file header for the same note.
 *
 * The single most important test here is "a failed vote does NOT
 * navigate" — it is the assertion that protects the trust property this
 * whole feature exists for (a lost verdict in a categorize-everything
 * workflow destroys trust in the loop). Do not skip or weaken it.
 *
 * Same real-server/real-Postgres/admin-cookie pattern as
 * e2e/property-detail.spec.ts / e2e/reject-consistency.spec.ts. Skips
 * cleanly if no DB is reachable or ADMIN_API_KEY is unset.
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

// Distinct coordinates from the other specs so concurrent runs can't collide
// (same technique as reject-consistency.spec.ts).
const POINTS: [number, number][] = [
  [38.5, -6.5], // top
  [38.6, -6.4], // middle
  [38.4, -6.6], // bottom
];
const NAME_PREFIX = "e2e-triage-loop-";
// Deliberately IDENTICAL price and m2_built across all three (not the
// distinct-per-property values reject-consistency.spec.ts uses) — #452's
// below-market boost compares each candidate's price/m² against a pool/zone
// median drawn from this shared, heavily concurrent dev DB, whose contents
// churn in real time as other worktrees' e2e suites run against it. A price
// spread across these three would let that boost (up to +0.25, more with
// other signals) outweigh the 0.4 gap between their `score` values and
// silently reorder them between runs — exactly the failure this spec hit
// once already ("end of queue" intermittently found bottomId still had a
// next). Identical price/m2 keeps every candidate's below-market signal ~0
// regardless of the live pool, so `score` alone is what orders them.
const PRICE = 300000;
const M2_BUILT = 65;

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let topId: number;
let middleId: number;
let bottomId: number;

async function insertProperty(coords: [number, number], m2: number, address: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, address)
     VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
    [coords[0], coords[1], m2, address],
  );
  return result.rows[0].id;
}

// Source is "idealista", not "fotocasa" — deliberately (D-055 /
// lib/db/source-active.ts): a source whose connector is currently OFF is
// hidden from the candidate feed entirely, and this project's shared dev DB
// has `fotocasa.enabled = false` today (some other worktree's connector-ops
// task), which silently zeroed this spec's whole candidate pool the first
// time it ran. `idealista` is capture-only (`supports_discovery = false`) so
// the feed keys off `capture_enabled` instead, which stays true here — same
// workaround `e2e/mobile-property-detail.spec.ts` (#584) already documents.
async function insertListing(propertyId: number, price: number): Promise<void> {
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
     VALUES ($1, 'idealista', $2, 'active', $3, NOW())`,
    [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, price],
  );
}

// score fixes the feed ordering deterministically: top > middle > bottom —
// same technique as reject-consistency.spec.ts.
async function markMatched(propertyId: number, score: number): Promise<void> {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score)
     VALUES ($1, $2, true, $3)`,
    [profileId, propertyId, score],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[triage-loop.spec] no reachable Postgres - skipping e2e suite.");
    return;
  }

  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: POINTS[0], radius_km: 25 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  topId = await insertProperty(POINTS[0], M2_BUILT, `${NAME_PREFIX}Calle Alfa`);
  middleId = await insertProperty(POINTS[1], M2_BUILT, `${NAME_PREFIX}Calle Beta`);
  bottomId = await insertProperty(POINTS[2], M2_BUILT, `${NAME_PREFIX}Calle Gamma`);

  await insertListing(topId, PRICE);
  await insertListing(middleId, PRICE);
  await insertListing(bottomId, PRICE);

  // Real, non-null scores (not just "matched") so the investor-score chip
  // renders a real band, not "Sin puntuar" — EC-7 needs a real number to
  // compare bar-vs-body.
  await markMatched(topId, 0.9);
  await markMatched(middleId, 0.5);
  await markMatched(bottomId, 0.1);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  const ids = [topId, middleId, bottomId];
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM profile_listing_state WHERE profile_id = $1", [profileId]);
  await pool.query("DELETE FROM search_profile WHERE id = $1", [profileId]);
  await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [ids]);
  await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [ids]);
  await pool.end();
});

function skipIfNoDb(test_: typeof test) {
  test_.skip(!dbAvailable, "no reachable Postgres");
}

// Each test starts from a neutral verdict — an earlier test that voted would
// otherwise change what the next one sees (same isolation pattern as
// reject-consistency.spec.ts).
test.beforeEach(async () => {
  if (!dbAvailable) return;
  await pool.query("DELETE FROM feedback_event WHERE profile_id = $1", [profileId]);
});

async function documentClientWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.clientWidth);
}
async function documentScrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

/**
 * The app shell's actual scrolling container is `main.main-content`
 * (`app/layout.tsx`, `overflow: auto`) — `<body>`/`<html>` never scroll
 * (verified: `window.scrollY` stays 0 after a `page.mouse.wheel`, which only
 * scrolls whatever element the pointer happens to sit over). Scroll THIS
 * element directly rather than the window/mouse-wheel, or "scroll to the
 * bottom" silently no-ops.
 */
async function scrollMainContentToBottom(page: Page): Promise<void> {
  await page.locator(".main-content").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

/**
 * Proves the bar is genuinely STICKY, not merely present in the DOM: scroll
 * `.main-content` to the bottom by a SUBSTANTIAL amount (so this can't pass
 * vacuously on a page too short to need scrolling at all — a non-sticky bar
 * on a short page would still happen to sit near the top) and assert the
 * bar is still pinned near the top of the viewport afterwards. A non-sticky
 * element would have scrolled away with the rest of the content instead,
 * ending up hundreds of pixels down (or off-screen entirely). The exact
 * resting y depends on `.main-content`'s own padding (globals.css) plus the
 * bar's own margin — deliberately not compared against a "before" position
 * pixel-for-pixel (async sections below the fold can still be settling their
 * own height at that point, which is layout noise unrelated to stickiness),
 * just asserted to be small in absolute terms.
 */
async function assertBarStaysStickyAcrossScroll(page: Page): Promise<void> {
  const bar = page.getByTestId("triage-bar");
  await expect(bar).toBeVisible();

  const mcScrollTopBefore = await page.locator(".main-content").evaluate((el) => el.scrollTop);
  await scrollMainContentToBottom(page);
  const mcScrollTopAfter = await page.locator(".main-content").evaluate((el) => el.scrollTop);
  // The scroll must have actually happened, and by a lot — or the "stays
  // visible" proof below is vacuous (a short page with nothing to scroll
  // would trivially leave the bar near the top regardless of stickiness).
  expect(mcScrollTopAfter - mcScrollTopBefore).toBeGreaterThan(200);

  await expect(bar).toBeVisible();
  const afterBox = await bar.boundingBox();
  expect(afterBox).not.toBeNull();
  // Still pinned near the top of the viewport (under the 56px TopBar),
  // nowhere near the hundreds of pixels a non-sticky bar would have scrolled.
  //
  // #585 review N1/N2/N3: this threshold was `< 200` and passed at EVERY
  // wrong `top` value tried while building this bar — y≈132-136 with
  // `top: 56px` (double-counts the TopBar offset) and y≈76 with `top: 0`
  // (doesn't cancel `.main-content`'s own `padding-top`, so content —
  // including the "Puntuación inversora" heading — visibly slices under the
  // bar). `< 100` is the first threshold that rejects both; the correct
  // `top: calc(-1 * var(--pad, 20px))` (globals.css) rests at y=56.
  expect(afterBox!.y).toBeLessThan(100);
}

/**
 * #585 review B1: `boundingBox()` alone is BLIND to occlusion — a control
 * can have a perfectly correct 44×44 box while something else (the Leaflet
 * location map, `z-index: 400` panes with no stacking context before the
 * `.leaflet-container { isolation: isolate }` fix) paints over it and
 * intercepts the tap. This is the real hit-test: what element does the
 * BROWSER actually resolve at this point's centre, via the same
 * `elementFromPoint` a real tap goes through. Returns null if the control
 * itself isn't even found (e.g. hidden).
 */
async function elementAtControlCentre(page: Page, testId: string): Promise<string | null> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) return null;
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const testEl = el.closest("[data-testid]");
      return testEl?.getAttribute("data-testid") ?? el.tagName.toLowerCase();
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

/**
 * Asserts a control is not just present-with-a-box but actually the
 * front-most hit at its own centre point, at several scroll positions
 * across the page (not just "loaded, unscrolled") — occlusion by content
 * that scrolls underneath a sticky element (the map tile, #585 review B1)
 * only shows up once you're actually scrolled to where that content sits
 * behind the bar.
 */
async function assertControlNeverOccluded(page: Page, testId: string): Promise<void> {
  const mc = page.locator(".main-content");
  const scrollHeight = await mc.evaluate((el) => el.scrollHeight);
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const target = Math.round((scrollHeight * i) / steps);
    await mc.evaluate((el, top) => {
      el.scrollTop = top;
    }, target);
    const hit = await elementAtControlCentre(page, testId);
    expect(hit, `${testId} occluded at scrollTop=${target} (elementFromPoint hit "${hit}")`).toBe(testId);
  }
}

async function seedAndSkip(page: Page, baseURL: string | undefined) {
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
}

/**
 * The triage bar mounts immediately (before `property` loads — see
 * TriageBar's doc comment), so `property-detail-page` alone being visible is
 * NOT proof the rest of the page (header, gallery, score breakdown) has
 * rendered — while `loading`, the page body is a single short "Cargando
 * propiedad…" line, nowhere near tall enough to require the `.main-content`
 * scroll a stickiness test depends on. Wait for the header's `<h1>` (only
 * rendered once `property` is loaded) before scrolling/reading the body.
 */
async function waitForPropertyLoaded(page: Page): Promise<void> {
  await page.locator("h1").first().waitFor({ state: "visible" });
}

/**
 * Waits for the confirmed feedback POST to resolve (not just the optimistic
 * click) before returning — the same pattern property-detail.spec.ts /
 * reject-consistency.spec.ts use, and the exact round trip #585 requires the
 * navigation to wait on.
 */
async function voteAndWaitForPost(page: Page, button: ReturnType<Page["getByTestId"]>) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => /\/feedback(\?|$)/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
    ),
    button.click(),
  ]);
  return response;
}

/**
 * #585 review B2: the ONLY reliable way to assert "navigation did NOT
 * happen" — a plain `expect(page).toHaveURL(startUrl)` right after an
 * action is INERT: Playwright's `toHaveURL` polls and returns on its FIRST
 * matching check, which (with no wait in between) is almost always before
 * `router.push` has had a chance to run at all — so it passes whether or
 * not a navigation was already in flight. This was proven directly during
 * review: reverting `onVoted` to fire optimistically (the exact bug these
 * tests exist to catch) left every assertion in this file green.
 *
 * This instead POSITIVELY waits (a bounded amount of time) for navigation
 * TO the URL a bug would produce, and asserts that wait times out — an
 * explicit "no such navigation occurred within the window", not "the URL
 * happened to still match on the first poll".
 */
async function assertDidNotNavigateTo(page: Page, urlPattern: RegExp, timeoutMs = 1500): Promise<void> {
  const navigated = await page
    .waitForURL(urlPattern, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  expect(navigated, `expected no navigation to ${urlPattern}, but it happened`).toBe(false);
}

/**
 * The end-of-queue case's B2 equivalent: there's no single "wrong" URL a
 * navigation bug would produce (no valid next candidate exists to name), so
 * instead POSITIVELY wait for the URL to leave `staysPattern` and assert
 * that wait times out. Same "actually wait, don't just poll once" fix as
 * `assertDidNotNavigateTo`.
 */
async function assertStaysAtUrl(page: Page, staysPattern: RegExp, timeoutMs = 1500): Promise<void> {
  const left = await page
    .waitForURL((url) => !staysPattern.test(url.toString()), { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  expect(left, `expected the page to stay at ${staysPattern}, but it navigated away`).toBe(false);
}

test.describe("triage bar (iPhone 13 emulation, 390px)", () => {
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test.beforeEach(async ({ page, baseURL }) => seedAndSkip(page, baseURL));

  test("triage bar stays visible and tappable at 390px", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await waitForPropertyLoaded(page);

    // No horizontal overflow — the "no overlap/no scroll" acceptance
    // criterion from #585's own task 1 acceptance list.
    expect(await documentScrollWidth(page)).toBeLessThanOrEqual(await documentClientWidth(page));

    // Scroll to the very bottom of the page (past the score breakdown, per
    // EC-1's own wording) and prove the bar is STILL on screen — the actual
    // sticky proof, not just "exists somewhere in the DOM".
    await assertBarStaysStickyAcrossScroll(page);

    // Every PRIMARY tap target in the bar is >=44px (WCAG 2.5.5) — prev/
    // next and the accept/reject pair. `feedback-note-toggle` is
    // DELIBERATELY smaller (#585 review ergonomics: demoted out of the
    // 44px triad — it writes no training signal and never advances the
    // loop) and checked separately below with only a presence/occlusion
    // requirement, not the 44px minimum.
    for (const testId of ["candidate-prev", "candidate-next", "feedback-accept", "feedback-reject"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `${testId} should have a bounding box`).not.toBeNull();
      expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId("feedback-note-toggle")).toBeVisible();

    // #585 review B1: `.leaflet-container` (react-leaflet's map root, no
    // stacking context of its own by default) must isolate its internal
    // `z-index: 400+` panes from the rest of the page — otherwise they
    // compete DIRECTLY against `.triage-bar`'s `z-index: 15` in the root
    // stacking context and can paint over ←/→/✓ once scrolled to where the
    // location map sits, with a perfectly valid 44×44 box underneath the
    // whole time (`boundingBox()` alone is blind to this — it never checks
    // what's actually on top). This is the deterministic guard: it fails
    // the instant the fix (`isolation: isolate`, globals.css) is removed,
    // regardless of whether THIS fixture's exact photo/gallery geometry
    // happens to produce a visible overlap at THIS viewport (geometric
    // hit-testing below is real, additional coverage, but — verified during
    // review — is sensitive to gallery layout and isn't reliable as the
    // ONLY guard).
    await page.locator(".leaflet-pane").first().waitFor({ state: "attached", timeout: 5000 });
    expect(
      await page.locator(".leaflet-container").first().evaluate((el) => getComputedStyle(el).isolation),
    ).toBe("isolate");

    // Real, additional hit-test coverage: `document.elementFromPoint` (what
    // an actual tap resolves against) at each control's own centre, across
    // several scroll positions spanning the WHOLE page — not just "does a
    // box exist", but "is this control actually the front-most thing there".
    for (const testId of [
      "candidate-prev",
      "candidate-next",
      "feedback-accept",
      "feedback-reject",
      "feedback-note-toggle",
    ]) {
      await assertControlNeverOccluded(page, testId);
    }
  });

  test("vote advances to the next candidate (accept and reject)", async ({ page }) => {
    skipIfNoDb(test);

    // Reject on top -> lands on middle (adjacency fetched pre-vote, D-094).
    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    const rejectRes = await voteAndWaitForPost(page, page.getByTestId("feedback-reject"));
    expect(rejectRes.ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${middleId}$`));
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    // Accept on middle -> lands on bottom.
    const acceptRes = await voteAndWaitForPost(page, page.getByTestId("feedback-accept"));
    expect(acceptRes.ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${bottomId}$`));
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
  });

  test("a vote confirmed before GET /adjacent settles still navigates correctly (race-safety, #585 review N11)", async ({
    page,
  }) => {
    skipIfNoDb(test);

    // Deliberately DELAY the adjacent fetch so the vote's POST (unthrottled)
    // is guaranteed to resolve first — pinning the race `handleVoted`'s
    // `adjacentPromiseRef` await exists to close, rather than relying on
    // the fetch happening to lose a timing race on a fast local server (the
    // way this bug was originally found and fixed during initial
    // development of this feature).
    await page.route("**/adjacent*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    // Vote immediately — the adjacent fetch (delayed above) has not
    // resolved yet at click time.
    const res = await voteAndWaitForPost(page, page.getByTestId("feedback-reject"));
    expect(res.ok()).toBe(true);

    // Once the delayed adjacent response finally lands, the navigation
    // still happens, and lands on the CORRECT next candidate — not a
    // silent no-op, not a false "Fin de la lista".
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${middleId}$`), {
      timeout: 5000,
    });
    await expect(page.getByTestId("triage-end-of-queue")).toHaveCount(0);
  });

  test("clear does not advance — re-tapping the active toggle stays put", async ({ page }) => {
    skipIfNoDb(test);

    // Seed top already accepted, directly via DB, so the FIRST click this
    // test makes is unambiguously a clear (re-tap of the active toggle) —
    // not entangled with any earlier accept in this same test.
    await pool.query(
      `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'accept')`,
      [profileId, topId],
    );

    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await expect(page.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "true");

    const res = await voteAndWaitForPost(page, page.getByTestId("feedback-accept"));
    expect(res.ok()).toBe(true);
    await expect(page.getByTestId("feedback-accept")).toHaveAttribute("aria-pressed", "false");
    // The point of this test: no navigation happened. `assertDidNotNavigateTo`
    // (#585 review B2) is the real assertion here — a plain `toHaveURL`
    // check right after the click would pass even with the guard removed
    // (proven in review: it returns on the FIRST poll, before `router.push`
    // has run).
    await assertDidNotNavigateTo(page, new RegExp(`/properties/${middleId}`));
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${topId}$`));
  });

  test("note does not advance", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    await page.getByTestId("feedback-note-toggle").click();
    await page.getByTestId("feedback-note-input").fill("ojo con la comunidad");
    const [noteRes] = await Promise.all([
      page.waitForResponse(
        (r) => /\/feedback(\?|$)/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
      ),
      page.getByTestId("feedback-note-submit").click(),
    ]);
    expect(noteRes.ok()).toBe(true);
    // The point of this test: no navigation happened (#585 review B2 —
    // see assertDidNotNavigateTo's doc comment for why a plain toHaveURL
    // check alone can't prove this).
    await assertDidNotNavigateTo(page, new RegExp(`/properties/${middleId}`));
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${topId}$`));
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
  });

  test("a failed vote does NOT navigate — the trust property this feature depends on", async ({
    page,
  }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    // Force the feedback POST to fail — a flaky mobile network, simulated.
    await page.route("**/feedback", (route) => route.abort("failed"));

    await page.getByTestId("feedback-reject").click();

    // The existing error surface shows...
    await expect(page.getByTestId("feedback-error")).toBeVisible();
    // ...the optimistic fill rolled back...
    await expect(page.getByTestId("feedback-reject")).toHaveAttribute("aria-pressed", "false");
    // ...and — the actual point of this test, the one #585 review called out
    // by name as the assertion that protects the whole feature — the page
    // did NOT navigate. `assertDidNotNavigateTo` (B2) actually waits for the
    // navigation a bug would produce and asserts it never arrives; a plain
    // `toHaveURL` right after the click was proven in review to pass even
    // with the guard removed (it polls, returns on the first — pre-
    // navigation — check).
    await assertDidNotNavigateTo(page, new RegExp(`/properties/${middleId}`));
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${topId}$`));
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
  });

  test("includeRejected survives auto-advance", async ({ page }) => {
    skipIfNoDb(test);

    // Pre-reject the middle candidate directly (so top's adjacency, fetched
    // fresh on this page load, already routes through it) and arrive with the
    // show-rejected flag on, exactly as the feed's "Mostrar descartadas"
    // toggle would carry it.
    await pool.query(
      `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, 'reject')`,
      [profileId, middleId],
    );

    await page.goto(`/profiles/${profileId}/properties/${topId}?includeRejected=true`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await expect(page.getByTestId("candidate-next")).toHaveAttribute(
      "href",
      `/profiles/${profileId}/properties/${middleId}?includeRejected=true`,
    );

    // Accept the (already-rejected, now re-accepted) middle candidate — the
    // vote must land on bottom, STILL carrying includeRejected=true.
    const res = await voteAndWaitForPost(page, page.getByTestId("feedback-accept"));
    expect(res.ok()).toBe(true);
    await expect(page).toHaveURL(
      new RegExp(`/profiles/${profileId}/properties/${middleId}\\?includeRejected=true$`),
    );
  });

  test("end of queue: voting on the last candidate shows 'Fin de la lista' instead of navigating", async ({
    page,
  }) => {
    skipIfNoDb(test);

    // Wait for the real GET /adjacent response, not just the DOM attribute —
    // `candidate-next` starts `aria-disabled="true"` from `adjacent`'s
    // initial `{ null, null }` state regardless of the real answer, so
    // asserting the attribute alone can pass on the loading placeholder
    // rather than the settled value.
    await Promise.all([
      page.waitForResponse((r) => /\/adjacent(\?|$)/.test(new URL(r.url()).pathname)),
      page.goto(`/profiles/${profileId}/properties/${bottomId}`),
    ]);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await expect(page.getByTestId("candidate-next")).toHaveAttribute("aria-disabled", "true");
    // #585 review N4: prev must already be live and usable — bottom's own
    // predecessor exists regardless of what happens to "next".
    await expect(page.getByTestId("candidate-prev")).toHaveAttribute(
      "href",
      `/profiles/${profileId}/properties/${middleId}`,
    );

    const res = await voteAndWaitForPost(page, page.getByTestId("feedback-accept"));
    expect(res.ok()).toBe(true);

    // Stayed on bottom — no navigation attempted (#585 review B2: an actual
    // wait-and-confirm-it-times-out, not a single poll that would pass
    // regardless).
    await assertStaysAtUrl(page, new RegExp(`/profiles/${profileId}/properties/${bottomId}$`));
    const endState = page.getByTestId("triage-end-of-queue");
    await expect(endState).toBeVisible();
    await expect(endState).toContainText(/fin de la lista/i);

    // #585 review N4: "← Anterior" is still the SAME functional link it was
    // before voting — only the "next" slot was replaced, not the whole nav.
    await expect(page.getByTestId("candidate-prev")).toHaveAttribute(
      "href",
      `/profiles/${profileId}/properties/${middleId}`,
    );

    // #585 review N7: the end-of-queue back link is bound by the same ≥44px
    // rule as every other control in this bar — it was a 13px text link in
    // the first version, the one exception to that rule.
    const backLink = page.getByTestId("triage-back-to-profile");
    await expect(backLink).toBeVisible();
    const backLinkBox = await backLink.boundingBox();
    expect(backLinkBox).not.toBeNull();
    expect(backLinkBox!.width).toBeGreaterThanOrEqual(44);
    expect(backLinkBox!.height).toBeGreaterThanOrEqual(44);

    await backLink.click();
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
  });

  test("bar price and score match detail (EC-7)", async ({ page }) => {
    skipIfNoDb(test);

    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await waitForPropertyLoaded(page);

    const barPrice = await page.getByTestId("triage-bar-price").textContent();
    const headerPrice = await page.locator("h1").first().textContent();
    expect(barPrice?.trim()).toBe(headerPrice?.trim());

    // #585 review (ergonomics): the bar folds the score into the compact
    // price string ("300.000 € · 55") instead of rendering the full
    // InvestorScoreChip component — still `toDisplayScore` from
    // lib/display-score.ts underneath (D-100 derive-once), just a plainer
    // inline element than the card's chip.
    const barScore = page.getByTestId("triage-bar-score");
    const bodySection = page.getByTestId("investor-score-section");
    await expect(barScore).toBeVisible();
    await expect(bodySection).toBeVisible();
    expect(await barScore.getAttribute("data-score")).toBe(await bodySection.getAttribute("data-score"));
    expect(await barScore.getAttribute("data-grade")).toBe(await bodySection.getAttribute("data-grade"));
  });
});

test.describe("triage bar (desktop, >=768px)", () => {
  // No device override: the project's own Desktop Chrome viewport
  // (playwright.config.ts) applies — #585 is explicit the bar ships on
  // desktop too, not behind a mobile-only toggle.
  test.beforeEach(async ({ page, baseURL }) => seedAndSkip(page, baseURL));

  test("triage bar stays visible and tappable at desktop width", async ({ page }) => {
    skipIfNoDb(test);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await waitForPropertyLoaded(page);

    expect(await documentScrollWidth(page)).toBeLessThanOrEqual(await documentClientWidth(page));

    await assertBarStaysStickyAcrossScroll(page);

    // Same primary-vs-demoted-note split as the mobile version — see that
    // test's comment for why `feedback-note-toggle` isn't held to 44px.
    for (const testId of ["candidate-prev", "candidate-next", "feedback-accept", "feedback-reject"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `${testId} should have a bounding box`).not.toBeNull();
      expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId("feedback-note-toggle")).toBeVisible();

    // #585 review B1 — same deterministic isolation check as the mobile
    // version (see that test's comment for why this, not the hit-test loop
    // alone, is the reliable regression guard).
    await page.locator(".leaflet-pane").first().waitFor({ state: "attached", timeout: 5000 });
    expect(
      await page.locator(".leaflet-container").first().evaluate((el) => getComputedStyle(el).isolation),
    ).toBe("isolate");

    // Same occlusion hit-test as the mobile version.
    for (const testId of [
      "candidate-prev",
      "candidate-next",
      "feedback-accept",
      "feedback-reject",
      "feedback-note-toggle",
    ]) {
      await assertControlNeverOccluded(page, testId);
    }
  });

  test("vote advances to the next candidate on desktop too", async ({ page }) => {
    skipIfNoDb(test);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/profiles/${profileId}/properties/${topId}`);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();

    const res = await voteAndWaitForPost(page, page.getByTestId("feedback-reject"));
    expect(res.ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}/properties/${middleId}$`));
  });
});
