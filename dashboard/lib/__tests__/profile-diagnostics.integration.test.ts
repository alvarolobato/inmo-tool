/**
 * Real-Postgres integration test for the zero-candidate diagnostic (issue
 * #194) — the exact "Dos Hermanas" incident (§ the issue's Context) is
 * reproduced here with real coordinates: a profile centered on Dos Hermanas
 * with a 7 km radius, and the nearest real listing ~7.6 km away in Sevilla
 * capital — the near-miss the plain "0 candidatos" UI gave zero information
 * about. A mocked query cannot judge row selection/distance computation
 * across this funnel, so every branch here runs against real property/
 * listing/profile_listing_state/connector_runs rows.
 *
 * Coordinates: Dos Hermanas / Sevilla (~37.3, -5.9) — distinct from every
 * other integration test file's cluster (Madrid ~40.2-40.57, Barcelona
 * ~41.39/2.17, Valencia ~39.47/-0.38, profile-overview.integration.test.ts's
 * noise box ~42.3-44.3/-2.8 to -0.8).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { createProfile, getProfileById, updateProfile } from "@/lib/db/profiles";
import { materializeProfile } from "@/lib/filtering/materialize";
import { diagnoseZeroCandidates } from "../profile-diagnostics";
import type { Scope } from "@/lib/profiles-schema";

// Real coordinates (WGS84 approximate town centers).
const SEVILLA: [number, number] = [37.3891, -5.9845];
const DOS_HERMANAS: [number, number] = [37.2836, -5.9223];

/** Same formula as lib/filtering/scope-query.ts's haversineKm SQL expression — ground truth for distance assertions. */
function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const x = Math.min(
    1,
    Math.max(
      -1,
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2) - toRad(lon1)) +
        Math.sin(toRad(lat1)) * Math.sin(toRad(lat2)),
    ),
  );
  return 6371 * Math.acos(x);
}

/** A point due north of `center` by `km`, using the same linear approximation lib/analytics/area-price.ts uses (1 deg lat ~= 111.0 km) — close enough that the real Haversine distance below lands within a few hundred metres of `km`, verified per-test via haversineKm. */
function pointNorthOf(center: [number, number], km: number): [number, number] {
  return [center[0] + km / 111.0, center[1]];
}

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
      "[profile-diagnostics.integration.test] no reachable Postgres — skipping. Set POSTGRES_DSN to run.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

function baseScope(overrides: Partial<Scope> = {}): Scope {
  return {
    geography: { type: "radius", center: DOS_HERMANAS, radius_km: 7 },
    property_types: ["piso"],
    hard_exclusions: {},
    ...overrides,
  };
}

