import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { createProfile } from "@/lib/db/profiles";
import { extractRaw, type ScoringInputRow } from "../features";
import { computeNormalization, normalizeVector } from "../model";
import {
  applyPreferenceSignal,
  buildPreferenceModel,
  buildPreferenceModelFromStates,
  fetchLatestFeedbackStates,
  labelForFeedback,
  loadProfilePreferenceModel,
  MIN_FEEDBACK_TO_LEARN,
  preferenceClause,
  preferenceSignal,
  PREFERENCE_SIGNAL_WEIGHT,
  type LabeledVector,
  type LatestFeedbackState,
} from "../preference";
import type { Scope } from "@/lib/profiles-schema";

const SCOPE: Scope = {
  geography: { type: "radius", center: [40.4168, -3.7038], radius_km: 5 },
  property_types: ["piso"],
  price_min: 150000,
  price_max: 250000,
  hard_exclusions: {},
};

function row(overrides: Partial<ScoringInputRow> & { property_id: number }): ScoringInputRow {
  return {
    m2_built: null,
    rooms: null,
    floor: null,
    has_elevator: null,
    year_built: null,
    min_price: null,
    first_seen_at: null,
    days_on_market: null,
    price_drop_pct: null,
    ...overrides,
  };
}

// A pool with a CLEAR accept/reject split the structured feature space can
// see: "good" candidates are large/modern/with-elevator, "bad" ones are
// small/old/no-elevator. The two probe candidates sit squarely in each camp.
const GOOD_ROWS: ScoringInputRow[] = [
  row({ property_id: 1, m2_built: 100, rooms: 3, year_built: 2010, has_elevator: true, min_price: 220000 }),
  row({ property_id: 2, m2_built: 110, rooms: 4, year_built: 2012, has_elevator: true, min_price: 240000 }),
  row({ property_id: 3, m2_built: 105, rooms: 3, year_built: 2014, has_elevator: true, min_price: 230000 }),
  row({ property_id: 4, m2_built: 120, rooms: 4, year_built: 2008, has_elevator: true, min_price: 250000 }),
  row({ property_id: 5, m2_built: 115, rooms: 4, year_built: 2015, has_elevator: true, min_price: 245000 }),
];
const BAD_ROWS: ScoringInputRow[] = [
  row({ property_id: 6, m2_built: 45, rooms: 1, year_built: 1965, has_elevator: false, min_price: 160000 }),
  row({ property_id: 7, m2_built: 50, rooms: 2, year_built: 1970, has_elevator: false, min_price: 165000 }),
  row({ property_id: 8, m2_built: 40, rooms: 1, year_built: 1960, has_elevator: false, min_price: 155000 }),
  row({ property_id: 9, m2_built: 55, rooms: 2, year_built: 1972, has_elevator: false, min_price: 170000 }),
  row({ property_id: 10, m2_built: 48, rooms: 1, year_built: 1968, has_elevator: false, min_price: 158000 }),
];
const PROBE_GOOD = row({ property_id: 100, m2_built: 108, rooms: 4, year_built: 2013, has_elevator: true, min_price: 235000 });
const PROBE_BAD = row({ property_id: 101, m2_built: 46, rooms: 1, year_built: 1966, has_elevator: false, min_price: 159000 });

function normalizedPool(rows: ScoringInputRow[]) {
  const raws = rows.map((r) => extractRaw(r, SCOPE));
  const normalization = computeNormalization(raws);
  return { normalization, vec: (r: ScoringInputRow) => normalizeVector(extractRaw(r, SCOPE), normalization) };
}

