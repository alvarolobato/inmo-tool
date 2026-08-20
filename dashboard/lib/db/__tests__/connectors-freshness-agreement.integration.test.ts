/**
 * Real-Postgres integration test for issue #586 review finding B1:
 * `getConnectorFreshness()` (`lib/db/freshness.ts`) and the
 * `/etl/connectors` per-connector pill (`listConnectors()`, `lib/db/
 * connectors.ts`) must never structurally disagree on a capture-only
 * portal's freshness state (D-125).
 *
 * AMENDMENT (issue #638, D-144) — this title is no longer literally "the
 * TopBar dot": `components/FreshnessContext.tsx` was repointed away from
 * `getConnectorFreshness()`/`/api/data-health` to the new listing-derived
 * source-health model (`/api/etl/source-health`) — a DIFFERENT question
 * ("has this connector had real DATA activity") than the one this file's
 * two functions still answer ("has this connector's discovery CYCLE
 * completed", D-050). `getConnectorFreshness()` itself is UNCHANGED and
 * still backs `/api/data-health`, `/api/ready`, and `/etl/salud`, so THIS
 * test's own invariant (those two functions agree with each other) still
 * holds and is still worth guarding. What no longer holds, BY DESIGN, is
 * "the TopBar dot agrees with `/etl/connectors`' pill" — they can now
 * legitimately show different things for the same connector (e.g. a
 * cycle-incomplete-but-actually-fresh source), and that divergence is not a
 * bug to chase; #590's original lesson (two surfaces silently answering
 * different questions from different inputs) is still respected here
 * because this file is honest about which two surfaces it covers.
 *

 * Why this needed its own test: before this fix, `listConnectors()` derived
 * a capture-only portal's freshness from `connector_freshness_state` alone —
 * a table that has NO rows at all for a connector whose crawl never runs
 * (idealista/aliseda/altamira/hipoges in production, verified live). That
 * connector's `state` always resolved to `due, sin ciclo iniciado`
 * — coincidentally "stale"-looking, but for the wrong reason, and wrong the
 * moment the portal actually IS fresh (e.g. captured 2h ago): the pill kept
 * saying "obsoleto, sin ciclo iniciado" while `getConnectorFreshness()`
 * correctly said "fresh". Same class of lie #586 opened, one click deeper.
 *
 * Both functions now share ONE definition (`resolveConnectorFreshnessState`,
 * `lib/db/connectors.ts`) — this test proves that sharing actually holds by
 * calling both and comparing their verdicts directly, for both a fresh and a
 * stale capture-only portal.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a
 * hard failure (see AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool as resetWritePool } from "@/lib/db-write";
import { resetPool as resetReadPool } from "@/lib/db";
import { getConnectorFreshness } from "../freshness";
import { listConnectors } from "../connectors";

// Real CAPTURE_PORTALS names — isCaptureOnlyForFreshness() requires
// isCapturePortal(), so a synthetic name would never enter the capture
// branch either function is testing agreement on.
const CAP_ALISEDA = "aliseda";
const CAP_ALTAMIRA = "altamira";

const HOUR_MS = 60 * 60 * 1000;

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for " +
          "connectors-freshness-agreement.integration.test.ts: " +
          String(err),
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[connectors-freshness-agreement.integration.test] no reachable Postgres " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

async function seedCaptureOnlyPortal(
  pool: Pool,
  connector: string,
  opts: { freshnessIntervalHours?: number | null } = {},
): Promise<void> {
  const { freshnessIntervalHours = 24 } = opts;
  await pool.query(
    `INSERT INTO connector_registry (connector_name, registered, supports_discovery)
     VALUES ($1, true, false)
     ON CONFLICT (connector_name) DO UPDATE
        SET registered = true, supports_discovery = false`,
    [connector],
  );
  await pool.query(
    `INSERT INTO connector_config (connector_name, enabled, capture_enabled, freshness_interval_hours)
     VALUES ($1, false, true, $2)
     ON CONFLICT (connector_name) DO UPDATE
        SET enabled = false, capture_enabled = true,
            freshness_interval_hours = EXCLUDED.freshness_interval_hours`,
    [connector, freshnessIntervalHours],
  );
}

async function seedCapture(
  pool: Pool,
  connector: string,
  status: "done" | "failed",
  createdAgoMs: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO extension_capture (url, connector_name, status, created_at)
     VALUES ($1, $2, $3, NOW() - ($4::double precision * interval '1 millisecond'))`,
    [`https://example.com/${connector}/${createdAgoMs}`, connector, status, createdAgoMs],
  );
}

describe.runIf(dbAvailable)(
  "issue #586 review B1 — dot and /etl/connectors pill agree on capture-only portals",
  () => {
    afterAll(async () => {
      await resetWritePool();
      await resetReadPool();
    });

    afterEach(async () => {
      await withRealDb(async (pool) => {
        const names = [CAP_ALISEDA, CAP_ALTAMIRA];
        await pool.query("DELETE FROM extension_capture WHERE connector_name = ANY($1)", [
          names,
        ]);
        await pool.query("DELETE FROM connector_freshness_state WHERE connector_name = ANY($1)", [
          names,
        ]);
        await pool.query("DELETE FROM connector_config WHERE connector_name = ANY($1)", [names]);
        await pool.query("DELETE FROM connector_registry WHERE connector_name = ANY($1)", [
          names,
        ]);
      });
    });

    it("a FRESH capture-only portal reads fresh on BOTH surfaces, not 'obsoleto, sin ciclo iniciado' on the pill", async () => {
      await withRealDb(async (pool) => {
        await seedCaptureOnlyPortal(pool, CAP_ALISEDA);
        await seedCapture(pool, CAP_ALISEDA, "done", 2 * HOUR_MS);
      });

      const [health, connectors] = await Promise.all([getConnectorFreshness(), listConnectors()]);
      const dotEntry = health.connectors.find((c) => c.connector === CAP_ALISEDA)!;
      const pillEntry = connectors.find((c) => c.name === CAP_ALISEDA)!;

      // The dot's verdict (this is what #586 originally fixed).
      expect(dotEntry.state).toBe("fresh");
      expect(dotEntry.isStale).toBe(false);

      // The pill MUST agree — before B1's fix this read "due" (no
      // connector_freshness_state row exists for a capture-only portal at
      // all) regardless of how recently it was actually captured.
      expect(pillEntry.freshness.kind).toBe("fresh");
      expect(pillEntry.freshness.lastFreshAt).toBe(dotEntry.lastSuccessAt);
    });

    it("a STALE capture-only portal reads due on BOTH surfaces, with the same lastFreshAt", async () => {
      await withRealDb(async (pool) => {
        await seedCaptureOnlyPortal(pool, CAP_ALTAMIRA);
        await seedCapture(pool, CAP_ALTAMIRA, "done", 11 * 24 * HOUR_MS);
      });

      const [health, connectors] = await Promise.all([getConnectorFreshness(), listConnectors()]);
      const dotEntry = health.connectors.find((c) => c.connector === CAP_ALTAMIRA)!;
      const pillEntry = connectors.find((c) => c.name === CAP_ALTAMIRA)!;

      expect(dotEntry.state).toBe("due");
      expect(dotEntry.isStale).toBe(true);

      expect(pillEntry.freshness.kind).toBe("due");
      expect(pillEntry.freshness.lastFreshAt).toBe(dotEntry.lastSuccessAt);
      expect(pillEntry.freshness.lastFreshAt).not.toBeNull();
    });
  },
);
