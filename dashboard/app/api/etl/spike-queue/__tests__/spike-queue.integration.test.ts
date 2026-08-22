/**
 * Real-Postgres integration test for issue #705's core safety property.
 *
 * A prospective-site capture MUST NOT pretend to be a listing. There is no
 * connector for its host, so nothing can normalise it; it must therefore
 * create no `listing`, no `property`, no `extension_capture` and no
 * `capture_worklist` row, and it must never land on a `failed` status
 * anywhere. "We deliberately captured a page from a site we don't support" is
 * a clean outcome, and this file is what proves it stays one.
 *
 * A mocked test can prove the routes CALL the right helpers; only a real
 * schema with real row counts before/after can prove nothing else was
 * touched. Same reasoning (and same skip contract) as
 * diagnostic-no-ingest.integration.test.ts.
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
import { POST as POST_SPIKE, GET as GET_SPIKE } from "../route";
import { PATCH as PATCH_SPIKE } from "../[id]/route";
import { POST as POST_DIAGNOSTIC } from "../../../extension/diagnostic/route";
import { MAX_SPIKE_ATTEMPTS } from "@/lib/spike-queue";

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
        "REQUIRE_DB=1 but Postgres is unreachable for spike-queue.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn("[spike-queue.integration.test] no reachable Postgres - skipping real-DB tests.");
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const ADMIN_KEY = "spike-integration-test-key";
const SITE = "Sitio De Prueba 705";
// A host no capture connector claims — the whole premise of the feature. Kept
// obviously fake so nothing here can be mistaken for a real portal fixture.
const SPIKE_URL = "https://www.ejemplo-portal-705.test/inmueble/abc-123";
const SPIKE_URL_2 = "https://www.ejemplo-portal-705.test/inmueble/def-456";

function jsonReq(path: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:4000${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
  });
}

async function counts(pool: Pool) {
  const q = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
  return {
    listing: await q(`SELECT COUNT(*)::int AS n FROM listing`),
    property: await q(`SELECT COUNT(*)::int AS n FROM property`),
    worklist: await q(`SELECT COUNT(*)::int AS n FROM capture_worklist`),
    capture: await q(`SELECT COUNT(*)::int AS n FROM extension_capture`),
    diagnostic: await q(`SELECT COUNT(*)::int AS n FROM extension_diagnostic`),
  };
}

describe.skipIf(!dbAvailable)("prospective-site capture queue (real DB, issue #705)", () => {
  beforeAll(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterAll(async () => {
    await withRealDb(async (pool) => {
      await pool.query(`DELETE FROM extension_diagnostic WHERE url LIKE '%ejemplo-portal-705%'`);
      await pool.query(`DELETE FROM capture_spike_request WHERE site_label = $1`, [SITE]);
    });
    await resetWritePool();
    await resetReadPool();
  });

  it("queues an unsupported host, captures it into extension_diagnostic, and touches NOTHING on the ingest path", async () => {
    const before = await withRealDb(counts);

    // 1. Queue it.
    const addRes = await POST_SPIKE(
      jsonReq("/api/etl/spike-queue", "POST", { urls: SPIKE_URL, siteLabel: SITE }),
    );
    expect(addRes.status).toBe(200);
    expect((await addRes.json()).added).toBe(1);

    // 2. The extension delivers the page to the DIAGNOSTIC channel — the same
    //    route and payload shape the #675 manual button already uses. No extra
    //    field says "this was queued": correlation is by the canonical match
    //    key, so the extension needs no new contract for it.
    const diagRes = await POST_DIAGNOSTIC(
      jsonReq("/api/extension/diagnostic", "POST", {
        // Cosmetically different from the queued URL on purpose (trailing
        // slash + query) — correlation must survive that, or a real capture
        // would silently fail to close its own queue row.
        url: SPIKE_URL + "/?utm_source=x",
        html: "<html><body><main>ficha</main></body></html>",
        title: "Ficha de prueba",
      }),
    );
    expect(diagRes.status).toBe(200);
    const diagBody = await diagRes.json();
    expect(typeof diagBody.id).toBe("number");
    expect(typeof diagBody.spikeRequestId).toBe("number");

    const after = await withRealDb(async (pool) => {
      const c = await counts(pool);
      const spike = await pool.query(
        `SELECT status, matched_diagnostic_id, attempts, host, site_label
           FROM capture_spike_request WHERE site_label = $1`,
        [SITE],
      );
      return { ...c, spike: spike.rows };
    });

    // The core safety property.
    expect(after.listing).toBe(before.listing);
    expect(after.property).toBe(before.property);
    expect(after.worklist).toBe(before.worklist);
    expect(after.capture).toBe(before.capture);
    // The page itself DID land, in the one store that has a retention policy.
    expect(after.diagnostic).toBe(before.diagnostic + 1);

    expect(after.spike).toHaveLength(1);
    expect(after.spike[0].status).toBe("captured");
    expect(after.spike[0].matched_diagnostic_id).toBe(diagBody.id);
    expect(after.spike[0].host).toBe("ejemplo-portal-705.test");
  });

  it("refuses a supported-portal host — the anti-typo guard, enforced server-side", async () => {
    const res = await POST_SPIKE(
      jsonReq("/api/etl/spike-queue", "POST", {
        urls: "https://www.idealista.com/inmueble/1/",
        siteLabel: SITE,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(0);
    expect(body.invalid[0].reason).toContain("idealista");
  });

  it("requires a site label — naming the candidate site is the second deliberate act", async () => {
    const res = await POST_SPIKE(
      jsonReq("/api/etl/spike-queue", "POST", { urls: SPIKE_URL_2, siteLabel: "  " }),
    );
    expect(res.status).toBe(400);
  });

  it("gives up as 'unreachable', never 'failed', after MAX_SPIKE_ATTEMPTS", async () => {
    const addRes = await POST_SPIKE(
      jsonReq("/api/etl/spike-queue", "POST", { urls: SPIKE_URL_2, siteLabel: SITE }),
    );
    expect((await addRes.json()).added).toBe(1);

    const id = await withRealDb(async (pool) => {
      const r = await pool.query(
        `SELECT id FROM capture_spike_request WHERE url = $1`,
        [SPIKE_URL_2],
      );
      return r.rows[0].id as number;
    });

    let status = "pending";
    for (let i = 0; i < MAX_SPIKE_ATTEMPTS; i++) {
      const res = await PATCH_SPIKE(
        jsonReq(`/api/etl/spike-queue/${id}`, "PATCH", { attempt: true }),
        { params: Promise.resolve({ id: String(id) }) },
      );
      expect(res.status).toBe(200);
      status = (await res.json()).status;
    }
    expect(status).toBe("unreachable");

    // Re-queueing clears the counter, or the row would be handed back already
    // at the limit and never actually retried.
    const requeue = await PATCH_SPIKE(
      jsonReq(`/api/etl/spike-queue/${id}`, "PATCH", { status: "pending" }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(requeue.status).toBe(200);
    const requeued = await withRealDb(async (pool) =>
      (await pool.query(`SELECT status, attempts FROM capture_spike_request WHERE id = $1`, [id]))
        .rows[0],
    );
    expect(requeued.status).toBe("pending");
    expect(requeued.attempts).toBe(0);
  });

  it("the CHECK constraint itself refuses a 'failed' status", async () => {
    await withRealDb(async (pool) => {
      await expect(
        pool.query(
          `INSERT INTO capture_spike_request (url, match_key, host, site_label, status)
             VALUES ('https://x.test/1', 'x.test/1', 'x.test', $1, 'failed')`,
          [SITE],
        ),
      ).rejects.toThrow();
    });
  });

  it("GET exposes the pending origins the extension needs a host permission for", async () => {
    const res = await GET_SPIKE();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.pendingOrigins)).toBe(true);
    expect(body.pendingOrigins).toContain("https://www.ejemplo-portal-705.test");
  });
});
