/**
 * Real-Postgres integration test for the Perfiles overview aggregate query
 * (issue #192). A mocked query cannot judge row selection, ordering, or
 * aggregate correctness — this file proves the LATERAL joins actually
 * compute what the module docstring claims against real property/listing/
 * feedback_event/profile_scoring_model/ai_assessment rows.
 *
 * Also captures `EXPLAIN (ANALYZE, BUFFERS)` against a seeded, hundreds-of-
 * matched-candidates dataset (see the "EXPLAIN ANALYZE" describe block) —
 * the PR body quotes this file's actual measured numbers, not estimates.
 *
 * Coordinates: Valencia (~39.47, -0.38) — far from every other integration
 * test file's coordinate cluster (Madrid ~40.2-40.57/-3.7 to -3.95,
 * Barcelona ~41.39/2.17), so this file's broad geographic aggregates can
 * never pick up another file's concurrently-running test properties.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile } from "@/lib/db/profiles";
import { listProfileOverviews, OVERVIEW_QUERY_SQL, WARN_CAVEAT_CODES } from "../profile-overview";
import { MIN_TRAINING_EXAMPLES } from "@/lib/scoring/pipeline";
import type { Scope, ThesisParams } from "@/lib/profiles-schema";

const VALENCIA: [number, number] = [39.4699, -0.3763];

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
      "[profile-overview.integration.test] no reachable Postgres — skipping. Set POSTGRES_DSN to run.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    geography: { type: "radius", center: VALENCIA, radius_km: 5 },
    property_types: ["piso"],
    hard_exclusions: {},
    ...overrides,
  };
}

interface SeedPropertyOpts {
  lat?: number;
  lon?: number;
  m2Built?: number | null;
  createdAt?: string;
  price?: number | null;
}

async function seedProperty(pool: Pool, opts: SeedPropertyOpts = {}): Promise<number> {
  const lat = opts.lat ?? VALENCIA[0];
  const lon = opts.lon ?? VALENCIA[1];
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const propRes = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, created_at)
     VALUES ($1, $2, 'piso', $3, $4) RETURNING id`,
    [lat, lon, opts.m2Built === undefined ? 70 : opts.m2Built, createdAt],
  );
  const propertyId = propRes.rows[0].id;
  if (opts.price !== null) {
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
       VALUES ($1, 'test', $2, 'active', $3, NOW())`,
      [propertyId, `ext-${propertyId}-${Math.random()}`, opts.price ?? 200000],
    );
  }
  return propertyId;
}

async function matchProperty(pool: Pool, profileId: number, propertyId: number, opts: { score?: number | null; scoreKind?: "cold_start" | "trained" | null } = {}) {
  await pool.query(
    `INSERT INTO profile_listing_state (profile_id, property_id, matched, score, score_kind)
     VALUES ($1, $2, true, $3, $4)`,
    [profileId, propertyId, opts.score ?? null, opts.scoreKind ?? null],
  );
}

describe.runIf(dbAvailable)("listProfileOverviews — real Postgres (issue #192)", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdProfileIds: number[] = [];
  let createdPropertyIds: number[] = [];

  beforeEach(() => {
    createdProfileIds = [];
    createdPropertyIds = [];
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [createdPropertyIds]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM feedback_event WHERE profile_id = ANY($1::bigint[])", [createdProfileIds]);
        await pool.query("DELETE FROM profile_scoring_model WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
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

  it("a profile with no matched candidates: matched_count=0, thumbnails=[], price/model/yield/flags all absent (not zero)", async () => {
    const profile = await createProfile("Vacío", scope(), {});
    createdProfileIds = [profile.id];

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.matched_count).toBe(0);
      expect(entry.metrics.new_count).toBe(0);
      expect(entry.metrics.thumbnails).toEqual([]);
      expect(entry.metrics.min_price).toBeNull();
      expect(entry.metrics.median_price).toBeNull();
      expect(entry.metrics.max_price).toBeNull();
      expect(entry.metrics.gross_yield_median_pct).toBeNull();
      expect(entry.metrics.flagged_count).toBe(0);
      expect(entry.metrics.training_example_count).toBeNull();
      expect(entry.metrics.model_trained).toBe(false);
    }
  });

  it("a profile with a malformed scope appears as {ok: false, ...}, not omitted (issue #113 dependency)", async () => {
    let brokenId!: number;
    await withRealDb(async (pool) => {
      const res = await pool.query<{ id: number }>(
        `INSERT INTO search_profile (name, scope, thesis_params) VALUES ('Roto', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      );
      brokenId = res.rows[0].id;
    });
    createdProfileIds = [brokenId];

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => (e.ok ? e.profile.id : e.id) === brokenId);
    expect(entry).toBeDefined();
    expect(entry?.ok).toBe(false);
  });

  it("gross_yield_median_pct is present when thesis_params.rent_assumption is set, and null (never 0) when it isn't", async () => {
    const thesisWithRent: ThesisParams = { rent_assumption: { eur_per_m2_month: 12 } };
    const withRent = await createProfile("Con alquiler asumido", scope(), thesisWithRent);
    const withoutRent = await createProfile("Sin alquiler asumido", scope(), {});
    createdProfileIds = [withRent.id, withoutRent.id];

    await withRealDb(async (pool) => {
      // 200,000 EUR purchase, 70 m2, 12 EUR/m2/month rent assumption:
      // gross yield = (12 * 12 * 70) / 200000 * 100 = 5.04%
      const propId = await seedProperty(pool, { price: 200000, m2Built: 70 });
      createdPropertyIds.push(propId);
      await matchProperty(pool, withRent.id, propId);
      await matchProperty(pool, withoutRent.id, propId);
    });

    const overviews = await listProfileOverviews();
    const withRentEntry = overviews.find((e) => e.ok && e.profile.id === withRent.id);
    const withoutRentEntry = overviews.find((e) => e.ok && e.profile.id === withoutRent.id);

    expect(withRentEntry?.ok && withRentEntry.metrics.gross_yield_median_pct).not.toBeNull();
    if (withRentEntry?.ok) {
      expect(withRentEntry.metrics.gross_yield_median_pct).toBeCloseTo(5.04, 2);
    }
    expect(withoutRentEntry?.ok && withoutRentEntry.metrics.gross_yield_median_pct).toBeNull();
  });

  it("feedback last-write-wins: accept -> reject -> accept collapses to one accepted_count, zero rejected", async () => {
    const profile = await createProfile("Con feedback", scope(), {});
    createdProfileIds = [profile.id];
    let propId!: number;
    await withRealDb(async (pool) => {
      propId = await seedProperty(pool);
      createdPropertyIds.push(propId);
      await matchProperty(pool, profile.id, propId);
      // Three events, strictly increasing timestamps, most recent = accept.
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'accept', NOW() - interval '3 minutes')`,
        [profile.id, propId],
      );
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'reject', NOW() - interval '2 minutes')`,
        [profile.id, propId],
      );
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'accept', NOW() - interval '1 minute')`,
        [profile.id, propId],
      );
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.accepted_count).toBe(1);
      expect(entry.metrics.rejected_count).toBe(0);
    }
  });

  it("feedback last-write-wins direction: FIRST event differs from LAST — the most recent one must win (catches a first-write-wins regression the accept/reject/accept case above can't)", async () => {
    const profile = await createProfile("Con feedback direccional", scope(), {});
    createdProfileIds = [profile.id];
    let propId!: number;
    await withRealDb(async (pool) => {
      propId = await seedProperty(pool);
      createdPropertyIds.push(propId);
      await matchProperty(pool, profile.id, propId);
      // First event 'reject', last event 'accept' — first-write-wins and
      // last-write-wins disagree here, unlike the accept/reject/accept
      // sequence above (which starts and ends on the same value and so
      // can't distinguish the two orderings).
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'reject', NOW() - interval '2 minutes')`,
        [profile.id, propId],
      );
      await pool.query(
        `INSERT INTO feedback_event (profile_id, property_id, feedback_type, created_at) VALUES ($1, $2, 'accept', NOW() - interval '1 minute')`,
        [profile.id, propId],
      );
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.accepted_count).toBe(1);
      expect(entry.metrics.rejected_count).toBe(0);
    }
  });

  it("price range: min/median/max computed across matched properties' active-listing prices", async () => {
    const profile = await createProfile("Rango de precio", scope(), {});
    createdProfileIds = [profile.id];
    await withRealDb(async (pool) => {
      const p1 = await seedProperty(pool, { price: 150000 });
      const p2 = await seedProperty(pool, { price: 200000 });
      const p3 = await seedProperty(pool, { price: 310000 });
      createdPropertyIds.push(p1, p2, p3);
      await matchProperty(pool, profile.id, p1);
      await matchProperty(pool, profile.id, p2);
      await matchProperty(pool, profile.id, p3);
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.matched_count).toBe(3);
      expect(entry.metrics.min_price).toBe(150000);
      expect(entry.metrics.max_price).toBe(310000);
      expect(entry.metrics.median_price).toBe(200000);
    }
  });

  it("scoring state: model_trained flips true only once training_example_count crosses MIN_TRAINING_EXAMPLES", async () => {
    const belowThreshold = await createProfile("Modelo insuficiente", scope(), {});
    const atThreshold = await createProfile("Modelo suficiente", scope(), {});
    createdProfileIds = [belowThreshold.id, atThreshold.id];
    await withRealDb(async (pool) => {
      await pool.query(
        `INSERT INTO profile_scoring_model (profile_id, coefficients, training_example_count) VALUES ($1, '{}'::jsonb, $2)`,
        [belowThreshold.id, MIN_TRAINING_EXAMPLES - 1],
      );
      await pool.query(
        `INSERT INTO profile_scoring_model (profile_id, coefficients, training_example_count) VALUES ($1, '{}'::jsonb, $2)`,
        [atThreshold.id, MIN_TRAINING_EXAMPLES],
      );
    });

    const overviews = await listProfileOverviews();
    const below = overviews.find((e) => e.ok && e.profile.id === belowThreshold.id);
    const at = overviews.find((e) => e.ok && e.profile.id === atThreshold.id);
    expect(below?.ok && below.metrics.model_trained).toBe(false);
    expect(below?.ok && below.metrics.training_example_count).toBe(MIN_TRAINING_EXAMPLES - 1);
    expect(at?.ok && at.metrics.model_trained).toBe(true);
  });

  it("thumbnails: top 4 matched candidates by score DESC, lead photo only, placeholder (null) for one with no photo", async () => {
    const profile = await createProfile("Con miniaturas", scope(), {});
    createdProfileIds = [profile.id];
    let best!: number, second!: number, third!: number, fourth!: number, fifth!: number, noPhoto!: number;
    await withRealDb(async (pool) => {
      best = await seedProperty(pool, { price: null });
      second = await seedProperty(pool, { price: null });
      third = await seedProperty(pool, { price: null });
      fourth = await seedProperty(pool, { price: null });
      fifth = await seedProperty(pool, { price: null }); // should NOT appear — only top 4
      noPhoto = await seedProperty(pool, { price: null });
      createdPropertyIds.push(best, second, third, fourth, fifth, noPhoto);

      const withPhoto = async (propertyId: number, url: string) =>
        pool.query(
          `INSERT INTO listing (property_id, source, external_id, status, photo_urls, first_seen_at)
           VALUES ($1, 'test', $2, 'active', $3, NOW())`,
          [propertyId, `ext-${propertyId}`, [url]],
        );
      await withPhoto(best, "https://img.example/best.jpg");
      await withPhoto(second, "https://img.example/second.jpg");
      await withPhoto(third, "https://img.example/third.jpg");
      await withPhoto(fourth, "https://img.example/fourth.jpg");
      await withPhoto(fifth, "https://img.example/fifth.jpg");
      // noPhoto gets an active listing with no photos at all.
      await pool.query(
        `INSERT INTO listing (property_id, source, external_id, status, first_seen_at) VALUES ($1, 'test', $2, 'active', NOW())`,
        [noPhoto, `ext-${noPhoto}`],
      );

      await matchProperty(pool, profile.id, best, { score: 0.9 });
      await matchProperty(pool, profile.id, second, { score: 0.8 });
      await matchProperty(pool, profile.id, third, { score: 0.7 });
      await matchProperty(pool, profile.id, fourth, { score: 0.6 });
      await matchProperty(pool, profile.id, fifth, { score: 0.5 });
      await matchProperty(pool, profile.id, noPhoto, { score: 0.95 }); // highest score, but no photo
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.matched_count).toBe(6);
      expect(entry.metrics.thumbnails).toHaveLength(4);
      const ids = entry.metrics.thumbnails.map((t) => t.property_id);
      // Ordered by score DESC: noPhoto (0.95), best (0.9), second (0.8), third (0.7) — fifth/fourth excluded.
      expect(ids).toEqual([noPhoto, best, second, third]);
      const noPhotoThumb = entry.metrics.thumbnails.find((t) => t.property_id === noPhoto);
      expect(noPhotoThumb?.photo_url).toBeNull();
      const bestThumb = entry.metrics.thumbnails.find((t) => t.property_id === best);
      expect(bestThumb?.photo_url).toBe("https://img.example/best.jpg");
    }
  });

  it("flagged_count: counts matched properties with a tone='warn' occupancy caveat, not 'condition' assessments", async () => {
    const profile = await createProfile("Con alertas", scope(), {});
    createdProfileIds = [profile.id];
    let tenanted!: number, reformar!: number, clean!: number;
    await withRealDb(async (pool) => {
      tenanted = await seedProperty(pool, { price: null });
      reformar = await seedProperty(pool, { price: null });
      clean = await seedProperty(pool, { price: null });
      createdPropertyIds.push(tenanted, reformar, clean);
      await matchProperty(pool, profile.id, tenanted);
      await matchProperty(pool, profile.id, reformar);
      await matchProperty(pool, profile.id, clean);

      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, generated_at)
         VALUES ($1, 'occupancy', $2::jsonb, NOW())`,
        [tenanted, JSON.stringify({ caveats: ["tenanted"] })],
      );
      // 'condition' assessments never contribute to flagged_count, even
      // though this one is a real, non-trivial finding — CONDITION_LABELS
      // is all tone='neutral' (lib/candidates.ts).
      await pool.query(
        `INSERT INTO ai_assessment (property_id, assessment_type, result, generated_at)
         VALUES ($1, 'condition', $2::jsonb, NOW())`,
        [reformar, JSON.stringify({ condition: "a_reformar" })],
      );
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) expect(entry.metrics.flagged_count).toBe(1);
  });

  it("new_count: matched properties first-seen since last_viewed_at (or created_at-1day for a never-viewed profile)", async () => {
    const profile = await createProfile("Con nuevos", scope(), {});
    createdProfileIds = [profile.id];
    let recent!: number, old!: number;
    await withRealDb(async (pool) => {
      recent = await seedProperty(pool, { price: null, createdAt: new Date().toISOString() });
      old = await seedProperty(pool, {
        price: null,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      createdPropertyIds.push(recent, old);
      await matchProperty(pool, profile.id, recent);
      await matchProperty(pool, profile.id, old);
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.matched_count).toBe(2);
      expect(entry.metrics.new_count).toBe(1);
    }
  });
});

describe.runIf(dbAvailable)("EXPLAIN ANALYZE — profile overview query (issue #192)", () => {
  afterAll(async () => {
    await resetPool();
  });

  it(
    "measures the aggregate query against a representative multi-profile, hundreds-of-matched-candidates dataset",
    async () => {
      const createdProfileIds: number[] = [];
      const createdPropertyIds: number[] = [];

      await withRealDb(async (pool) => {
        // "Hundreds of matched candidates" alone (a few thousand total rows,
        // all matched, all active) understates real skew: in production the
        // vast majority of `listing` is NOT the small matched-for-this-
        // profile subset, which is exactly the shape that makes the planner
        // prefer a status-only index scan over the property_id one — a
        // uniform small dataset can't surface that. 20,000 unrelated
        // "noise" properties/listings (elsewhere geographically — a box
        // around 43.3N/-1.8E, Basque-country-ish, deliberately far from
        // every other integration test file's coordinate cluster AND from
        // this file's own Valencia matched-candidate area — mixed active/
        // withdrawn) bring the table to a size where index choice actually
        // matters, bulk-inserted via generate_series rather than 20,000
        // round trips.
        const NOISE_COUNT = 20000;
        const NOISE_LAT_MIN = 42.3;
        const NOISE_LAT_MAX = 44.3;
        const NOISE_LON_MIN = -2.8;
        const NOISE_LON_MAX = -0.8;
        await pool.query(
          `INSERT INTO property (lat, lon, property_type, m2_built, created_at)
           SELECT $2::float8 + (random() * ($3::float8 - $2::float8)),
                  $4::float8 + (random() * ($5::float8 - $4::float8)),
                  'piso', 60 + (random() * 60)::int, NOW()
           FROM generate_series(1, $1::int)`,
          [NOISE_COUNT, NOISE_LAT_MIN, NOISE_LAT_MAX, NOISE_LON_MIN, NOISE_LON_MAX],
        );
        await pool.query(
          `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
           SELECT p.id, 'noise', 'noise-' || p.id, CASE WHEN random() < 0.7 THEN 'active' ELSE 'withdrawn' END,
                  100000 + (random() * 400000)::int, NOW()
           FROM property p
           WHERE p.lat BETWEEN $1::float8 AND $2::float8 AND p.lon BETWEEN $3::float8 AND $4::float8
           ORDER BY p.id DESC
           LIMIT $5::int`,
          [NOISE_LAT_MIN, NOISE_LAT_MAX, NOISE_LON_MIN, NOISE_LON_MAX, NOISE_COUNT],
        );

        // 3 profiles, ~300 matched candidates each (900 total) — a
        // representative "hundreds of matched candidates" volume per the
        // acceptance criteria, seeded directly (bypassing materializeProfile,
        // which isn't what's being measured here).
        for (let p = 0; p < 3; p++) {
          const profileRes = await pool.query<{ id: number }>(
            `INSERT INTO search_profile (name, scope, thesis_params)
             VALUES ($1, $2::jsonb, '{"rent_assumption": {"eur_per_m2_month": 12}}'::jsonb) RETURNING id`,
            [
              `EXPLAIN perf profile ${p}`,
              JSON.stringify({
                geography: { type: "radius", center: VALENCIA, radius_km: 20 },
                property_types: ["piso"],
                hard_exclusions: {},
              }),
            ],
          );
          const profileId = profileRes.rows[0].id;
          createdProfileIds.push(profileId);

          for (let i = 0; i < 300; i++) {
            const propId = await seedProperty(pool, {
              lat: VALENCIA[0] + (Math.random() - 0.5) * 0.2,
              lon: VALENCIA[1] + (Math.random() - 0.5) * 0.2,
              price: 100000 + Math.floor(Math.random() * 300000),
            });
            createdPropertyIds.push(propId);
            await matchProperty(pool, profileId, propId, {
              score: Math.random(),
              scoreKind: Math.random() > 0.5 ? "trained" : "cold_start",
            });
          }
        }

        // Real planner statistics, not the defaults from an empty table —
        // without this, row-count estimates on the just-bulk-inserted noise
        // rows are stale/default and can pick an unrepresentative plan.
        await pool.query("ANALYZE property");
        await pool.query("ANALYZE listing");
        await pool.query("ANALYZE profile_listing_state");
        await pool.query("ANALYZE search_profile");

        const explainRows = await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${OVERVIEW_QUERY_SQL}`,
          [WARN_CAVEAT_CODES],
        );
        const plan = explainRows.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
        // eslint-disable-next-line no-console
        console.log(
          "\n[EXPLAIN ANALYZE] profile overview query, 3 profiles x 300 matched candidates, " +
            `+${NOISE_COUNT} unrelated noise properties/listings:\n` +
            plan +
            "\n",
        );
        const totalTimeLine = plan.split("\n").find((l) => l.includes("Execution Time"));
        expect(totalTimeLine).toBeDefined();

        // Cleanup (afterEach isn't used in this single-test describe block —
        // clean up inline since this test owns unusually large fixture data).
        await pool.query("DELETE FROM profile_listing_state WHERE profile_id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[]) OR source = 'noise'", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [createdProfileIds]);
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdPropertyIds]);
        await pool.query(
          "DELETE FROM property WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4",
          [NOISE_LAT_MIN, NOISE_LAT_MAX, NOISE_LON_MIN, NOISE_LON_MAX],
        );
      });
    },
    60000,
  );
});
