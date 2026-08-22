/**
 * Real-Postgres tests for the D-169 block-resolution derivation (issue #711).
 *
 * These MUST run against a real database. The whole fix is one SQL LATERAL —
 * which statuses clear a block, which clock the comparison is anchored on,
 * and that the correlation is per-portal. A mocked `query()` returns whatever
 * the test hands it, so a unit test can only pin the SQL *text*; nothing but
 * Postgres can tell us the SQL is right. The sibling extension-blocks.test.ts
 * covers the text and the row mapping.
 *
 * The live false alarm being pinned: on 2026-08-22 the owner's Estado board
 * showed "captura de idealista pausada por bloqueo (muro CAPTCHA) · hace 2 h"
 * directly above a source row reading "idealista · +16 en 24h · hace 1m". One
 * episode row (14:53:33), 53 terminal idealista captures after it, the most
 * recent 11 seconds before the screenshot. `production shape` below is that
 * exact sequence.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a hard
 * failure (see AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool as resetReadPool } from "@/lib/db";
import { getRecentBlockEpisodes } from "../extension-blocks";
import { activeBlocksByPortal } from "@/lib/data-health";

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

/** Portals invented for this test so it cannot collide with real rows. */
const P_A = "e2e-711-portal-a";
const P_B = "e2e-711-portal-b";
const URL_PREFIX = "https://example.invalid/e2e-711/";

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
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for extension-blocks.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn("[extension-blocks.integration.test] no reachable Postgres - skipping.");
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM extension_block_episode WHERE portal = ANY($1::text[])`, [
    [P_A, P_B],
  ]);
  await pool.query(`DELETE FROM extension_capture WHERE url LIKE $1`, [`${URL_PREFIX}%`]);
}

/** One episode. `detectedAt`/`reportedAt` are ISO strings so each test can be
 * explicit about the two clocks the derivation has to reconcile. */
async function episode(
  pool: Pool,
  portal: string,
  detectedAt: string,
  reportedAt = detectedAt,
): Promise<void> {
  await pool.query(
    `INSERT INTO extension_block_episode (portal, signature, detected_at, reported_at)
     VALUES ($1, 'captcha_wall', $2, $3)`,
    [portal, detectedAt, reportedAt],
  );
}

/** One terminal capture attributed to `portal` via connector_name, the same
 * column etl/capture.py sets on every terminal outcome. */
async function capture(
  pool: Pool,
  portal: string,
  status: string,
  createdAt: string,
  tag = Math.random().toString(36).slice(2),
): Promise<void> {
  await pool.query(
    `INSERT INTO extension_capture (url, connector_name, status, created_at, processed_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [`${URL_PREFIX}${portal}/${status}/${tag}`, portal, status, createdAt],
  );
}

/** `resolved_at` for one of this test's portals, via the real read path. */
async function resolvedAtFor(portal: string): Promise<string | null> {
  const rows = await getRecentBlockEpisodes();
  const row = rows.find((r) => r.portal === portal);
  expect(row, `expected an episode row for ${portal}`).toBeDefined();
  return row!.resolved_at;
}