describe("preference model — graceful activation threshold (task 7.2, #40)", () => {
  it("returns null below MIN_FEEDBACK_TO_LEARN — the mechanism is a hard no-op", () => {
    const labeled: LabeledVector[] = [];
    for (let i = 0; i < MIN_FEEDBACK_TO_LEARN - 1; i++) {
      labeled.push({ vector: [i, 0, 0], label: i % 2 === 0 ? 1 : 0 });
    }
    expect(labeled.length).toBeLessThan(MIN_FEEDBACK_TO_LEARN);
    expect(buildPreferenceModel(labeled)).toBeNull();
  });

  it("EC (today's 6-event state): 6 labeled examples build NO model and change NO score", () => {
    // The whole platform has ~6 feedback events today. Prove that at 6
    // examples the signal is exactly zero for every candidate — scores are
    // bit-for-bit identical to the pre-#40 behavior.
    expect(6).toBeLessThan(MIN_FEEDBACK_TO_LEARN);
    const { vec } = normalizedPool([...GOOD_ROWS, ...BAD_ROWS, PROBE_GOOD, PROBE_BAD]);
    const sixEvents: LabeledVector[] = [
      { vector: vec(GOOD_ROWS[0]), label: 1 },
      { vector: vec(GOOD_ROWS[1]), label: 1 },
      { vector: vec(GOOD_ROWS[2]), label: 1 },
      { vector: vec(BAD_ROWS[0]), label: 0 },
      { vector: vec(BAD_ROWS[1]), label: 0 },
      { vector: vec(BAD_ROWS[2]), label: 0 },
    ];
    const model = buildPreferenceModel(sixEvents);
    expect(model).toBeNull();

    for (const probe of [PROBE_GOOD, PROBE_BAD, ...GOOD_ROWS, ...BAD_ROWS]) {
      const signal = preferenceSignal(model, vec(probe));
      expect(signal).toBe(0);
      for (const base of [0.1, 0.5, 0.9]) {
        expect(applyPreferenceSignal(base, signal)).toBe(base);
      }
    }
  });

  it("returns null when feedback is one-sided even above the count threshold", () => {
    const allPositives: LabeledVector[] = Array.from({ length: MIN_FEEDBACK_TO_LEARN + 2 }, () => ({
      vector: [1, 2, 3],
      label: 1 as const,
    }));
    expect(buildPreferenceModel(allPositives)).toBeNull();
  });

  it("builds a model once both classes and the threshold are met", () => {
    const { vec } = normalizedPool([...GOOD_ROWS, ...BAD_ROWS]);
    const labeled: LabeledVector[] = [
      ...GOOD_ROWS.map((r) => ({ vector: vec(r), label: 1 as const })),
      ...BAD_ROWS.map((r) => ({ vector: vec(r), label: 0 as const })),
    ];
    const model = buildPreferenceModel(labeled);
    expect(model).not.toBeNull();
    expect(model!.positiveCount).toBe(5);
    expect(model!.negativeCount).toBe(5);
  });
});

describe("preference signal — learns per profile from accept/reject (task 7.2, #40)", () => {
  it("ranks a similar-to-accepted candidate ABOVE a similar-to-rejected one", () => {
    const { normalization } = normalizedPool([...GOOD_ROWS, ...BAD_ROWS, PROBE_GOOD, PROBE_BAD]);
    const vec = (r: ScoringInputRow) => normalizeVector(extractRaw(r, SCOPE), normalization);

    const states: LatestFeedbackState[] = [
      ...GOOD_ROWS.map((r) => ({ property_id: r.property_id, feedback_type: "accept" as const })),
      ...BAD_ROWS.map((r) => ({ property_id: r.property_id, feedback_type: "reject" as const })),
    ];
    const rawByProperty = new Map(
      [...GOOD_ROWS, ...BAD_ROWS, PROBE_GOOD, PROBE_BAD].map((r) => [r.property_id, extractRaw(r, SCOPE)]),
    );
    const model = buildPreferenceModelFromStates(states, rawByProperty, normalization);
    expect(model).not.toBeNull();

    const signalGood = preferenceSignal(model, vec(PROBE_GOOD));
    const signalBad = preferenceSignal(model, vec(PROBE_BAD));

    // The self-learning core: the candidate resembling past ACCEPTS leans
    // positive, the one resembling past REJECTS leans negative.
    expect(signalGood).toBeGreaterThan(0);
    expect(signalBad).toBeLessThan(0);
    expect(signalGood).toBeGreaterThan(signalBad);

    // And with the SAME base score, the preference nudge orders them correctly.
    const base = 0.5;
    expect(applyPreferenceSignal(base, signalGood)).toBeGreaterThan(applyPreferenceSignal(base, signalBad));
  });

  it("#422: accept labels the liked class, reject the negative (star is retired)", () => {
    // labelForFeedback now only accepts accept/reject — accept → 1, reject → 0.
    expect(labelForFeedback("accept")).toBe(1);
    expect(labelForFeedback("reject")).toBe(0);

    const { normalization } = normalizedPool([...GOOD_ROWS, ...BAD_ROWS]);
    const states: LatestFeedbackState[] = [
      ...GOOD_ROWS.map((r) => ({ property_id: r.property_id, feedback_type: "accept" as const })),
      ...BAD_ROWS.map((r) => ({ property_id: r.property_id, feedback_type: "reject" as const })),
    ];
    const rawByProperty = new Map([...GOOD_ROWS, ...BAD_ROWS].map((r) => [r.property_id, extractRaw(r, SCOPE)]));
    const model = buildPreferenceModelFromStates(states, rawByProperty, normalization);
    expect(model!.positiveCount).toBe(5);
    expect(model!.negativeCount).toBe(5);
  });

  it("gives a no-data candidate (all features imputed to the pool mean) exactly zero influence", () => {
    const { normalization } = normalizedPool([...GOOD_ROWS, ...BAD_ROWS]);
    const states: LatestFeedbackState[] = [
      ...GOOD_ROWS.map((r) => ({ property_id: r.property_id, feedback_type: "accept" as const })),
      ...BAD_ROWS.map((r) => ({ property_id: r.property_id, feedback_type: "reject" as const })),
    ];
    const rawByProperty = new Map([...GOOD_ROWS, ...BAD_ROWS].map((r) => [r.property_id, extractRaw(r, SCOPE)]));
    const model = buildPreferenceModelFromStates(states, rawByProperty, normalization);

    // A candidate with no known features → z-scores to the zero vector →
    // cosine 0 against both centroids → signal 0 (never a fabricated lean).
    const emptyRow = row({ property_id: 999 });
    const signal = preferenceSignal(model, normalizeVector(extractRaw(emptyRow, SCOPE), normalization));
    expect(signal).toBe(0);
  });

  it("caps its influence to ±PREFERENCE_SIGNAL_WEIGHT on the base score", () => {
    expect(applyPreferenceSignal(0.5, 1)).toBeCloseTo(0.5 + PREFERENCE_SIGNAL_WEIGHT, 10);
    expect(applyPreferenceSignal(0.5, -1)).toBeCloseTo(0.5 - PREFERENCE_SIGNAL_WEIGHT, 10);
    // Clamped into the valid (0,1) score range.
    expect(applyPreferenceSignal(0.95, 1)).toBeLessThanOrEqual(1);
    expect(applyPreferenceSignal(0.02, -1)).toBeGreaterThanOrEqual(0);
  });
});