async function insertProperty(
  pool: Pool,
  opts: {
    center?: [number, number];
    propertyType?: string;
    price?: number | null;
    m2Built?: number | null;
    hasElevator?: boolean | null;
    floor?: string | null;
  } = {},
): Promise<number> {
  const [lat, lon] = opts.center ?? DOS_HERMANAS;
  const propRes = await pool.query<{ id: number }>(
    `INSERT INTO property (lat, lon, property_type, m2_built, has_elevator, floor)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      lat,
      lon,
      opts.propertyType ?? "piso",
      opts.m2Built === undefined ? 80 : opts.m2Built,
      opts.hasElevator ?? null,
      opts.floor ?? null,
    ],
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

describe.runIf(dbAvailable)("diagnoseZeroCandidates — real Postgres (issue #194)", () => {
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

  it("1. never materialized: last_materialized_at IS NULL", async () => {
    const profile = await createProfile("Nunca calculado", baseScope(), {});
    createdProfileIds = [profile.id];

    const diagnosis = await diagnoseZeroCandidates(profile);
    expect(diagnosis.kind).toBe("never_materialized");
  });

  it("2a. geography_empty — the literal Dos Hermanas incident: nearest real listing 7.6km away, 7km radius", async () => {
    const profile = await createProfile("Dos Hermanas", baseScope({ geography: { type: "radius", center: DOS_HERMANAS, radius_km: 7 } }), {});
    createdProfileIds = [profile.id];

    const nearPoint = pointNorthOf(DOS_HERMANAS, 7.6);
    const expectedDistance = haversineKm(DOS_HERMANAS, nearPoint);
    expect(expectedDistance).toBeGreaterThan(7); // confirm the fixture is genuinely outside the radius

    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { center: nearPoint, price: 200000 });
      await pool.query(
        `INSERT INTO connector_runs (trigger, started_at, finished_at, status) VALUES ('scheduled', NOW(), NOW(), 'success')`,
      );
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("geography_empty");
    if (diagnosis.kind === "geography_empty") {
      expect(diagnosis.radiusKm).toBe(7);
      expect(diagnosis.nearest).not.toBeNull();
      expect(diagnosis.nearest?.propertyId).toBe(propertyId);
      // Real Haversine distance, not the linear approximation used to place
      // the fixture — within a few hundred metres of the intended 7.6km.
      expect(diagnosis.nearest?.distanceKm).toBeCloseTo(expectedDistance, 3);
      expect(diagnosis.nearest?.distanceKm).toBeGreaterThan(7); // distinguishable from "inside radius"
      expect(diagnosis.connectorLastRunFinishedAt).not.toBeNull();
    }

    await withRealDb(async (pool) => {
      await pool.query(`DELETE FROM connector_runs WHERE trigger = 'scheduled'`);
    });
  });

  it("2a (interior check): a property genuinely inside the radius never reaches geography_empty", async () => {
    const profile = await createProfile("Dentro del radio", baseScope(), {});
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { center: pointNorthOf(DOS_HERMANAS, 2), price: 200000 });
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);
    // Property matches everything -> not_zero, never geography_empty.
    expect(diagnosis.kind).toBe("not_zero");
  });

  it("2b. type_empty: geography count > 0 but no property of the target type", async () => {
    const profile = await createProfile("Solo pisos", baseScope({ property_types: ["piso"] }), {});
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { propertyType: "chalet", price: 200000 });
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("type_empty");
    if (diagnosis.kind === "type_empty") {
      expect(diagnosis.geographyCount).toBe(1);
      expect(diagnosis.propertyTypes).toEqual(["piso"]);
    }
  });

  it("2c. price_size_empty: type matches, but price is outside the profile's band", async () => {
    const profile = await createProfile(
      "Rango de precio",
      baseScope({ price_min: 150000, price_max: 220000 }),
      {},
    );
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { price: 400000 }); // above price_max
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("price_size_empty");
    if (diagnosis.kind === "price_size_empty") {
      expect(diagnosis.typeCount).toBe(1);
      expect(diagnosis.priceMin).toBe(150000);
      expect(diagnosis.priceMax).toBe(220000);
    }
  });

  it("2d. exclusion_empty: price/size matches, but the property fails a single hard exclusion — names that exclusion alone", async () => {
    const profile = await createProfile(
      "Requiere ascensor",
      baseScope({ hard_exclusions: { requires_elevator: true } }),
      {},
    );
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { price: 200000, hasElevator: false });
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("exclusion_empty");
    if (diagnosis.kind === "exclusion_empty") {
      expect(diagnosis.priceSizeCount).toBe(1);
      expect(diagnosis.excludedBy).toEqual(["el filtro de ascensor"]);
    }
  });

  it("2d: excludes_ground_floor is named distinctly from requires_elevator", async () => {
    const profile = await createProfile(
      "Sin planta baja",
      baseScope({ hard_exclusions: { excludes_ground_floor: true } }),
      {},
    );
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { price: 200000, floor: "Bajo" });
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("exclusion_empty");
    if (diagnosis.kind === "exclusion_empty") {
      expect(diagnosis.excludedBy).toEqual(["el filtro de planta baja"]);
    }
  });

  it("2d: BOTH exclusions active, but only ONE is the real culprit — names only that one, not both (proves isolation testing, not 'list every active exclusion')", async () => {
    const profile = await createProfile(
      "Ascensor y planta baja",
      baseScope({ hard_exclusions: { requires_elevator: true, excludes_ground_floor: true } }),
      {},
    );
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      // Fails requires_elevator (no elevator) but genuinely passes
      // excludes_ground_floor (a normal floor, not "Bajo") — only the
      // elevator filter is the real reason this property is excluded.
      propertyId = await insertProperty(pool, { price: 200000, hasElevator: false, floor: "3" });
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("exclusion_empty");
    if (diagnosis.kind === "exclusion_empty") {
      expect(diagnosis.excludedBy).toEqual(["el filtro de ascensor"]);
    }
  });

  it("3. stale_materialization: the funnel finds a real candidate under the CURRENT scope, but matched_count is still 0 because the profile hasn't been recalculated since it was widened", async () => {
    // Narrow scope first (excludes the only property by price), materialize
    // (matched=0, last_materialized_at set) — then widen the scope via
    // updateProfile WITHOUT re-materializing. The funnel (built from the
    // NEW scope) finds the property; profile_listing_state still says 0.
    const narrow = await createProfile("Se ampliará después", baseScope({ price_max: 100000 }), {});
    createdProfileIds = [narrow.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { price: 200000 });
    });
    createdPropertyIds = [propertyId];

    const firstRun = await materializeProfile(narrow.id);
    expect(firstRun?.matchedCount).toBe(0);

    await updateProfile(narrow.id, { scope: baseScope({ price_max: 300000 }) });
    const refetched = await getProfileById(narrow.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("stale_materialization");
    if (diagnosis.kind === "stale_materialization") {
      expect(diagnosis.funnelCount).toBe(1);
    }
  });

  it("not_zero: a profile with real matched candidates never returns a zero-candidate diagnosis", async () => {
    const profile = await createProfile("Con candidatos", baseScope(), {});
    createdProfileIds = [profile.id];
    let propertyId!: number;
    await withRealDb(async (pool) => {
      propertyId = await insertProperty(pool, { price: 200000 });
    });
    createdPropertyIds = [propertyId];

    await materializeProfile(profile.id);
    const refetched = await getProfileById(profile.id);
    const diagnosis = await diagnoseZeroCandidates(refetched!);

    expect(diagnosis.kind).toBe("not_zero");
    if (diagnosis.kind === "not_zero") expect(diagnosis.matchedCount).toBe(1);
  });
});