describe.skipIf(!dbAvailable)("block-episode resolution, derived (issue #711, D-169)", () => {
  beforeEach(async () => {
    await withRealDb(cleanup);
  });

  afterAll(async () => {
    await withRealDb(cleanup);
    await resetReadPool();
  });

  it("reproduces the production false alarm, and no longer raises it", async () => {
    // The exact live shape: episode at 14:53:33, captures resuming at 17:39,
    // read at 17:45. Before D-169 this rendered an active block for 24 h.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T14:53:33.475Z");
      await capture(pool, P_A, "done", "2026-08-22T17:39:47.618Z");
      await capture(pool, P_A, "withdrawn", "2026-08-22T17:40:34.676Z");
      await capture(pool, P_A, "done", "2026-08-22T17:44:49.981Z");
    });

    const rows = await getRecentBlockEpisodes();
    const row = rows.find((r) => r.portal === P_A)!;
    // The episode still EXISTS — Actividad renders it as history (#706).
    expect(row.detected_at).toBe("2026-08-22T14:53:33.475Z");
    // ...and it is resolved by the FIRST clearing capture, not the last.
    expect(row.resolved_at).toBe("2026-08-22T17:39:47.618Z");
    // ...so the board says nothing, read at the moment of the screenshot.
    const now = Date.parse("2026-08-22T17:45:00.290Z");
    expect(activeBlocksByPortal(rows, now).has(P_A)).toBe(false);
  });

  it("keeps the alarm up when nothing has been served since", async () => {
    // The control. Same episode, same window, no clearing capture — the state
    // this feature exists to show, and the one D-169 must not swallow.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T14:53:33.475Z");
    });
    const rows = await getRecentBlockEpisodes();
    expect(rows.find((r) => r.portal === P_A)!.resolved_at).toBeNull();
    expect(activeBlocksByPortal(rows, Date.parse("2026-08-22T17:45:00Z")).has(P_A)).toBe(true);
  });

  it.each([
    ["done", true],
    ["withdrawn", true],
    ["listing", true],
    ["blocked", false],
    ["never_rendered", false],
    ["failed", false],
    ["pending", false],
  ] as const)("status %s clears the block: %s", async (status, clears) => {
    // The heart of D-169, one row per value the CHECK constraint allows — so
    // adding an eighth status without deciding this question breaks a test
    // rather than silently defaulting to "does not clear".
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T14:00:00.000Z");
      await capture(pool, P_A, status, "2026-08-22T15:00:00.000Z");
    });
    expect(await resolvedAtFor(P_A)).toBe(clears ? "2026-08-22T15:00:00.000Z" : null);
  });

  it("covers every status the extension_capture CHECK constraint allows", async () => {
    // Guards the table above: if a new status lands and nobody decides whether
    // it clears a block, this fails instead of the question going unasked.
    const decided = new Set([
      "done",
      "withdrawn",
      "listing",
      "blocked",
      "never_rendered",
      "failed",
      "pending",
    ]);
    const allowed = await withRealDb(async (pool) => {
      const res = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname = 'extension_capture_status_check'`,
      );
      expect(res.rows.length, "extension_capture_status_check not found").toBe(1);
      return [...res.rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    });
    expect(allowed.length).toBeGreaterThan(0);
    expect([...allowed].sort()).toEqual([...decided].sort());
  });

  it("does not let one portal's recovery clear another portal's wall", async () => {
    // Both walled at the same instant; only P_B has been served since.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T14:00:00.000Z");
      await episode(pool, P_B, "2026-08-22T14:00:00.000Z");
      await capture(pool, P_B, "done", "2026-08-22T15:00:00.000Z");
    });
    const rows = await getRecentBlockEpisodes();
    expect(rows.find((r) => r.portal === P_A)!.resolved_at).toBeNull();
    expect(rows.find((r) => r.portal === P_B)!.resolved_at).not.toBeNull();

    const active = activeBlocksByPortal(rows, Date.parse("2026-08-22T16:00:00Z"));
    expect(active.has(P_A)).toBe(true);
    expect(active.has(P_B)).toBe(false);
  });

  it("ignores a capture that predates the block", async () => {
    // A portal serving pages BEFORE the wall went up says nothing about the
    // wall. Strictly-after, or the very captures that led up to a block would
    // clear it on arrival.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T14:00:00.000Z");
      await capture(pool, P_A, "done", "2026-08-22T13:59:59.000Z");
    });
    expect(await resolvedAtFor(P_A)).toBeNull();
  });

  it("anchors on reported_at when the extension's clock ran slow", async () => {
    // `detected_at` is the extension's CLIENT clock (the schema says so);
    // `created_at` is the server's. A laptop an hour behind would report
    // detected_at=13:00 for a wall the server learned about at 14:00, and a
    // naive `created_at > detected_at` would let a 13:30 capture — captured
    // BEFORE the wall in real time — clear it. GREATEST(detected_at,
    // reported_at) keeps the comparison on the server clock.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T13:00:00.000Z", "2026-08-22T14:00:00.000Z");
      await capture(pool, P_A, "done", "2026-08-22T13:30:00.000Z");
    });
    expect(await resolvedAtFor(P_A)).toBeNull();

    // A capture after the SERVER-side report does clear it.
    await withRealDb((pool) => capture(pool, P_A, "done", "2026-08-22T14:30:00.000Z"));
    expect(await resolvedAtFor(P_A)).toBe("2026-08-22T14:30:00.000Z");
  });

  it("resolves against the NEWEST episode per portal, not the oldest", async () => {
    // Two walls, one recovery between them: the portal is walled again. The
    // read returns one row per portal (DISTINCT ON, PR #710) and it must be
    // the later episode, whose resolution is still open.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T10:00:00.000Z");
      await capture(pool, P_A, "done", "2026-08-22T11:00:00.000Z");
      await episode(pool, P_A, "2026-08-22T12:00:00.000Z");
    });
    const rows = await getRecentBlockEpisodes();
    const mine = rows.filter((r) => r.portal === P_A);
    expect(mine).toHaveLength(1);
    expect(mine[0].detected_at).toBe("2026-08-22T12:00:00.000Z");
    expect(mine[0].resolved_at).toBeNull();
    expect(activeBlocksByPortal(rows, Date.parse("2026-08-22T13:00:00Z")).has(P_A)).toBe(true);
  });

  it("uses the partial index rather than scanning the capture table", async () => {
    // idx_extension_capture_served exists only to serve this LATERAL. If a
    // future edit to the status list stops matching the index predicate the
    // plan silently degrades to a seq scan per portal, on a table already
    // adding thousands of rows a day — so assert the plan, not just the answer.
    await withRealDb(async (pool) => {
      await episode(pool, P_A, "2026-08-22T14:00:00.000Z");
      const res = await pool.query<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes
          WHERE indexname = 'idx_extension_capture_served'`,
      );
      expect(res.rows.length, "idx_extension_capture_served is missing").toBe(1);
      expect(res.rows[0].def).toMatch(/connector_name/);
      expect(res.rows[0].def).toMatch(/created_at/);
      // Same status set as the query's, or the index cannot serve it.
      for (const s of ["done", "withdrawn", "listing"]) {
        expect(res.rows[0].def).toContain(`'${s}'`);
      }
    });
  });
});
