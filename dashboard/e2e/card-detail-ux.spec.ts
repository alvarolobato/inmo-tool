/**
 * E2E: candidate card + property detail UX overhaul (#152).
 *
 * Covers what unit tests structurally can't: that the hover-revealed action
 * bar is actually reachable and doesn't navigate, that the cold-start notice
 * appears once for the page rather than once per card, that lightbox
 * prev/next walks the real photo union, and that detail-page prev/next
 * follows the same ranking the list is sorted by.
 *
 * Same real-server/real-Postgres pattern as e2e/candidates.spec.ts; skips
 * cleanly when no Postgres is reachable.
 *
 * Every UI page in this app is gated on the `ps_admin` cookie (middleware.ts
 * gates by default — `/profiles/*` included), so the suite seeds that cookie
 * the way `/admin/login` does, following e2e/connectors.spec.ts. Without it
 * every navigation 307s to the login page and the assertions below would fail
 * on a page that is actually healthy.
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
const NAME_PREFIX = "e2e-card-ux-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
/** Ranked best → worst, so prev/next has a known expected sequence. */
let topId: number;
let middleId: number;
let bottomId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[card-detail-ux.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const profileResult = await pool.query<{ id: number }>(
    // #425: this spec tests prev/next MECHANICS on a pure score ordering, so it
    // must stay off the fresh-first tier. Seed the profile as already-visited
    // (previous_viewed_at 2 days ago) and its listings as old (below) so no row
    // is "new" — otherwise a never-visited profile with fresh listings is a
    // cold-start flood whose tracked-exemption would float the accepted cards
    // (the feedback tests here accept two) above the higher-scored top card,
    // reordering the ranking this test walks. Fresh-first ordering has its own
    // dedicated coverage in fresh-first-order.spec.ts.
    `INSERT INTO search_profile (name, scope, thesis_params, previous_viewed_at, last_viewed_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, NOW() - interval '2 days', NOW() - interval '2 days') RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MADRID_SOL, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  async function insertCandidate(
    address: string,
    score: number,
    rankExplanation: string,
    photoUrls: string[],
  ): Promise<number> {
    const property = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, rooms, bathrooms, floor, address)
       VALUES ($1, $2, 'piso', 82, 3, 2, '4', $3) RETURNING id`,
      [MADRID_SOL[0], MADRID_SOL[1], address],
    );
    const propertyId = property.rows[0].id;
    await pool.query(
      // #425: first-seen well before the profile's 2-day-ago visit anchor, so
      // no candidate is "new" and the ranking is pure score order (see the
      // profile INSERT comment above).
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at, photo_urls)
       VALUES ($1, 'fotocasa', $2, 'active', 289000, NOW() - interval '10 days', $3)`,
      [
        propertyId,
        `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`,
        photoUrls,
      ],
    );
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, rank_explanation)
       VALUES ($1, $2, true, $3, $4)`,
      [profileId, propertyId, score, rankExplanation],
    );
    return propertyId;
  }

  // Three photos on the top candidate so lightbox prev/next has somewhere to
  // go; distinct scores so the ranking (and therefore prev/next) is
  // deterministic rather than falling back to the id tiebreak.
  topId = await insertCandidate(
    `${NAME_PREFIX}Calle Trafalgar, Madrid`,
    0.91,
    "Rentabilidad bruta estimada del 6,2%, por encima de la media de la zona.",
    [
      `https://example.com/${NAME_PREFIX}1.jpg`,
      `https://example.com/${NAME_PREFIX}2.jpg`,
      `https://example.com/${NAME_PREFIX}3.jpg`,
    ],
  );
  middleId = await insertCandidate(
    `${NAME_PREFIX}Calle Goya, Madrid`,
    0.55,
    "Precio en línea con tu banda objetivo.",
    [],
  );
  // Exactly one photo (not zero) — the other real boundary case #167's
  // ticker gating needs covering: a lone photo still shows as the lead
  // image, but must not grow ticker controls (only 2+ photos do). Doesn't
  // disturb bottomId's other use (the "stays visible without hovering" test
  // below, which doesn't touch photos) or its ranking position (only the
  // score matters there, not the photo count).
  bottomId = await insertCandidate(
    `${NAME_PREFIX}Calle Alcalá, Madrid`,
    0.21,
    "Superficie por debajo de lo que sueles aceptar.",
    [`https://example.com/${NAME_PREFIX}bottom1.jpg`],
  );
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  // Feedback first: the "accept" click below writes a feedback_event, and its
  // FK to search_profile blocks the profile delete otherwise.
  await pool.query(
    "DELETE FROM feedback_event WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN (SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM property WHERE address LIKE $1", [
    `${NAME_PREFIX}%`,
  ]);
  await pool.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await seedAdminSession(page, baseURL);
});

