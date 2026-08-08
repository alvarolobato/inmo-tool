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
import { listCandidates } from "@/lib/candidates";
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
  /**
   * #416: the listing's first_seen_at, the basis new_count now measures
   * novelty on (previously property.created_at). Defaults to NOW(). Only
   * applied when a listing is actually seeded (`price !== null`).
   */
  firstSeenAt?: string;
  /**
   * #447: the listing's `source` (portal). Defaults to 'test'. Set to a source
   * registered as a disabled connector to prove new_count excludes it, exactly
   * as the feed's novelty CTE does (activeSourceClause / D-055).
   */
  source?: string;
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
       VALUES ($1, $5, $2, 'active', $3, COALESCE($4::timestamptz, NOW()))`,
      [
        propertyId,
        `ext-${propertyId}-${Math.random()}`,
        opts.price ?? 200000,
        opts.firstSeenAt ?? null,
        opts.source ?? "test",
      ],
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
  let createdConnectorNames: string[] = [];

  beforeEach(() => {
    createdProfileIds = [];
    createdPropertyIds = [];
    createdConnectorNames = [];
  });

  // #447: register `source` as a connector and set its on/off state, so the
  // overview query can resolve the listing's source to a disabled portal
  // (mirrors the candidates.ts D-055 test helper). Tracked for afterEach cleanup.
  async function registerConnector(pool: Pool, name: string, on: boolean) {
    createdConnectorNames.push(name);
    await pool.query(
      `INSERT INTO connector_registry (connector_name, registered, supports_discovery, supported_filters)
       VALUES ($1, true, true, '[]'::jsonb)
       ON CONFLICT (connector_name) DO UPDATE SET supports_discovery = EXCLUDED.supports_discovery`,
      [name],
    );
    await pool.query(
      `INSERT INTO connector_config (connector_name, enabled, capture_enabled, filters)
       VALUES ($1, $2, true, '{}'::jsonb)
       ON CONFLICT (connector_name) DO UPDATE SET enabled = $2`,
      [name, on],
    );
  }

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
      if (createdConnectorNames.length > 0) {
        await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1::text[])", [
          createdConnectorNames,
        ]);
        await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1::text[])", [
          createdConnectorNames,
        ]);
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

  it("flagged_count (#467): counts the UNION (caveat-only + redflags-only + both), excludes condition/never-assessed, and EQUALS the hasAlerts feed filter for the same seed", async () => {
    const profile = await createProfile("Con alertas unión", scope(), {});
    createdProfileIds = [profile.id];
    let caveatOnly!: number, redflagOnly!: number, both!: number, conditionOnly!: number, clean!: number;

    // #467: the overview count was broadened from occupancy-caveats-only to the
    // SAME UNION predicate the feed's "Con alertas" filter uses (≥1 redflag OR
    // ≥1 warn caveat). Each property needs an ACTIVE SALE listing to be
    // feed-eligible (the hasAlerts filter runs over the feed), so seed those
    // explicitly with operation='sale' rather than seedProperty's price helper
    // (which does not set operation). Uniform price so nothing but the alert
    // predicate distinguishes the rows.
    await withRealDb(async (pool) => {
      const seedWithSaleListing = async (): Promise<number> => {
        const res = await pool.query<{ id: number }>(
          `INSERT INTO property (lat, lon, property_type, m2_built, created_at)
           VALUES ($1, $2, 'piso', 70, NOW()) RETURNING id`,
          [VALENCIA[0], VALENCIA[1]],
        );
        const id = res.rows[0].id;
        await pool.query(
          `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at)
           VALUES ($1, 'test', $2, 'active', 'sale', 250000, NOW())`,
          [id, `ext-${id}-${Math.random()}`],
        );
        return id;
      };
      caveatOnly = await seedWithSaleListing();
      redflagOnly = await seedWithSaleListing();
      both = await seedWithSaleListing();
      conditionOnly = await seedWithSaleListing();
      clean = await seedWithSaleListing();
      createdPropertyIds.push(caveatOnly, redflagOnly, both, conditionOnly, clean);
      for (const id of [caveatOnly, redflagOnly, both, conditionOnly, clean]) {
        await matchProperty(pool, profile.id, id);
      }

      const insertAssessment = (propertyId: number, type: string, result: Record<string, unknown>) =>
        pool.query(
          `INSERT INTO ai_assessment (property_id, assessment_type, result, generated_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [propertyId, type, JSON.stringify(result)],
        );
      const WARN = WARN_CAVEAT_CODES[0]; // a real warn-tone occupancy caveat code
      const redflag = { flags: [{ type: "embargo", description: "x", evidence: "y" }] };

      await insertAssessment(caveatOnly, "occupancy", { caveats: [WARN] }); // caveat → alert
      await insertAssessment(redflagOnly, "redflags", redflag); // redflag → alert (was UNCOUNTED before #467)
      await insertAssessment(both, "occupancy", { caveats: [WARN] }); // both axes → still one property
      await insertAssessment(both, "redflags", redflag);
      // 'condition' is all tone='neutral' (lib/candidates.ts) → never an alert.
      await insertAssessment(conditionOnly, "condition", { condition: "a_reformar" });
      // clean: no assessment at all → not an alert (unknown, never a false pass).
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    // caveatOnly + redflagOnly + both = 3; conditionOnly + clean excluded.
    if (entry?.ok) expect(entry.metrics.flagged_count).toBe(3);

    // Count⇔filter invariant (#467): the feed's hasAlerts filter returns
    // EXACTLY the set the overview counts — same profile, same predicate.
    const filtered = await listCandidates(profile.id, { hasAlerts: true, limit: 100 });
    const filteredIds = filtered.items.map((c) => c.property_id).sort((a, b) => a - b);
    expect(filteredIds).toEqual([caveatOnly, redflagOnly, both].sort((a, b) => a - b));
    if (entry?.ok) expect(filtered.items.length).toBe(entry.metrics.flagged_count);
  });

  it("new_count: matched properties whose LISTING first-seen is since the anchor (#416: previous_viewed_at, or created_at-1day for a never-visited profile; measured on listing.first_seen_at, not property.created_at)", async () => {
    const profile = await createProfile("Con nuevos", scope(), {});
    createdProfileIds = [profile.id];
    let recent!: number, old!: number;
    await withRealDb(async (pool) => {
      // #416: novelty is now measured on the LISTING's first_seen_at (the
      // investable event — when the listing appeared), not property.created_at.
      // A never-visited profile (previous_viewed_at NULL) falls back to
      // created_at - 1 day, so a listing first-seen today is new and one
      // first-seen 30 days ago is not.
      recent = await seedProperty(pool, { price: 200000, firstSeenAt: new Date().toISOString() });
      old = await seedProperty(pool, {
        price: 200000,
        firstSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
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

  it("new_count (#447): a recent listing from a DISABLED source does not count as new — matches the feed's activeSourceClause (D-055)", async () => {
    const profile = await createProfile("Fuente desactivada", scope(), {});
    createdProfileIds = [profile.id];
    const disabledSource = `ov447-off-${Date.now()}`;
    let active!: number, disabled!: number;
    await withRealDb(async (pool) => {
      await registerConnector(pool, disabledSource, false);
      // Both first-seen just now (well after the never-visited anchor of
      // created_at - 1 day), so both WOULD be new on timing alone. Only the
      // active-source one is shown as NUEVO in the feed, so only it counts.
      active = await seedProperty(pool, { price: 200000, firstSeenAt: new Date().toISOString() });
      disabled = await seedProperty(pool, {
        price: 200000,
        firstSeenAt: new Date().toISOString(),
        source: disabledSource,
      });
      createdPropertyIds.push(active, disabled);
      await matchProperty(pool, profile.id, active);
      await matchProperty(pool, profile.id, disabled);
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.matched_count).toBe(2);
      // Only the active-source property is NUEVO in the feed → count is 1, not 2.
      expect(entry.metrics.new_count).toBe(1);
    }
  });

  it("new_count (#447): STRICT '>' against previous_viewed_at — a listing first-seen exactly at the anchor is NOT new (matches the feed)", async () => {
    const profile = await createProfile("Frontera del ancla", scope(), {});
    createdProfileIds = [profile.id];
    const anchor = new Date("2026-01-01T00:00:00.000Z");
    const afterAnchor = new Date(anchor.getTime() + 60_000); // 1 min after
    let atAnchor!: number, after!: number;
    await withRealDb(async (pool) => {
      // Pin the visit anchor: the feed and the count both read previous_viewed_at.
      await pool.query("UPDATE search_profile SET previous_viewed_at = $2 WHERE id = $1", [
        profile.id,
        anchor.toISOString(),
      ]);
      atAnchor = await seedProperty(pool, { price: 200000, firstSeenAt: anchor.toISOString() });
      after = await seedProperty(pool, { price: 200000, firstSeenAt: afterAnchor.toISOString() });
      createdPropertyIds.push(atAnchor, after);
      await matchProperty(pool, profile.id, atAnchor);
      await matchProperty(pool, profile.id, after);
    });

    const overviews = await listProfileOverviews();
    const entry = overviews.find((e) => e.ok && e.profile.id === profile.id);
    expect(entry?.ok).toBe(true);
    if (entry?.ok) {
      expect(entry.metrics.matched_count).toBe(2);
      // '>' is strict: first_seen == anchor is NOT new; only the later one is.
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
        // The two bulk `INSERT ... SELECT`s below insert 20k properties + 20k
        // listings in single statements. Since #470 the property/listing
        // AFTER-INSERT triggers recompute `property_search_doc` PER ROW, so
        // firing them 40k times inside one statement would blow this test's
        // timeout — and this test measures the profile-overview aggregate, which
        // never reads `property_search_doc`, so the noise rows need no search doc
        // at all. Suppress the triggers with `session_replication_role=replica`
        // on a DEDICATED connection (not the shared pool), so the suppression is
        // scoped to this connection's statements only and can't race the other
        // integration test files vitest runs in parallel against the same DB
        // (a table-wide `ALTER TABLE ... DISABLE TRIGGER` would). The matched-
        // candidate loop below stays on the pool with triggers live — 900 rows
        // is a trivial per-row cost and keeps the setup faithful.
        const bulkClient = await pool.connect();
        try {
          await bulkClient.query("SET session_replication_role = replica");
          await bulkClient.query(
            `INSERT INTO property (lat, lon, property_type, m2_built, created_at)
             SELECT $2::float8 + (random() * ($3::float8 - $2::float8)),
                    $4::float8 + (random() * ($5::float8 - $4::float8)),
                    'piso', 60 + (random() * 60)::int, NOW()
             FROM generate_series(1, $1::int)`,
            [NOISE_COUNT, NOISE_LAT_MIN, NOISE_LAT_MAX, NOISE_LON_MIN, NOISE_LON_MAX],
          );
          await bulkClient.query(
            `INSERT INTO listing (property_id, source, external_id, status, current_price, first_seen_at)
             SELECT p.id, 'noise', 'noise-' || p.id, CASE WHEN random() < 0.7 THEN 'active' ELSE 'withdrawn' END,
                    100000 + (random() * 400000)::int, NOW()
             FROM property p
             WHERE p.lat BETWEEN $1::float8 AND $2::float8 AND p.lon BETWEEN $3::float8 AND $4::float8
             ORDER BY p.id DESC
             LIMIT $5::int`,
            [NOISE_LAT_MIN, NOISE_LAT_MAX, NOISE_LON_MIN, NOISE_LON_MAX, NOISE_COUNT],
          );
          await bulkClient.query("SET session_replication_role = origin");
        } finally {
          bulkClient.release();
        }

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
