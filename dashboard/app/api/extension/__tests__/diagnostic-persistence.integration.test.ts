/**
 * Real-Postgres tests for how a diagnostic is STORED and how it ages out —
 * both findings from the PR #675 review. The sibling
 * diagnostic-no-ingest.integration.test.ts covers the other real-DB
 * property (that this route never touches an ingest table).
 *
 * B4 — NUL bytes crash the insert. The route sanitised `url`/`html`/`title`
 * with `stripNulBytes` but handed `detection`/`network` straight to
 * `JSON.stringify` for two `jsonb` columns. Captured network bodies come
 * from arbitrary `responseText`, so this was the exact production failure
 * issue #207 / PR #563 fixed for `text`, reopened one layer in for JSONB —
 * with a different error ("unsupported Unicode escape sequence") that no
 * existing guard covered. Only a real Postgres can prove the fix: a mocked
 * DB accepts anything, and the failure is in Postgres's own jsonb parser,
 * not in JS.
 *
 * S4 — no retention story. `extension_diagnostic` had no purge, no cap and
 * no expiry, storing whole third-party pages (~350 KB, routinely carrying
 * owner names and phone numbers) forever. `purge_extension_diagnostics()`
 * is modelled on this schema's existing `purge_stale_owner_identities()`.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a
 * hard failure (see AGENTS.md / etl/tests/conftest.py's contract).
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
        "REQUIRE_DB=1 but Postgres is unreachable for diagnostic-persistence.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[diagnostic-persistence.integration.test] no reachable Postgres - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const ADMIN_KEY = "diag-persistence-test-key";
const URL_PREFIX = "https://realestate.hipoges.com/e2e-persistence/";
// Built at runtime so this source file carries no control character.
const NUL = String.fromCharCode(0);
const REPLACEMENT = "�";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4000/api/extension/diagnostic", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
  });
}

describe.skipIf(!dbAvailable)("extension_diagnostic persistence (real DB)", () => {
  beforeAll(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterAll(async () => {
    await withRealDb(async (pool) => {
      await pool.query(`DELETE FROM extension_diagnostic WHERE url LIKE $1`, [`${URL_PREFIX}%`]);
    });
    await resetWritePool();
    await resetReadPool();
  });

  describe("B4 — a NUL anywhere in the payload must not lose the diagnostic", () => {
    it("stores a detection/network block containing NUL, substituting U+FFFD", async () => {
      const url = `${URL_PREFIX}nul-jsonb`;
      const res = await POST(
        postReq({
          url,
          // The text columns were already covered; included so this asserts
          // the WHOLE payload survives, not just the newly-fixed half.
          html: `<html><body>saldo${NUL}oculto</body></html>`,
          title: `Listado${NUL}Hipoges`,
          diagnostic: {
            extensionVersion: "0.16.0",
            detection: { listingPortal: "hipoges", pageRole: "listing" },
            renderReady: {
              ready: false,
              selector: null,
              // A `reason` is built from page text, so it can carry one too.
              reason: `sin selector${NUL} coincidente`,
              bodyTextLength: 12,
            },
            harvest: { anchorCount: 17, extractDetailUrlsCount: 0 },
          },
          network: {
            entries: [
              {
                url: `https://realestate.hipoges.com/api/list?page=1`,
                method: "GET",
                status: 200,
                type: "fetch",
                // The realistic source of a NUL: an arbitrary responseText.
                body: `{"items":["a${NUL}b"]}`,
                bodyTruncated: false,
                startedAtMs: 10,
                finishedAtMs: 900,
              },
            ],
            droppedCount: 0,
          },
        }),
      );

      // Before the fix this was a 500: Postgres rejected the INSERT with
      // 'unsupported Unicode escape sequence' and the capture was lost.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const row = await withRealDb(async (pool) => {
        const r = await pool.query(
          `SELECT html, title, detection, network FROM extension_diagnostic WHERE id = $1`,
          [body.id],
        );
        return r.rows[0];
      });

      // Substituted, not dropped — offsets are preserved, same as the
      // `text` path's contract.
      expect(row.detection.renderReady.reason).toBe(`sin selector${REPLACEMENT} coincidente`);
      expect(row.network.entries[0].body).toBe(`{"items":["a${REPLACEMENT}b"]}`);
      expect(row.html).toContain(`saldo${REPLACEMENT}oculto`);
      expect(row.title).toBe(`Listado${REPLACEMENT}Hipoges`);

      // Everything else round-tripped untouched — the sanitiser is surgical.
      expect(row.detection.harvest.extractDetailUrlsCount).toBe(0);
      expect(row.detection.harvest.anchorCount).toBe(17);
      expect(row.detection.renderReady.ready).toBe(false);
      expect(row.network.entries[0].status).toBe(200);
    });

    it("stores a NUL appearing in a JSON object KEY (a jsonb key is text too)", async () => {
      const url = `${URL_PREFIX}nul-key`;
      const res = await POST(
        postReq({
          url,
          html: "<html></html>",
          diagnostic: { detection: {}, [`odd${NUL}key`]: "value" },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      const detection = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT detection FROM extension_diagnostic WHERE id = $1`, [
          body.id,
        ]);
        return r.rows[0].detection;
      });
      expect(Object.keys(detection)).toContain(`odd${REPLACEMENT}key`);
    });

    it("still stores a completely clean payload byte-for-byte", async () => {
      const url = `${URL_PREFIX}clean`;
      const res = await POST(
        postReq({
          url,
          html: "<html><body><main>shell</main></body></html>",
          diagnostic: { renderReady: { ready: true, selector: "main", reason: "match" } },
          network: null,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      const row = await withRealDb(async (pool) => {
        const r = await pool.query(
          `SELECT html, detection, network FROM extension_diagnostic WHERE id = $1`,
          [body.id],
        );
        return r.rows[0];
      });
      expect(row.html).toBe("<html><body><main>shell</main></body></html>");
      expect(row.detection.renderReady.selector).toBe("main");
      expect(row.network).toBeNull();
    });
  });

  describe("S4 — purge_extension_diagnostics gives the table a retention floor", () => {
    it("deletes rows older than retention_days, keeps newer ones, and reports the count", async () => {
      const oldUrl = `${URL_PREFIX}purge-old`;
      const freshUrl = `${URL_PREFIX}purge-fresh`;

      const ids = await withRealDb(async (pool) => {
        const old = await pool.query(
          `INSERT INTO extension_diagnostic (url, html, html_bytes, created_at)
           VALUES ($1, '<html></html>', 13, NOW() - INTERVAL '45 days') RETURNING id`,
          [oldUrl],
        );
        const fresh = await pool.query(
          `INSERT INTO extension_diagnostic (url, html, html_bytes, created_at)
           VALUES ($1, '<html></html>', 13, NOW() - INTERVAL '2 days') RETURNING id`,
          [freshUrl],
        );
        return { old: old.rows[0].id, fresh: fresh.rows[0].id };
      });

      const purged = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT purge_extension_diagnostics() AS n`);
        return Number(r.rows[0].n);
      });

      // At least our seeded 45-day-old row; other rows in a shared DB may
      // legitimately age out in the same call, so this is a floor.
      expect(purged).toBeGreaterThanOrEqual(1);

      const survivors = await withRealDb(async (pool) => {
        const r = await pool.query(
          `SELECT id FROM extension_diagnostic WHERE id = ANY($1::bigint[])`,
          [[ids.old, ids.fresh]],
        );
        return r.rows.map((row) => Number(row.id));
      });
      expect(survivors).not.toContain(ids.old);
      expect(survivors).toContain(ids.fresh);
    });

    it("honours an explicit retention_days argument", async () => {
      const url = `${URL_PREFIX}purge-explicit`;
      const id = await withRealDb(async (pool) => {
        const r = await pool.query(
          `INSERT INTO extension_diagnostic (url, html, html_bytes, created_at)
           VALUES ($1, '<html></html>', 13, NOW() - INTERVAL '10 days') RETURNING id`,
          [url],
        );
        return Number(r.rows[0].id);
      });

      // The default is 30 days, so a 10-day-old row must survive it...
      await withRealDb((pool) => pool.query(`SELECT purge_extension_diagnostics()`));
      let alive = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT 1 FROM extension_diagnostic WHERE id = $1`, [id]);
        return r.rowCount === 1;
      });
      expect(alive, "a 10-day-old row survives the 30-day default").toBe(true);

      // ...and be removed by an explicit tighter window.
      const purged = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT purge_extension_diagnostics(5) AS n`);
        return Number(r.rows[0].n);
      });
      expect(purged).toBeGreaterThanOrEqual(1);
      alive = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT 1 FROM extension_diagnostic WHERE id = $1`, [id]);
        return r.rowCount === 1;
      });
      expect(alive, "purge_extension_diagnostics(5) removes it").toBe(false);
    });

    it("returns 0 and touches nothing when everything is within retention", async () => {
      await withRealDb((pool) => pool.query(`SELECT purge_extension_diagnostics(1)`));
      const url = `${URL_PREFIX}purge-noop`;
      const id = await withRealDb(async (pool) => {
        const r = await pool.query(
          `INSERT INTO extension_diagnostic (url, html, html_bytes) VALUES ($1, '<html></html>', 13)
           RETURNING id`,
          [url],
        );
        return Number(r.rows[0].id);
      });

      const purged = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT purge_extension_diagnostics(30) AS n`);
        return Number(r.rows[0].n);
      });
      expect(purged).toBe(0);

      const alive = await withRealDb(async (pool) => {
        const r = await pool.query(`SELECT 1 FROM extension_diagnostic WHERE id = $1`, [id]);
        return r.rowCount === 1;
      });
      expect(alive).toBe(true);
    });
  });
});