async function assertNoErrorSurface(page: Page) {
  await expect(
    page.getByText(/error|hubo un problema|there is no parameter|http 500/i),
  ).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
}

function card(page: Page, propertyId: number) {
  return page.locator(
    `[data-testid="candidate-card"][data-property-id="${propertyId}"]`,
  );
}

test("cards render photo-first with price, facts and no per-card cold-start noise", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}`);
  await assertNoErrorSurface(page);

  const top = card(page, topId);
  await expect(top).toBeVisible();
  await expect(top.getByTestId("candidate-photo")).toBeVisible();
  await expect(top.getByTestId("candidate-price")).toContainText("289.000");
  // Every fact the issue asks to keep visible, on one line.
  const facts = top.getByTestId("candidate-facts");
  await expect(facts).toContainText("82 m²");
  await expect(facts).toContainText("3 hab.");
  await expect(facts).toContainText("2 baños");
  await expect(facts).toContainText("Planta 4");
  // These candidates have real (non-cold-start) explanations, so the footer
  // must not appear — the cold-start copy belongs to the profile, not a card.
  await expect(page.getByTestId("cold-start-footer")).toHaveCount(0);
});

// Latent ordering hazard (#152 review — left as a comment per the review's
// request, not fixed here): this test's `feedback-accept` click POSTs to the
// feedback route, which `await`s `retrainAndRescoreProfile` before
// responding — a real retrain against this profile's seeded rows, not a
// stub. The "detail page walks the ranking with prev/next" test below
// assumes topId/middleId/bottomId keep the score ordering `beforeAll` seeded
// them with (0.91/0.55/0.21). Playwright runs this file's tests sequentially
// (`fullyParallel: false`, `workers: 1` in playwright.config.ts), so that
// retrain genuinely completes before the prev/next test reads the ranking —
// this isn't hypothetical, it really executes.
//
// Two independent guards keep it a no-op today, and either one alone would
// suffice:
//
//   1. Only 3 properties are seeded in this file, permanently below
//      `MIN_TRAINING_EXAMPLES` (32 = 4x the 8-feature model, pipeline.ts) —
//      so `retrainAndRescoreProfile` can never reach the unconditional
//      "trained" branch (`retrain.ts`'s final UPDATE, no score filter) no
//      matter what feedback sequence runs against these 3 properties. It
//      always falls into the "needs_both_classes"/"below_training_threshold"
//      branch instead.
//   2. That branch only writes cold-start scores to rows that are still
//      unscored — `retrain.ts`'s `... AND pls.matched = true AND
//      pls.score IS NULL` (same guard the "going one-sided" test in
//      feedback/__tests__/route.test.ts exercises). All three rows here
//      already carry real, distinct `beforeAll`-written scores, so that
//      predicate matches nothing.
//
// Guard 1 is the one to watch: it depends on this file's candidate count
// staying well under 32. A future change that seeds many more candidates
// here (e.g. to test list pagination inside this same spec) would put real
// training back in reach, and a real training run's UPDATE has no `score IS
// NULL` restriction — it silently rewrites every matched row's score for
// this profile, which would then race the prev/next test below. Keep
// deliberate multi-class/high-volume feedback scenarios in a separate spec
// file (e.g. feedback.spec.ts) rather than adding them here.
test("the action bar is reachable on hover and acting on it does not navigate", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}`);
  const target = card(page, middleId);
  await expect(target).toBeVisible();

  const actions = target.getByTestId("candidate-card-actions");
  // #167: visibility moved from the wrapper (.candidate-card-actions) down
  // to each button (.feedback-toggle) so a marked property's active button
  // can stay visible without hover while its unmarked siblings still don't —
  // see globals.css's "Candidate card action overlay" comment for why a
  // parent's opacity can't be selectively overridden by a child. Baseline:
  // an unmarked property's reject button is hidden (opacity 0) until the
  // card is hovered.
  const reject = actions.getByTestId("feedback-reject");
  await expect(reject).toHaveCSS("opacity", "0");

  await target.hover();
  await expect(reject).toHaveCSS("opacity", "1");

  await actions.getByTestId("feedback-accept").click();
  await expect(actions.getByTestId("feedback-accept")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The whole point of keeping the controls a sibling of the <Link>.
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
  await assertNoErrorSurface(page);
});

// #167: the currently-active status button must stay visible without hover
// — a marked property should read as marked while scanning the list — while
// every other (unmarked) button on the same card keeps the original
// hover-only behaviour. Separate test from the one above because that one
// hovers before clicking, which never exercises the no-hover case this
// feature exists for.
test("#167: the button matching the property's current feedback state stays visible without hovering, unlike the rest of the row", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}`);
  const target = card(page, bottomId);
  await expect(target).toBeVisible();

  const actions = target.getByTestId("candidate-card-actions");
  // #422: the star toggle is gone — accept ("Seguir") is now the tracked
  // positive state whose active button stays visible. reject is the unmarked
  // sibling that stays hover-only.
  const accept = actions.getByTestId("feedback-accept");
  const reject = actions.getByTestId("feedback-reject");

  // Unmarked: both hidden without hover (baseline, unchanged by #167).
  await expect(accept).toHaveCSS("opacity", "0");
  await expect(reject).toHaveCSS("opacity", "0");

  // Mark it, then move the mouse fully away so no hover/focus-within path
  // is active — this is the state the feature is actually for.
  await target.hover();
  await accept.click();
  await expect(accept).toHaveAttribute("aria-pressed", "true");
  // Move the mouse fully away AND blur the just-clicked button — a real
  // click leaves it focused, and :focus-within would otherwise reveal the
  // whole row exactly like :hover does, masking the thing this test exists
  // to prove. Neither hover nor focus-within may be active for this
  // assertion to mean anything.
  await page.mouse.move(0, 0);
  await accept.evaluate((el) => (el as HTMLElement).blur());
  // globals.css transitions .feedback-toggle's opacity over 120ms — reading
  // it immediately after the hover/focus state clears can catch a transient,
  // still-decaying value (e.g. still "1" a few ms into an animation *toward*
  // 0), which would make `toHaveCSS("opacity", "1")` pass on a technicality
  // even for a genuinely broken always-visible feature (caught by #167's
  // required mutation test: asserting right after the move/blur passed even
  // with data-active hardcoded to false, because the transition hadn't
  // settled to 0 yet). Wait past the transition so the assertion reads the
  // final, settled value.
  await page.waitForTimeout(200);

  await expect(accept).toHaveCSS("opacity", "1");
  // The un-marked reject button on the SAME card stays hover-only — this is
  // "only that one button", not "the whole row once anything is marked".
  await expect(reject).toHaveCSS("opacity", "0");

  // Distinguishable from a hover-revealed unset button, not just "visible":
  // the active button gets a solid, semantically-coloured fill (--up for
  // accept) rather than the muted rgba(0,0,0,0.35) every hover-revealed
  // inactive button uses. Both checks are required — "not muted" alone
  // passed even for a deleted --up token (an undefined var() resolves to
  // fully transparent, rgba(0, 0, 0, 0), which is also "not the muted
  // fill" without being a real colour at all) until this second assertion
  // was added.
  const acceptBg = await accept.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(acceptBg).not.toBe("rgba(0, 0, 0, 0.35)");
  expect(acceptBg).not.toBe("rgba(0, 0, 0, 0)");
});