describe("preferenceClause — honest, non-specific phrasing (task 7.2 EC-4, #40)", () => {
  it("omits the clause for a negligible lean", () => {
    expect(preferenceClause(0)).toBeNull();
    expect(preferenceClause(0.01)).toBeNull();
  });
  it("phrases a positive lean without fabricating specifics", () => {
    expect(preferenceClause(0.4)).toContain("valorado positivamente");
  });
  it("phrases a negative lean honestly", () => {
    expect(preferenceClause(-0.4)).toContain("descartado");
  });
});

// ---------------------------------------------------------------------------
// Real-Postgres integration for the feedback read (task 7.2, #40). Gated on a
// reachable DB, same pattern as pipeline.test.ts's EC-2 transition test.
// ---------------------------------------------------------------------------
const createdPropertyIds: number[] = [];
const createdProfileIds: number[] = [];
const TEST_COORDS: [number, number] = [40.31, -3.88]; // away from other tests' coords

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
    console.warn("[preference.test] no reachable Postgres — skipping the feedback-read integration test.");
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("loadProfilePreferenceModel reads real feedback (task 7.2, #40)", () => {
  afterAll(async () => {
    await withRealDb(async (pool) => {
      await pool.query("DELETE FROM feedback_event WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM profile_scoring_model WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
      await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
    });
  });

  it("stays null below the threshold, activates once enough of THIS profile's feedback exists", async () => {
    await withRealDb(async (pool) => {
      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        price_min: 150000,
        price_max: 250000,
        hard_exclusions: {},
      };
      const profile = await createProfile(`pref-test-${Date.now()}-${Math.random()}`, scope, {});
      createdProfileIds.push(profile.id);

      async function addLabeled(m2: number, rooms: number, year: number, price: number, fb: "accept" | "reject") {
        const propRes = await pool.query<{ id: string }>(
          `INSERT INTO property (lat, lon, property_type, m2_built, rooms, year_built)
           VALUES ($1, $2, 'piso', $3, $4, $5) RETURNING id`,
          [TEST_COORDS[0], TEST_COORDS[1], m2, rooms, year],
        );
        const propertyId = Number(propRes.rows[0].id);
        createdPropertyIds.push(propertyId);
        await pool.query(
          `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
           VALUES ($1, 'fotocasa', $2, 'active', $3, NOW())`,
          [propertyId, `pref-${Math.random().toString(36).slice(2)}`, price],
        );
        await pool.query(
          `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
          [profile.id, propertyId],
        );
        await pool.query(
          `INSERT INTO feedback_event (profile_id, property_id, feedback_type) VALUES ($1, $2, $3)`,
          [profile.id, propertyId, fb],
        );
        return propertyId;
      }

      // 6 events (< MIN_FEEDBACK_TO_LEARN): still a no-op — mirrors today's state.
      for (let i = 0; i < 3; i++) await addLabeled(100 + i, 3, 2010, 230000, "accept");
      for (let i = 0; i < 3; i++) await addLabeled(45 + i, 1, 1965, 160000, "reject");
      expect(await loadProfilePreferenceModel(profile.id)).toBeNull();

      // Cross the threshold with both classes → the model activates.
      await addLabeled(112, 4, 2013, 240000, "accept");
      await addLabeled(50, 2, 1970, 165000, "reject");
      const model = await loadProfilePreferenceModel(profile.id);
      expect(model).not.toBeNull();
      expect(model!.positiveCount + model!.negativeCount).toBeGreaterThanOrEqual(MIN_FEEDBACK_TO_LEARN);
      expect(model!.positiveCount).toBeGreaterThan(0);
      expect(model!.negativeCount).toBeGreaterThan(0);
    });
  }, 20000);

  it("fetchLatestFeedbackStates is latest-wins per property", async () => {
    await withRealDb(async (pool) => {
      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      };
      const profile = await createProfile(`pref-latest-${Date.now()}-${Math.random()}`, scope, {});
      createdProfileIds.push(profile.id);

      const propRes = await pool.query<{ id: string }>(
        `INSERT INTO property (lat, lon, property_type, m2_built) VALUES ($1, $2, 'piso', 70) RETURNING id`,
        [TEST_COORDS[0], TEST_COORDS[1]],
      );
      const propertyId = Number(propRes.rows[0].id);
      createdPropertyIds.push(propertyId);

      // accept first, then reject later → reject is the current verdict.
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at)
         VALUES ($1, $2, 'accept', NOW() - INTERVAL '1 hour')`,
        [profile.id, propertyId],
      );
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'reject', NOW())`,
        [profile.id, propertyId],
      );

      const states = await fetchLatestFeedbackStates(profile.id);
      const forProp = states.filter((s) => s.property_id === propertyId);
      expect(forProp).toHaveLength(1);
      expect(forProp[0].feedback_type).toBe("reject");
    });
  }, 20000);

  it("fetchLatestFeedbackStates drops a retracted verdict (trailing 'clear') so it never trains the preference model (#379)", async () => {
    await withRealDb(async (pool) => {
      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      };
      const profile = await createProfile(`pref-clear-${Date.now()}-${Math.random()}`, scope, {});
      createdProfileIds.push(profile.id);

      const propRes = await pool.query<{ id: string }>(
        `INSERT INTO property (lat, lon, property_type, m2_built) VALUES ($1, $2, 'piso', 70) RETURNING id`,
        [TEST_COORDS[0], TEST_COORDS[1]],
      );
      const propertyId = Number(propRes.rows[0].id);
      createdPropertyIds.push(propertyId);

      // reject, then un-reject via a later 'clear' → the property is currently
      // neutral and must be absent from the training set entirely (neither
      // positive nor negative), not surface as its retracted 'reject'.
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at)
         VALUES ($1, $2, 'reject', NOW() - INTERVAL '1 hour')`,
        [profile.id, propertyId],
      );
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'clear', NOW())`,
        [profile.id, propertyId],
      );

      const states = await fetchLatestFeedbackStates(profile.id);
      expect(states.filter((s) => s.property_id === propertyId)).toHaveLength(0);
    });
  }, 20000);

  it("#422: a trailing legacy 'star' is dropped from training (retired — collapsed like 'clear')", async () => {
    await withRealDb(async (pool) => {
      const scope: Scope = {
        geography: { type: "radius", center: TEST_COORDS, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      };
      const profile = await createProfile(`pref-star-${Date.now()}-${Math.random()}`, scope, {});
      createdProfileIds.push(profile.id);

      const propRes = await pool.query<{ id: string }>(
        `INSERT INTO property (lat, lon, property_type, m2_built) VALUES ($1, $2, 'piso', 70) RETURNING id`,
        [TEST_COORDS[0], TEST_COORDS[1]],
      );
      const propertyId = Number(propRes.rows[0].id);
      createdPropertyIds.push(propertyId);

      // accept, then a later legacy 'star' (pre-#422 data). Star is retired, so
      // the latest-wins read must WIN on the star row (not fall back to the
      // accept) and then drop it — leaving the property out of the training set.
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at)
         VALUES ($1, $2, 'accept', NOW() - INTERVAL '1 hour')`,
        [profile.id, propertyId],
      );
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'star', NOW())`,
        [profile.id, propertyId],
      );

      const states = await fetchLatestFeedbackStates(profile.id);
      expect(states.filter((s) => s.property_id === propertyId)).toHaveLength(0);
    });
  }, 20000);
});
