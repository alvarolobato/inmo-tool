/**
 * Real-Postgres integration test for the feedback event API (task 3.1, #20).
 *
 * Every EC here is a real database-correctness question (does the derived
 * "current state" actually read the latest row, does profile-scoping
 * actually isolate two profiles' state, does property-level keying actually
 * ignore which listing was passed) — exactly the class of behavior a mocked
 * query response can assert the SQL text for without ever proving the
 * underlying logic is right. Same gating/cleanup pattern as
 * lib/__tests__/candidates.integration.test.ts: `describe.runIf(dbAvailable)`,
 * cleanup scoped to exact IDs this file creates, never a broad scan (vitest's
 * file-level parallelism runs this against the same live Postgres as other
 * integration test files).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import type { Scope } from "@/lib/profiles-schema";
import { COLD_START_EXPLANATION } from "@/lib/scoring/explain";
import { GET, POST } from "../route";

// Far from candidates.integration.test.ts's and materialize.integration.test.ts's
// coordinates (~17km+) so this file's profiles/properties can never overlap
// with either's real geographic-scan production code when run concurrently.
const TEST_COORDS: [number, number] = [40.30, -3.85];

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[feedback route.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/profiles/1/candidates/1/feedback", {
    method: "POST",
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

function ctx(id: number, propertyId: number) {
  return { params: Promise.resolve({ id: String(id), propertyId: String(propertyId) }) };
}

describe.runIf(dbAvailable)("feedback event API — real Postgres", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];
  let createdProfileIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdProfileIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdProfileIds.length > 0 || createdPropertyIds.length > 0) {
        await pool.query(
          "DELETE FROM feedback_event WHERE profile_id = ANY($1::bigint[]) OR property_id = ANY($2::bigint[])",
          [createdProfileIds, createdPropertyIds],
        );
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      }
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
      }
    });
  });

  async function insertProperty(pool: Pool): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, 'Calle de prueba, feedback-int-test') RETURNING id`,
      [TEST_COORDS[0], TEST_COORDS[1]],
    );
    const id = Number(result.rows[0].id);
    createdPropertyIds.push(id);
    return id;
  }

  async function insertListing(pool: Pool, propertyId: number, source: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, $2, $3, 'active', 285000, NOW()) RETURNING id`,
      [propertyId, source, `feedback-int-test-${Math.random().toString(36).slice(2)}`],
    );
    return Number(result.rows[0].id);
  }

  async function makeProfile(): Promise<number> {
    const scope: Scope = {
      geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
      property_types: ["piso"],
      hard_exclusions: {},
    };
    const profile = await createProfile(`feedback-int-test-${Date.now()}-${Math.random()}`, scope, {});
    createdProfileIds.push(profile.id);
    return profile.id;
  }

  async function markMatched(pool: Pool, profileId: number, propertyId: number) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)
       ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true`,
      [profileId, propertyId],
    );
  }

  /**
   * Task 3.4 (#23) introduced MIN_TRAINING_EXAMPLES (4x the 8-feature model
   * = 32) — below it, retrain.ts now stays in cold-start mode even with
   * both classes present, which is new, correct behavior these
   * pre-existing tests didn't originally have to account for (they were
   * written when 1 accept + 1 reject was already enough to train). Pads a
   * profile's training set with generic, uncontested filler examples via
   * the real feedback route (not a direct DB write) so a real retrain
   * actually fires, without disturbing whichever specific property/label
   * pair the calling test cares about.
   */
  async function fillPastTrainingThreshold(pool: Pool, profileId: number, pairs = 18) {
    for (let i = 0; i < pairs; i++) {
      const acceptId = await insertProperty(pool);
      const rejectId = await insertProperty(pool);
      await markMatched(pool, profileId, acceptId);
      await markMatched(pool, profileId, rejectId);
      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, acceptId));
      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, rejectId));
    }
  }

  /**
   * Single-class variant for the "going one-sided" test below: that test's
   * whole premise is that the negative class disappears entirely when its
   * one real reject gets flipped to accept — balanced accept/reject filler
   * (the helper above) would leave permanent filler rejects behind and
   * silently defeat that premise. Pads with `count` accept-only filler
   * examples instead, so the real reject stays the *only* negative example
   * in the pool until the test itself removes it.
   */
  async function fillPastTrainingThresholdSingleClass(pool: Pool, profileId: number, count = 36) {
    for (let i = 0; i < count; i++) {
      const id = await insertProperty(pool);
      await markMatched(pool, profileId, id);
      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, id));
    }
  }

  it("note does not affect accept/reject state", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, propertyId));
      const res = await POST(makeRequest({ feedbackType: "note", note: "revisar planos" }), ctx(profileId, propertyId));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.currentState).toBe("reject");
    });
  });

  it("feedback is profile-scoped", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileA = await makeProfile();
      const profileB = await makeProfile();
      await markMatched(pool, profileA, propertyId);
      await markMatched(pool, profileB, propertyId);

      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileA, propertyId));

      const resA = await GET(makeRequest(), ctx(profileA, propertyId));
      const resB = await GET(makeRequest(), ctx(profileB, propertyId));
      expect((await resA.json()).currentState).toBe("reject");
      expect((await resB.json()).currentState).toBeNull();
    });
  });

  it("feedback keyed on property is listing-source-independent", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const idealistaListingId = await insertListing(pool, propertyId, "idealista");
      const fotocasaListingId = await insertListing(pool, propertyId, "fotocasa");
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      const rejectRes = await POST(
        makeRequest({ feedbackType: "reject", listingId: idealistaListingId }),
        ctx(profileId, propertyId),
      );
      expect(rejectRes.status).toBe(201);

      // "Viewed via Fotocasa" is just a different listingId on the same
      // property_id — the state read (not another feedback action) must
      // already reflect the earlier rejection made while looking at the
      // Idealista listing.
      const res = await GET(makeRequest(), ctx(profileId, propertyId));
      const body = await res.json();
      expect(body.currentState).toBe("reject");
      expect(body.history[0].listing_id).toBe(idealistaListingId);
      expect(body.history[0].listing_id).not.toBe(fotocasaListingId);
    });
  });

  it("history is append-only, current state is latest", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, propertyId));
      const finalRes = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));

      expect((await finalRes.json()).currentState).toBe("accept");

      const res = await GET(makeRequest(), ctx(profileId, propertyId));
      const body = await res.json();
      expect(body.currentState).toBe("accept");
      expect(body.history).toHaveLength(3);
      expect(body.history.map((e: { feedback_type: string }) => e.feedback_type)).toEqual([
        "accept",
        "reject",
        "accept",
      ]);
    });
  });

  it("re-recording the already-active state is a no-op, not a new event", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      const res = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      const body = await res.json();

      expect(body.noop).toBe(true);
      expect(body.history).toHaveLength(1);
    });
  });

  it("two near-simultaneous requests for the same new state record exactly one event (no race)", async () => {
    // Regression test for PR #89's review: a plain check-then-insert let a
    // real double-click insert two 'reject' rows ~1.7ms apart. The fix
    // (recordStateFeedbackIfChanged's advisory-lock-guarded transaction)
    // should serialize these two concurrent POSTs so only one actually
    // records a new event; the other observes the now-current state and
    // no-ops.
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      const [resA, resB] = await Promise.all([
        POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, propertyId)),
        POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, propertyId)),
      ]);
      const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

      // Exactly one of the two requests actually inserted; the other no-op'd.
      const noopFlags = [bodyA.noop === true, bodyB.noop === true];
      expect(noopFlags).toContain(true);
      expect(noopFlags).toContain(false);

      const finalHistory = await pool.query(
        "SELECT feedback_type FROM feedback_event WHERE profile_id = $1 AND property_id = $2",
        [profileId, propertyId],
      );
      expect(finalHistory.rows).toHaveLength(1);
      expect(finalHistory.rows[0].feedback_type).toBe("reject");
    });
  });

  it("returns 404 when the property is not a matched candidate for this profile", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      // deliberately not marked matched

      const res = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, propertyId));
      expect(res.status).toBe(404);
    });
  });

  it("rejects an unrecognized feedback_type with 400", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await insertProperty(pool);
      const profileId = await makeProfile();
      await markMatched(pool, profileId, propertyId);

      const res = await POST(makeRequest({ feedbackType: "love-it" }), ctx(profileId, propertyId));
      expect(res.status).toBe(400);
    });
  });

  it("feedback submission triggers rescoring (EC-3, issue #21)", async () => {
    await withRealDb(async (pool) => {
      const cheapPropertyId = await insertProperty(pool);
      const priceyPropertyId = await insertProperty(pool);

      // Scope's price band gives price_per_m2_relative a real signal to
      // learn from: 200k is at the band midpoint (relative ~1.0), 400k is
      // double it (relative ~2.0) — clearly separable, so training actually
      // succeeds with just these two labeled examples.
      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        price_min: 150000,
        price_max: 250000,
        hard_exclusions: {},
      };
      const profile = await createProfile(`feedback-int-test-scoring-${Date.now()}`, scope, {});
      createdProfileIds.push(profile.id);
      const profileId = profile.id;

      await insertListing(pool, cheapPropertyId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 200000 WHERE property_id = $1", [cheapPropertyId]);
      await insertListing(pool, priceyPropertyId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 400000 WHERE property_id = $1", [priceyPropertyId]);

      await markMatched(pool, profileId, cheapPropertyId);
      await markMatched(pool, profileId, priceyPropertyId);

      // Before any feedback: scores are null (never scored).
      const before = await pool.query<{ score: string | null }>(
        "SELECT score FROM profile_listing_state WHERE profile_id = $1 AND property_id = ANY($2::bigint[])",
        [profileId, [cheapPropertyId, priceyPropertyId]],
      );
      expect(before.rows.every((r) => r.score === null)).toBe(true);

      // Only one class so far (accept) — retrain should decline to *train*
      // (needs both classes), but per task 3.4 (#23) EC-1 it must still
      // write a real, deterministic cold-start score (price-per-m²
      // ascending) rather than leaving score at NULL — a fresh profile with
      // sparse feedback must show a sensibly-ordered list, not a blank one.
      // rank_explanation stays the honest "not personalized yet" message
      // (issue #22, task 3.3) even though score itself is now non-null.
      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, cheapPropertyId));
      const afterFirstOnly = await pool.query<{ score: string | null; rank_explanation: string | null }>(
        "SELECT score, rank_explanation FROM profile_listing_state WHERE profile_id = $1 AND property_id = ANY($2::bigint[])",
        [profileId, [cheapPropertyId, priceyPropertyId]],
      );
      expect(afterFirstOnly.rows.every((r) => r.score !== null)).toBe(true);
      expect(afterFirstOnly.rows.every((r) => r.rank_explanation === COLD_START_EXPLANATION)).toBe(true);

      // Task 3.4 (#23): both classes existing isn't enough on its own
      // anymore — MIN_TRAINING_EXAMPLES (32, at the current 8-feature
      // model) also has to be cleared. Pad past it with neutral filler
      // (no listing/price, so it contributes zero signal to
      // price_per_m2_relative's weight specifically — see the helper's own
      // comment) before the real second class arrives, so this test keeps
      // exercising "does a real retrain fire and learn the right
      // direction", not "does the threshold gate correctly" (that's
      // pipeline.test.ts's job).
      await fillPastTrainingThreshold(pool, profileId);

      // Now both classes exist and the threshold is cleared — this POST
      // should trigger a real retrain + rescore of the whole matched pool
      // before the response returns.
      const res = await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, priceyPropertyId));
      expect(res.status).toBe(201);

      const after = await pool.query<{ property_id: number; score: string | null; rank_explanation: string | null }>(
        "SELECT property_id, score, rank_explanation FROM profile_listing_state WHERE profile_id = $1 AND property_id = ANY($2::bigint[])",
        [profileId, [cheapPropertyId, priceyPropertyId]],
      );
      expect(after.rows.every((r) => r.score !== null)).toBe(true);
      // A real, model-grounded explanation now replaces the cold-start
      // message (task 3.3, #22) — and each candidate's own explanation
      // differs, since it's computed per-candidate from that candidate's own
      // feature vector, not one shared template string.
      expect(after.rows.every((r) => r.rank_explanation !== null)).toBe(true);
      expect(after.rows.every((r) => r.rank_explanation !== COLD_START_EXPLANATION)).toBe(true);
      const explanations = new Set(after.rows.map((r) => r.rank_explanation));
      expect(explanations.size).toBe(2);

      const model = await pool.query<{ training_example_count: number }>(
        "SELECT training_example_count FROM profile_scoring_model WHERE profile_id = $1",
        [profileId],
      );
      expect(model.rows).toHaveLength(1);
      // 1 (cheap, accept) + 36 (18 filler pairs) + 1 (pricey, reject) — see
      // fillPastTrainingThreshold; exact count isn't the point of this test,
      // just that a real training run happened at all.
      expect(model.rows[0].training_example_count).toBe(38);

      // The accepted (cheap) property should score higher than the
      // rejected (pricey) one — the model actually learned the direction,
      // not just "some non-null number appeared".
      const cheapScore = Number(after.rows.find((r) => Number(r.property_id) === cheapPropertyId)!.score);
      const priceyScore = Number(after.rows.find((r) => Number(r.property_id) === priceyPropertyId)!.score);
      expect(cheapScore).toBeGreaterThan(priceyScore);
    });
  });

  it("#422: 'star' is retired — posting it is a 400 and never touches the trained model", async () => {
    await withRealDb(async (pool) => {
      const acceptedId = await insertProperty(pool);
      const rejectedId = await insertProperty(pool);

      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        price_min: 150000,
        price_max: 250000,
        hard_exclusions: {},
      };
      const profile = await createProfile(`feedback-int-test-star-${Date.now()}`, scope, {});
      createdProfileIds.push(profile.id);
      const profileId = profile.id;

      await insertListing(pool, acceptedId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 200000 WHERE property_id = $1", [acceptedId]);
      await insertListing(pool, rejectedId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 400000 WHERE property_id = $1", [rejectedId]);

      await markMatched(pool, profileId, acceptedId);
      await markMatched(pool, profileId, rejectedId);

      // Task 3.4 (#23): clear MIN_TRAINING_EXAMPLES first — see the EC-3
      // test above for why this is now necessary.
      await fillPastTrainingThreshold(pool, profileId);

      // accept + reject: both classes present, threshold cleared, training
      // succeeds (mirrors the EC-3 test above). accept IS the follow/track
      // action now — there is no separate star.
      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, acceptedId));
      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, rejectedId));

      const afterAccept = await pool.query<{ training_example_count: number }>(
        "SELECT training_example_count FROM profile_scoring_model WHERE profile_id = $1",
        [profileId],
      );
      expect(afterAccept.rows[0].training_example_count).toBe(38);

      // #422: `star` is no longer a writable feedback type — the route rejects
      // it (400), no event is inserted, and the trained model is untouched.
      const res = await POST(makeRequest({ feedbackType: "star" }), ctx(profileId, acceptedId));
      expect(res.status).toBe(400);

      const starRows = await pool.query(
        "SELECT 1 FROM feedback_event WHERE profile_id = $1 AND feedback_type = 'star'",
        [profileId],
      );
      expect(starRows.rows).toHaveLength(0);

      // The accepted property stays a positive example, so it still outscores
      // the rejected one — the 400 changed nothing.
      const scores = await pool.query<{ property_id: number; score: string | null }>(
        "SELECT property_id, score FROM profile_listing_state WHERE profile_id = $1 AND property_id = ANY($2::bigint[])",
        [profileId, [acceptedId, rejectedId]],
      );
      expect(scores.rows.every((r) => r.score !== null)).toBe(true);
      const acceptedScore = Number(scores.rows.find((r) => Number(r.property_id) === acceptedId)!.score);
      const rejectedScore = Number(scores.rows.find((r) => Number(r.property_id) === rejectedId)!.score);
      expect(acceptedScore).toBeGreaterThan(rejectedScore);
    });
  });

  it("normalizes against the whole matched pool, not just the labeled subset (Opus review of PR #91, item 1)", async () => {
    await withRealDb(async (pool) => {
      const cheapPropertyId = await insertProperty(pool);
      const priceyPropertyId = await insertProperty(pool);
      // Unlabeled candidates spanning a much wider price range than the two
      // labeled examples (200k/400k). If normalization were still computed
      // from only the labeled pair (the bug this test guards against),
      // these far-outside-that-range candidates would be z-scored against a
      // mean/std that has no idea they exist, pushing them into a saturated
      // region of the sigmoid — every unlabeled candidate would collapse to
      // a score indistinguishable from 0 or 1 regardless of its real price.
      const unlabeledIds = await Promise.all([insertProperty(pool), insertProperty(pool), insertProperty(pool)]);
      const unlabeledPrices = [50000, 800000, 1500000];

      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        price_min: 150000,
        price_max: 250000,
        hard_exclusions: {},
      };
      const profile = await createProfile(`feedback-int-test-norm-${Date.now()}`, scope, {});
      createdProfileIds.push(profile.id);
      const profileId = profile.id;

      await insertListing(pool, cheapPropertyId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 200000 WHERE property_id = $1", [cheapPropertyId]);
      await insertListing(pool, priceyPropertyId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 400000 WHERE property_id = $1", [priceyPropertyId]);
      await markMatched(pool, profileId, cheapPropertyId);
      await markMatched(pool, profileId, priceyPropertyId);

      for (const [i, id] of unlabeledIds.entries()) {
        await insertListing(pool, id, "fotocasa");
        await pool.query("UPDATE listing SET current_price = $2 WHERE property_id = $1", [id, unlabeledPrices[i]]);
        await markMatched(pool, profileId, id);
      }

      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, cheapPropertyId));
      const res = await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, priceyPropertyId));
      expect(res.status).toBe(201);

      const scored = await pool.query<{ property_id: number; score: string }>(
        "SELECT property_id, score FROM profile_listing_state WHERE profile_id = $1 AND property_id = ANY($2::bigint[]) AND score IS NOT NULL",
        [profileId, unlabeledIds],
      );
      expect(scored.rows).toHaveLength(3);

      // Not a rigid numeric assertion on the exact score (that's the
      // hand-rolled model's business, tested in model.test.ts) — the
      // property-under-test here is that pool-wide normalization actually
      // ran: every unlabeled candidate must land at a real, distinct,
      // finite probability, not collapsed to the saturated extremes a
      // labeled-subset-only normalization would produce.
      for (const row of scored.rows) {
        const score = Number(row.score);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThan(0.001);
        expect(score).toBeLessThan(0.999);
      }
      const distinctScores = new Set(scored.rows.map((r) => r.score));
      expect(distinctScores.size).toBeGreaterThan(1);
    });
  });

  it("going one-sided after a successful training run does not clobber the prior real score/explanation (Opus review of PR #92, item 3)", async () => {
    await withRealDb(async (pool) => {
      const acceptedId = await insertProperty(pool);
      const rejectedThenAcceptedId = await insertProperty(pool);

      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        price_min: 150000,
        price_max: 250000,
        hard_exclusions: {},
      };
      const profile = await createProfile(`feedback-int-test-noclobber-${Date.now()}`, scope, {});
      createdProfileIds.push(profile.id);
      const profileId = profile.id;

      await insertListing(pool, acceptedId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 200000 WHERE property_id = $1", [acceptedId]);
      await insertListing(pool, rejectedThenAcceptedId, "fotocasa");
      await pool.query("UPDATE listing SET current_price = 240000 WHERE property_id = $1", [rejectedThenAcceptedId]);
      await markMatched(pool, profileId, acceptedId);
      await markMatched(pool, profileId, rejectedThenAcceptedId);

      // Task 3.4 (#23): clear MIN_TRAINING_EXAMPLES first — see the EC-3
      // test above for why this is now necessary. Single-class (accept-only)
      // filler, not the balanced pair helper: this test's whole point is
      // that the negative class disappears entirely later on, which balanced
      // filler would permanently prevent (see that helper's own comment).
      await fillPastTrainingThresholdSingleClass(pool, profileId);

      // Both classes present, threshold cleared: training succeeds, real
      // score + explanation land. rejectedThenAcceptedId is the *only*
      // negative example in the whole pool at this point.
      await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, acceptedId));
      await POST(makeRequest({ feedbackType: "reject" }), ctx(profileId, rejectedThenAcceptedId));

      const trained = await pool.query<{ score: string; rank_explanation: string }>(
        "SELECT score, rank_explanation FROM profile_listing_state WHERE profile_id = $1 AND property_id = $2",
        [profileId, acceptedId],
      );
      expect(trained.rows[0].score).not.toBeNull();
      expect(trained.rows[0].rank_explanation).not.toBe(COLD_START_EXPLANATION);
      const priorScore = trained.rows[0].score;
      const priorExplanation = trained.rows[0].rank_explanation;

      // Go one-sided: accept the previously-rejected property too, leaving
      // only positive examples. This hits "needs_both_classes" and writes
      // the cold-start message — but only to rows that are still unscored,
      // per the score IS NULL scoping fix. `acceptedId`'s prior real
      // score/explanation from the successful run above must survive
      // untouched, not get blindly overwritten for the whole matched pool.
      const res = await POST(makeRequest({ feedbackType: "accept" }), ctx(profileId, rejectedThenAcceptedId));
      expect(res.status).toBe(201);

      const afterOneSided = await pool.query<{ property_id: number; score: string; rank_explanation: string }>(
        "SELECT property_id, score, rank_explanation FROM profile_listing_state WHERE profile_id = $1 AND property_id = ANY($2::bigint[])",
        [profileId, [acceptedId, rejectedThenAcceptedId]],
      );
      const acceptedRow = afterOneSided.rows.find((r) => Number(r.property_id) === acceptedId)!;
      expect(acceptedRow.score).toBe(priorScore);
      expect(acceptedRow.rank_explanation).toBe(priorExplanation);

      // The newly-flipped property was already scored in the prior training
      // run too (it was part of the same matched pool), so it also keeps its
      // real score/explanation rather than being reset to the cold-start
      // message — the fix is scoped to score IS NULL, and neither row is null.
      const flippedRow = afterOneSided.rows.find((r) => Number(r.property_id) === rejectedThenAcceptedId)!;
      expect(flippedRow.rank_explanation).not.toBe(COLD_START_EXPLANATION);
    });
  });
});