test("lightbox walks the photo union with buttons and arrow keys", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}/properties/${topId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await page.getByTestId("photo-gallery-thumb").first().click();
  const counter = page.getByTestId("photo-gallery-counter");
  await expect(counter).toHaveText("1 / 3");

  await page.getByTestId("photo-gallery-next").click();
  await expect(counter).toHaveText("2 / 3");

  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("3 / 3");

  await page.keyboard.press("ArrowLeft");
  await expect(counter).toHaveText("2 / 3");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("photo-gallery-lightbox")).toHaveCount(0);
});

test("#167: the list-card photo ticker cycles the property's photos in place, wraps at both ends, and never navigates", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}`);
  const target = card(page, topId);
  await expect(target).toBeVisible();

  const img = target.getByTestId("candidate-photo-img");
  const ticker = target.getByTestId("candidate-photo-ticker");
  const next = ticker.getByTestId("candidate-photo-next");
  const prev = ticker.getByTestId("candidate-photo-prev");

  await expect(img).toHaveAttribute("src", /1\.jpg$/);
  // Hidden until hover, same three-path rule as the action bar.
  await expect(next).toHaveCSS("opacity", "0");

  await target.hover();
  await expect(next).toHaveCSS("opacity", "1");

  await next.click();
  await expect(img).toHaveAttribute("src", /2\.jpg$/);
  await next.click();
  await expect(img).toHaveAttribute("src", /3\.jpg$/);
  // Wraps forward past the last photo back to the first.
  await next.click();
  await expect(img).toHaveAttribute("src", /1\.jpg$/);
  // Wraps backward past the first photo to the last.
  await prev.click();
  await expect(img).toHaveAttribute("src", /3\.jpg$/);

  // The whole point: flicking through photos must never leave the list.
  await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
  await assertNoErrorSurface(page);
});

test("#167: locally-scoped arrow keys cycle the focused card's ticker without a document-level listener", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}`);
  const target = card(page, topId);
  const img = target.getByTestId("candidate-photo-img");
  const next = target
    .getByTestId("candidate-photo-ticker")
    .getByTestId("candidate-photo-next");

  await next.focus();
  await expect(img).toHaveAttribute("src", /1\.jpg$/);

  await page.keyboard.press("ArrowRight");
  await expect(img).toHaveAttribute("src", /2\.jpg$/);
  await page.keyboard.press("ArrowLeft");
  await expect(img).toHaveAttribute("src", /1\.jpg$/);
});

