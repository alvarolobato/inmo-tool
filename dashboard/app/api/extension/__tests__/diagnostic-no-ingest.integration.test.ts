/**
 * Real-Postgres integration test for issue #671's core safety property: the
 * "forzar captura + diagnóstico" endpoint is a DIAGNOSTIC channel, never an
 * ingest path. It must NEVER create or update a `listing`, NEVER enqueue a
 * `capture_worklist` entry, and NEVER touch `last_seen_at` — the exit
 * criterion the issue names explicitly ("A DB-backed test asserting no
 * listing/capture_worklist write").
 *
 * A mocked DB call (see diagnostic-route.test.ts) can prove the route CALLS
 * insertDiagnostic — it can't prove insertDiagnostic (or anything else on
 * this path) doesn't ALSO touch another table. Only a real schema + a real
 * row count before/after can prove that, which is what this file does:
 *   1. seed one real `listing` row (so "unaffected" means something — an
 *      empty table staying empty proves less than a real row's
 *      `last_seen_at`/`status` staying byte-for-byte unchanged),
 *   2. POST a diagnostic (with a network-capture block, exercising the full
 *      payload shape) against the real route handler,
 *   3. assert `extension_diagnostic` gained exactly one row with the
 *      expected fields, AND `listing`/`capture_worklist`/`extension_capture`
 *      are completely unchanged (row counts AND the seeded listing's own
 *      columns).
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a hard
 * failure (see AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool as resetWritePool } from "@/lib/db-write";
import { resetPool as resetReadPool } from "@/lib/db";
import { POST } from "../diagnostic/route";

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

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
        "REQUIRE_DB=1 but Postgres is unreachable for diagnostic-no-ingest.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[diagnostic-no-ingest.integration.test] no reachable Postgres - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const ADMIN_KEY = "diag-integration-test-key";
const TEST_URL = "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/extension/diagnostic", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
  });
}

describe.skipIf(!dbAvailable)("POST /api/extension/diagnostic — never an ingest path (real DB)", () => {
  let seededPropertyId: number;
  let seededListingId: number;
  let seededLastSeenAt: string;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    await withRealDb(async (pool) => {
      const propRes = await pool.query(
        `INSERT INTO property (address, m2_built) VALUES ($1, $2) RETURNING id`,
        ["Calle Falsa 123, Sevilla", 90],
      );
      seededPropertyId = propRes.rows[0].id;
      const listingRes = await pool.query(
        `INSERT INTO listing
           (property_id, source, external_id, url, operation, status, current_price, last_seen_at)
         VALUES ($1, 'hipoges', 'diag-test-1', $2, 'sale', 'active', 150000, NOW() - INTERVAL '3 days')
         RETURNING id, last_seen_at`,
        [seededPropertyId, TEST_URL],
      );
      seededListingId = listingRes.rows[0].id;
      seededLastSeenAt = listingRes.rows[0].last_seen_at.toISOString();
    });
  });

  afterAll(async () => {
    await withRealDb(async (pool) => {
      await pool.query(`DELETE FROM extension_diagnostic WHERE url = $1`, [TEST_URL]);
      await pool.query(`DELETE FROM listing WHERE id = $1`, [seededListingId]);
      await pool.query(`DELETE FROM property WHERE id = $1`, [seededPropertyId]);
    });
    await resetWritePool();
    await resetReadPool();
  });

  it("inserts into extension_diagnostic ONLY — listing/capture_worklist/extension_capture are byte-for-byte unchanged", async () => {
    const before = await withRealDb(async (pool) => {
      const listingCount = await pool.query(`SELECT COUNT(*)::int AS n FROM listing`);
      const worklistCount = await pool.query(`SELECT COUNT(*)::int AS n FROM capture_worklist`);
      const captureCount = await pool.query(`SELECT COUNT(*)::int AS n FROM extension_capture`);
      const diagnosticCount = await pool.query(`SELECT COUNT(*)::int AS n FROM extension_diagnostic`);
      return {
        listing: listingCount.rows[0].n,
        worklist: worklistCount.rows[0].n,
        capture: captureCount.rows[0].n,
        diagnostic: diagnosticCount.rows[0].n,
      };
    });

    const res = await POST(
      postReq({
        url: TEST_URL,
        html: "<html><body><main>shell</main></body></html>",
        title: "Hipoges listado",
        diagnostic: {
          detection: {
            detailPortal: null,
            listingPortal: "hipoges",
            supportedPortal: "hipoges",
            pageRole: "listing",
          },
          renderReady: { ready: true, selector: "main", reason: null, bodyTextLength: 500 },
          harvest: { anchorCount: 0, extractDetailUrlsCount: 0 },
          block: { blocked: false, signature: null },
          mode: { discoverSignalPresent: false, validationActive: false, autoCaptureEnabled: true },
          autoCaptureWouldFire: false,
        },
        network: {
          entries: [
            {
              url: "https://realestate.hipoges.com/api/assets/map",
              method: "POST",
              status: 200,
              type: "fetch",
              requestHeaders: {},
              responseHeaders: {},
              redactedHeaderCount: 1,
              redactedQueryParamCount: 0,
              body: "{}",
              bodyTruncated: false,
              bodyOriginalLength: 2,
              bodyReadable: true,
              startedAtMs: 10,
              finishedAtMs: 900,
            },
          ],
          droppedCount: 0,
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe("number");

    const after = await withRealDb(async (pool) => {
      const listingCount = await pool.query(`SELECT COUNT(*)::int AS n FROM listing`);
      const worklistCount = await pool.query(`SELECT COUNT(*)::int AS n FROM capture_worklist`);
      const captureCount = await pool.query(`SELECT COUNT(*)::int AS n FROM extension_capture`);
      const diagnosticCount = await pool.query(`SELECT COUNT(*)::int AS n FROM extension_diagnostic`);
      const seededListing = await pool.query(
        `SELECT status, last_seen_at, current_price FROM listing WHERE id = $1`,
        [seededListingId],
      );
      const diagnosticRow = await pool.query(
        `SELECT url, html, detection, network, network_dropped_count, html_bytes
           FROM extension_diagnostic WHERE id = $1`,
        [body.id],
      );
      return {
        listing: listingCount.rows[0].n,
        worklist: worklistCount.rows[0].n,
        capture: captureCount.rows[0].n,
        diagnostic: diagnosticCount.rows[0].n,
        seededListing: seededListing.rows[0],
        diagnosticRow: diagnosticRow.rows[0],
      };
    });

    // The core safety property: NOTHING in the ingest tables changed.
    expect(after.listing).toBe(before.listing);
    expect(after.worklist).toBe(before.worklist);
    expect(after.capture).toBe(before.capture);
    expect(after.seededListing.status).toBe("active");
    expect(after.seededListing.last_seen_at.toISOString()).toBe(seededLastSeenAt);
    expect(Number(after.seededListing.current_price)).toBe(150000);

    // ...while extension_diagnostic gained EXACTLY one row, with the payload
    // stored intact (JSONB round-trips, network entry count preserved).
    expect(after.diagnostic).toBe(before.diagnostic + 1);
    expect(after.diagnosticRow.url).toBe(TEST_URL);
    expect(after.diagnosticRow.html).toContain("shell");
    expect(after.diagnosticRow.detection.detection.listingPortal).toBe("hipoges");
    expect(after.diagnosticRow.detection.renderReady.selector).toBe("main");
    expect(after.diagnosticRow.network.entries).toHaveLength(1);
    expect(after.diagnosticRow.network_dropped_count).toBe(0);
    expect(after.diagnosticRow.html_bytes).toBeGreaterThan(0);
  });
});
