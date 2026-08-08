/**
 * E2E (D-041): free-text search backend — #470 Phase 1.
 *
 * Phase 1 ships NO UI (the search box is Phase 2), so this drives the surface
 * that DOES exist end-to-end: the candidates API against a real Next.js server
 * and a real, self-seeded Postgres — exercising the trigger-built
 * property_search_doc + the GIN-indexed `q` filter the way the browser will once
 * the box lands. It proves the class of bug D-041 exists to catch (SQL that only
 * fails against real data): the tsvector config, the trigger, and the
 * websearch_to_tsquery composition all have to actually work.
 *
 * Self-seeds via pg and authenticates the API with the x-admin-key header
 * (every /api/* route is admin-gated by middleware.ts). Skips cleanly with no
 * DB or no ADMIN_API_KEY, matching candidates.spec.ts.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";
import { adminKey } from "./helpers/admin-session";

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

// Málaga coast — distinct from candidates.spec.ts's MADRID_SOL so concurrent
// specs never overlap on a radius scan.
const MARBELLA: [number, number] = [36.5108, -4.8856];
const NAME_PREFIX = "e2e-freetext-";

let pool: Pool;
let dbAvailable = false;
let profileId: number;
let terracePropertyId: number;
let plainPropertyId: number;
let malagaPropertyId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[freetext-search.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  const profileResult = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params)
     VALUES ($1, $2::jsonb, '{}'::jsonb) RETURNING id`,
    [
      `${NAME_PREFIX}${Date.now()}`,
      JSON.stringify({
        geography: { type: "radius", center: MARBELLA, radius_km: 5 },
        property_types: ["piso"],
        hard_exclusions: {},
      }),
    ],
  );
  profileId = profileResult.rows[0].id;

  async function insertProperty(address: string): Promise<number> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO property (lat, lon, property_type, m2_built, address)
       VALUES ($1, $2, 'piso', 70, $3) RETURNING id`,
      [MARBELLA[0], MARBELLA[1], address],
    );
    // pg returns bigint as a string; the API returns property_id as a real JS
    // number (int8 parser, #155). Coerce here so the assertions compare like types.
    return Number(r.rows[0].id);
  }
  async function insertListing(propertyId: number, description: string): Promise<void> {
    // The AFTER INSERT trigger builds property_search_doc from this row.
    await pool.query(
      `INSERT INTO listing (property_id, source, external_id, status, operation, current_price, first_seen_at, description)
       VALUES ($1, 'fotocasa', $2, 'active', 'sale', 285000, NOW(), $3)`,
      [propertyId, `${NAME_PREFIX}${Math.random().toString(36).slice(2)}`, description],
    );
  }
  async function markMatched(propertyId: number): Promise<void> {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched) VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );
  }

  terracePropertyId = await insertProperty(`${NAME_PREFIX}Calle Larios, Marbella`);
  await insertListing(terracePropertyId, "Bonito piso con terraza soleada y vistas.");
  await markMatched(terracePropertyId);

  plainPropertyId = await insertProperty(`${NAME_PREFIX}Avenida del Mar, Marbella`);
  await insertListing(plainPropertyId, "Piso interior reformado, sin exteriores.");
  await markMatched(plainPropertyId);

  malagaPropertyId = await insertProperty(`${NAME_PREFIX}Paseo Marítimo, Málaga`);
  await insertListing(malagaPropertyId, "Piso céntrico bien comunicado.");
  await markMatched(malagaPropertyId);
});

test.afterAll(async () => {
  if (!dbAvailable) return;
  await pool.query(
    "DELETE FROM profile_listing_state WHERE profile_id IN " +
      "(SELECT id FROM search_profile WHERE name LIKE $1)",
    [`${NAME_PREFIX}%`],
  );
  await pool.query("DELETE FROM search_profile WHERE name LIKE $1", [`${NAME_PREFIX}%`]);
  await pool.query("DELETE FROM listing WHERE external_id LIKE $1", [`${NAME_PREFIX}%`]);
  // property_search_doc rows cascade with the property delete below.
  await pool.query(
    "DELETE FROM property WHERE id NOT IN (SELECT property_id FROM listing) AND address LIKE $1",
    [`${NAME_PREFIX}%`],
  );
  await pool.end();
});

function skipIfNoDb() {
  test.skip(!dbAvailable, "no reachable Postgres");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
}

async function fetchIds(
  request: APIRequestContext,
  baseURL: string | undefined,
  query: string,
): Promise<{ status: number; ids: number[]; body: unknown }> {
  const res = await request.get(
    `${baseURL ?? "http://localhost:4000"}/api/profiles/${profileId}/candidates${query}`,
    { headers: { "x-admin-key": adminKey ?? "" } },
  );
  const body = await res.json();
  const ids = Array.isArray((body as { items?: { property_id: number }[] }).items)
    ? (body as { items: { property_id: number }[] }).items.map((i) => i.property_id)
    : [];
  return { status: res.status(), ids, body };
}

test("q=terraza narrows the feed to the matching ad", async ({ request, baseURL }) => {
  skipIfNoDb();
  const { status, ids } = await fetchIds(request, baseURL, "?q=terraza");
  expect(status).toBe(200);
  expect(ids).toContain(terracePropertyId);
  expect(ids).not.toContain(plainPropertyId);
});

test("q=malaga matches the accented address (unaccent)", async ({ request, baseURL }) => {
  skipIfNoDb();
  const { status, ids } = await fetchIds(request, baseURL, "?q=malaga");
  expect(status).toBe(200);
  expect(ids).toContain(malagaPropertyId);
});

test("a non-matching q returns an empty feed with no error surface", async ({ request, baseURL }) => {
  skipIfNoDb();
  const { status, ids, body } = await fetchIds(request, baseURL, "?q=zzz-inexistente-xyz");
  expect(status).toBe(200);
  expect(ids).toHaveLength(0);
  // No error surface: the response is a well-formed empty page, not a 500/error body.
  expect(body).toMatchObject({ items: [], nextCursor: null });
});

test("the feed without q is intact (all seeded candidates present)", async ({ request, baseURL }) => {
  skipIfNoDb();
  const { status, ids } = await fetchIds(request, baseURL, "");
  expect(status).toBe(200);
  expect(ids).toEqual(
    expect.arrayContaining([terracePropertyId, plainPropertyId, malagaPropertyId]),
  );
});

test("q over 200 chars is rejected with 400", async ({ request, baseURL }) => {
  skipIfNoDb();
  const res = await request.get(
    `${baseURL ?? "http://localhost:4000"}/api/profiles/${profileId}/candidates?q=${"a".repeat(201)}`,
    { headers: { "x-admin-key": adminKey ?? "" } },
  );
  expect(res.status()).toBe(400);
});

test("an UPDATE to a description refreshes the doc (search finds the new text)", async ({
  request,
  baseURL,
}) => {
  skipIfNoDb();
  // A term absent from all seeded ads.
  const before = await fetchIds(request, baseURL, "?q=chimenea");
  expect(before.ids).not.toContain(plainPropertyId);

  await pool.query(
    "UPDATE listing SET description = $2 WHERE property_id = $1",
    [plainPropertyId, "Piso con chimenea de leña y suelos de madera."],
  );

  const after = await fetchIds(request, baseURL, "?q=chimenea");
  expect(after.status).toBe(200);
  expect(after.ids).toContain(plainPropertyId);
});