test("#167: a property with zero or one photo shows no ticker controls", async ({
  page,
}) => {
  await page.goto(`/profiles/${profileId}`);

  // middleId was seeded with photoUrls: [] — the existing placeholder, no
  // ticker (an empty photo array is not the same as "one photo").
  await expect(
    card(page, middleId).getByTestId("candidate-photo-placeholder"),
  ).toBeVisible();
  await expect(
    card(page, middleId).getByTestId("candidate-photo-ticker"),
  ).toHaveCount(0);

  // bottomId was seeded with exactly ONE photo — the test's title claimed
  // this case but nothing here actually exercised it until now (the seed
  // had no 1-photo property). This is the more interesting boundary: unlike
  // zero photos, a lone photo still renders as the real lead image (not the
  // placeholder), but must still grow no ticker (`hasTicker = photos.length
  // > 1` in CandidatePhotoTicker.tsx).
  const bottom = card(page, bottomId);
  await expect(bottom.getByTestId("candidate-photo-img")).toHaveAttribute(
    "src",
    /bottom1\.jpg$/,
  );
  await expect(bottom.getByTestId("candidate-photo-placeholder")).toHaveCount(
    0,
  );
  await expect(bottom.getByTestId("candidate-photo-ticker")).toHaveCount(0);
});

test("detail page walks the ranking with prev/next, disabled at the ends", async ({
  page,
}) => {
  // Middle of the ranking: both directions available.
  await page.goto(`/profiles/${profileId}/properties/${middleId}`);
  await expect(page.getByTestId("property-detail-page")).toBeVisible();
  await assertNoErrorSurface(page);

  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${bottomId}`,
  );
  await page.getByTestId("candidate-prev").click();
  await expect(page).toHaveURL(
    new RegExp(`/profiles/${profileId}/properties/${topId}$`),
  );

  // Top of the ranking: "previous" is present but inert, so the controls
  // don't shift position as you move through the queue.
  await expect(page.getByTestId("candidate-prev")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${middleId}`,
  );
  await assertNoErrorSurface(page);

  // Bottom of the ranking: the mirror case.
  await page.goto(`/profiles/${profileId}/properties/${bottomId}`);
  await expect(page.getByTestId("candidate-next")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByTestId("candidate-prev")).toHaveAttribute(
    "href",
    `/profiles/${profileId}/properties/${middleId}`,
  );
});

