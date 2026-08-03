/**
 * Real-Postgres integration test for the driver-level BIGINT (int8) type
 * parser (issue #155). A mocked-`pg` unit test can't catch a regression
 * here: the whole point of the fix is what the real wire protocol sends back
 * for OID 20, and a mock never goes near that code path (see the "pass
 * through" tests this same fix required updating in
 * lib/__tests__/candidates.test.ts). Only a real query proves it.
 *
 * This is the test issue #155's acceptance criteria calls for: "Add a test
 * asserting a BIGINT id arrives as number from a real query, so a future
 * driver upgrade or config change can't silently reintroduce it."
 */
import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";

const NAME_PREFIX = "__db_shared_int8_test__";

async function withRealDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    return await fn(pool);
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
      "[db-shared.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

describe.runIf(dbAvailable)("int8 (BIGINT) type parser — real Postgres", () => {
  const createdIds: number[] = [];

  afterAll(async () => {
    if (createdIds.length === 0) return;
    await withRealDb(async (pool) => {
      await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [createdIds]);
    });
  });

  it("a BIGSERIAL id (property.id) arrives as a JS number, not a string", async () => {
    await withRealDb(async (pool) => {
      const insert = await pool.query<{ id: number }>(
        `INSERT INTO property (address, property_type) VALUES ($1, 'piso') RETURNING id`,
        [`${NAME_PREFIX} ${Date.now()}`],
      );
      const id = insert.rows[0].id;
      createdIds.push(id);

      expect(typeof id).toBe("number");

      // Re-select to prove it round-trips through a plain SELECT too, not
      // just RETURNING.
      const selected = await pool.query<{ id: number }>(
        `SELECT id FROM property WHERE id = $1`,
        [id],
      );
      expect(typeof selected.rows[0].id).toBe("number");
      expect(selected.rows[0].id).toBe(id);
    });
  });

  it("COUNT(*) (bigint) arrives as a JS number", async () => {
    await withRealDb(async (pool) => {
      const result = await pool.query<{ count: number }>("SELECT COUNT(*) FROM property");
      expect(typeof result.rows[0].count).toBe("number");
    });
  });

  it("a value beyond Number.MAX_SAFE_INTEGER still parses (documented precision tradeoff, #155)", async () => {
    // Not a realistic value for any column in this schema (see db-shared.ts's
    // comment on why that's true) — this just proves the parser applies
    // uniformly rather than special-casing "small" bigints, so the tradeoff
    // is real and consistently applied, not accidentally masked by only ever
    // testing small values.
    await withRealDb(async (pool) => {
      const result = await pool.query<{ big: number }>(
        "SELECT 9223372036854775807::bigint AS big",
      );
      expect(typeof result.rows[0].big).toBe("number");
      // Precision is genuinely lost above 2^53 — asserting *that*, not a
      // false claim of exactness, is the point of this test. (Comparing
      // against the literal `9223372036854775807` itself would be
      // comparing two independently-rounded doubles and prove nothing —
      // `Number.isSafeInteger` is the real assertion.)
      expect(Number.isSafeInteger(result.rows[0].big)).toBe(false);
    });
  });

  it("NUMERIC columns (a different OID, genuine precision rationale) still arrive as strings", async () => {
    // Confirms #155's scope boundary: only int8/OID 20 is touched. property.lat
    // is NUMERIC(9,6) — must NOT be affected by the int8 parser.
    await withRealDb(async (pool) => {
      const insert = await pool.query<{ id: number }>(
        `INSERT INTO property (address, property_type, lat) VALUES ($1, 'piso', 40.4168) RETURNING id, lat`,
        [`${NAME_PREFIX} ${Date.now()}`],
      );
      createdIds.push(insert.rows[0].id);
      expect(typeof (insert.rows[0] as unknown as { lat: unknown }).lat).toBe("string");
    });
  });
});