// #167 requires two things to hold specifically on touch, where nothing is
// hover-revealed and everything the desktop CSS rules gate on :hover is
// permanently visible instead (@media (hover: none) in globals.css):
//   1. the action bar and photo ticker must actually be reachable — measured
//      via real device emulation, not inferred from reading the CSS (a
//      prior review explicitly asked for computed-style verification here);
//   2. because "visible" carries no signal at all once everything is always
//      visible, the active status button must be distinguishable by its own
//      fill colour, not by whether it's shown.
test.describe("#167: touch/coarse-pointer behaviour (iPhone 13 emulation)", () => {
  // Destructure out `defaultBrowserType` (webkit) — this project's single
  // Playwright project is chromium (playwright.config.ts), and Playwright
  // refuses `defaultBrowserType` inside a describe block because switching
  // browser engines requires a new worker, not just new context options.
  // Chromium's mobile emulation (viewport/isMobile/hasTouch below) is what
  // actually flips `@media (hover: none)`, independent of engine choice.
  const { defaultBrowserType: _defaultBrowserType, ...iPhone13 } =
    devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("action bar and photo ticker are permanently visible without hover on a touch device, and the active status button is visually distinct from a merely-visible one", async ({
    page,
  }) => {
    // The active status fill is an inline React style set by FeedbackControls.
    // #379 removed the residual #167 flake at its root: the card now embeds
    // each row's verdict (candidate feed `feedback_state`) and passes it as
    // `initialState`, so FeedbackControls no longer issues a per-card mount GET
    // that could resolve *after* the tap and clobber the optimistic "accept"
    // back to null. Only the tap's POST remains async, and it's awaited below —
    // nothing else is in flight to revert "accept" when the colours are read.
    await page.goto(`/profiles/${profileId}`);
    const target = card(page, topId);
    await expect(target).toBeVisible();

    const actions = target.getByTestId("candidate-card-actions");
    const reject = actions.getByTestId("feedback-reject");
    const accept = actions.getByTestId("feedback-accept");
    // No hover event exists on this device — @media (hover: none) makes the
    // whole row visible unconditionally, unlike the desktop baseline above.
    await expect(reject).toHaveCSS("opacity", "1");
    await expect(accept).toHaveCSS("opacity", "1");

    const ticker = target.getByTestId("candidate-photo-ticker");
    const tickerNext = ticker.getByTestId("candidate-photo-next");
    await expect(tickerNext).toHaveCSS("opacity", "1");

    const img = target.getByTestId("candidate-photo-img");
    await expect(img).toHaveAttribute("src", /1\.jpg$/);
    await tickerNext.tap();
    await expect(img).toHaveAttribute("src", /2\.jpg$/);
    // Tapping the ticker on a touch device must not navigate either.
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));

    // Mark this card, then prove the active button reads as active even
    // though every button here was already opacity: 1 before the tap —
    // "visible" alone can't be the signal on this device.
    const rejectBgBefore = await reject.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    // Await the POST so the state is reconciled server-side to "accept"
    // (terminal), not merely optimistically set, before reading any colour.
    // With no mount GET anymore (#379 — state arrives embedded), this is the
    // only in-flight setState, so nothing can revert the fill after we sample it.
    const topFeedbackPost = page.waitForResponse(
      (r) =>
        r.url().includes(`/candidates/${topId}/feedback`) &&
        r.request().method() === "POST",
    );
    await accept.tap();
    await topFeedbackPost;
    await expect(accept).toHaveAttribute("aria-pressed", "true");
    await expect(accept).toHaveCSS("opacity", "1");

    // Settled active fill: neither the muted inactive colour nor a transparent
    // deleted-token value. Web-first + auto-retrying. There is no CSS
    // transition on background-color (only opacity/transform animate —
    // globals.css), so this resolves directly to the final colour, and with
    // both async setState sources now resolved nothing can revert it.
    await expect(accept).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0.35)",
    );
    // Reject is never tapped — assert it holds the muted inactive fill so the
    // rejectBgBefore/After comparison below is against a deterministic value.
    await expect(reject).toHaveCSS("background-color", "rgba(0, 0, 0, 0.35)");

    const acceptBg = await accept.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const rejectBgAfter = await reject.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    // The now-active accept button gets a distinct, semantically-coloured
    // fill (--up, green) — not the muted rgba(0,0,0,0.35) every
    // visible-but-inactive button (reject, unchanged before/after) keeps.
    expect(acceptBg).not.toBe(rejectBgAfter);
    expect(rejectBgAfter).toBe(rejectBgBefore);
    // "Distinct from reject" alone passed even for a deleted --up token: an
    // undefined var() resolves to fully transparent (rgba(0, 0, 0, 0)),
    // which is trivially "not equal" to reject's opaque muted fill without
    // acceptBg being a real colour at all. Assert it resolves to something
    // real too.
    expect(acceptBg).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("a property with zero photos shows the placeholder, not a ticker, on touch too", async ({
    page,
  }) => {
    await page.goto(`/profiles/${profileId}`);
    const target = card(page, middleId);
    await expect(
      target.getByTestId("candidate-photo-placeholder"),
    ).toBeVisible();
    await expect(target.getByTestId("candidate-photo-ticker")).toHaveCount(0);
  });
});
