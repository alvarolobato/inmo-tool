/**
 * Real-Postgres integration test for cohort re-capture (issue #677).
 *
 * A mocked-`sql()` unit test cannot prove any of the three things that
 * actually matter here, because all three are properties of the data after the
 * write lands:
 *
 *   1. A requeued row stays distinguishable from a never-captured one — both
 *      sit at status 'pending', and that distinction has to survive an
 *      interrupted pass, i.e. it has to be IN THE ROW, not in memory.
 *   2. The count the operator confirmed is the count that flips. This is a
 *      bulk write against thousands of rows; "preview said 2,800, wrote 2,795"
 *      is exactly the failure mode a count-then-confirm UI exists to prevent.
 *   3. The cohort predicates actually select what they claim, through the
 *      real `worklistMatchKey` correlation (there is no FK between `listing`
 *      and `capture_worklist`).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";

/**
 * A passthrough wrapper around the real `sql()`, with one hook: a test can
 * install a callback that fires right after a chosen query resolves, so the
 * database can be mutated BETWEEN two statements of a single call.
 *
 * That interleaving is the only way to reach the UPDATE's `AND w.status = $4`
 * guard. The cohort resolver already excludes non-'captured' rows, so in
 * normal operation the guard never fires — it exists for the window between
 * "resolve the cohort" and "flip it", when another surface (or another tab)
 * can move a row underneath the write. Default is a plain passthrough, so
 * every other test in this file talks to the real module unchanged.
 */
const sqlHook: { after: ((sqlText: string) => Promise<void>) | null } =
  vi.hoisted(() => ({ after: null }));

vi.mock("@/lib/db-write", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/db-write")>();
  return {
    ...mod,
    sql: async (text: string, params?: unknown[]) => {
      const out = await mod.sql(text, params as never);
      if (sqlHook.after) await sqlHook.after(text);
      return out;
    },
  };
});
import {
  previewRecaptureCohort,
  requeueRecaptureCohort,
} from "@/lib/db/recapture";
import { listWorklist } from "@/lib/db/worklist";
import type { RecaptureCohortRequest } from "@/lib/recapture";

/** Every fixture URL carries this marker so cleanup can never touch real rows. */
const MARK = "677000";
const HOST = "https://www.idealista.com";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[recapture.integration.test] no reachable Postgres - skipping real-DB tests.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

const pool = dbAvailable ? new Pool(buildPgPoolConfig({ max: 4 })) : null;

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM capture_worklist WHERE url LIKE $1`, [
    `%${MARK}%`,
  ]);
  await pool.query(`DELETE FROM extension_capture WHERE url LIKE $1`, [
    `%${MARK}%`,
  ]);
  await pool.query(
    `DELETE FROM profile_listing_state WHERE property_id IN
       (SELECT property_id FROM listing WHERE external_id LIKE $1)`,
    [`${MARK}%`],
  );
  // listing before property: listing.property_id is a NOT NULL FK.
  const props = await pool.query<{ property_id: number }>(
    `SELECT property_id FROM listing WHERE external_id LIKE $1`,
    [`${MARK}%`],
  );
  await pool.query(`DELETE FROM listing WHERE external_id LIKE $1`, [
    `${MARK}%`,
  ]);
  const propertyIds = props.rows.map((r) => r.property_id);
  if (propertyIds.length > 0) {
    await pool.query(`DELETE FROM property WHERE id = ANY($1)`, [propertyIds]);
  }
  await pool.query(`DELETE FROM search_profile WHERE name = $1`, [
    "e2e-677-profile",
  ]);
  await pool.query(`DELETE FROM connector_config WHERE connector_name = $1`, [
    "idealista",
  ]);
  await pool.query(`DELETE FROM connector_registry WHERE connector_name = $1`, [
    "idealista",
  ]);
}

interface Fixture {
  /** Suffix making the URL/external_id unique. */
  n: number;
  photos: number;
  /** null = no profile_listing_state row at all. */
  score: number | null;
  matched?: boolean;
  stage?: string;
  worklistStatus?: string;
  requeuedAt?: string | null;
  /**
   * Pre-set `requeue_rank`. Settable independently of `worklistStatus` on
   * purpose: the ORDER BY only honours a rank on a 'pending' row, and the only
   * way to test that gate is to seed a rank onto a row that is NOT pending —
   * exactly what a cohort looks like once part of it has been re-captured.
   */
  requeueRank?: number | null;
}

/**
 * Seed a listing + its worklist row. The worklist row's `match_key` is written
 * the way the seeding path writes it, so the correlation under test is the
 * real one.
 */
async function seed(f: Fixture, profileId: number | null): Promise<void> {
  if (!pool) return;
  const externalId = `${MARK}${f.n}`;
  const url = `${HOST}/inmueble/${externalId}/`;
  const photos = Array.from(
    { length: f.photos },
    (_, i) => `${HOST}/photo/${externalId}-${i}.jpg`,
  );
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property DEFAULT VALUES RETURNING id`,
  );
  const propertyId = prop.rows[0].id;
  await pool.query(
    `INSERT INTO listing (property_id, source, external_id, url, status, operation, photo_urls)
     VALUES ($1, 'idealista', $2, $3, 'active', 'sale', $4)`,
    [propertyId, externalId, url, photos],
  );
  if (f.score !== null && profileId !== null) {
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, score, matched, pipeline_stage)
       VALUES ($1, $2, $3, $4, $5)`,
      [profileId, propertyId, f.score, f.matched ?? true, f.stage ?? "new"],
    );
  }
  await pool.query(
    `INSERT INTO capture_worklist (url, match_key, source_portal, status, added_via, requeued_at, requeue_rank)
     VALUES ($1, $2, 'idealista', $3, 'derived', $4, $5)`,
    [
      url,
      `idealista.com/inmueble/${externalId}`,
      f.worklistStatus ?? "captured",
      f.requeuedAt ?? null,
      f.requeueRank ?? null,
    ],
  );
}

async function seedProfile(): Promise<number> {
  const r = await pool!.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope) VALUES ('e2e-677-profile', '{}'::jsonb) RETURNING id`,
  );
  return r.rows[0].id;
}

const req = (
  over: Partial<RecaptureCohortRequest> = {},
): RecaptureCohortRequest => ({
  portal: "idealista",
  predicate: "few_photos",
  threshold: 4,
  onlyLiveCandidates: true,
  ...over,
});

async function worklistRow(n: number) {
  const r = await pool!.query(
    `SELECT status, requeued_at, requeue_reason, requeue_rank
       FROM capture_worklist WHERE url LIKE $1`,
    [`%${MARK}${n}%`],
  );
  return r.rows[0];
}

beforeEach(async () => {
  sqlHook.after = null;
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
    await pool?.end().catch(() => {});
  }
});

describe.skipIf(!dbAvailable)("previewRecaptureCohort", () => {
  it("selects captured rows whose listing has too few photos", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed({ n: 2, photos: 3, score: 0.8 }, p);
    await seed({ n: 3, photos: 20, score: 0.7 }, p); // enough photos

    const preview = await previewRecaptureCohort(req());
    expect(preview.rowCount).toBe(2);
    expect(preview.listingCount).toBe(2);
  });

  it("leaves skipped, stale, failed and already-pending rows alone", async () => {
    // A bulk cohort must never overturn a per-row decision the owner made,
    // and must not re-rank a row that is already queued.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    for (const [i, status] of [
      "skipped",
      "stale",
      "failed",
      "pending",
    ].entries()) {
      await seed(
        { n: 10 + i, photos: 3, score: 0.9, worklistStatus: status },
        p,
      );
    }
    const preview = await previewRecaptureCohort(req());
    expect(preview.rowCount).toBe(1);
  });

  it("excludes non-candidates when onlyLiveCandidates is on, and includes them when off", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p); // live candidate
    await seed({ n: 2, photos: 3, score: 0.5, matched: false }, p); // unmatched
    await seed({ n: 3, photos: 3, score: 0.5, stage: "rejected" }, p);
    await seed({ n: 4, photos: 3, score: null }, null); // never scored

    expect((await previewRecaptureCohort(req())).rowCount).toBe(1);
    expect(
      (await previewRecaptureCohort(req({ onlyLiveCandidates: false })))
        .rowCount,
    ).toBe(4);
  });

  it("counts how many of the cohort have already been requeued before", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed(
      { n: 2, photos: 3, score: 0.8, requeuedAt: new Date().toISOString() },
      p,
    );
    const preview = await previewRecaptureCohort(req());
    expect(preview.rowCount).toBe(2);
    expect(preview.alreadyRequeuedCount).toBe(1);
  });

  it("never_requeued drops rows that already carry a requeue", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed(
      { n: 2, photos: 3, score: 0.8, requeuedAt: new Date().toISOString() },
      p,
    );
    const preview = await previewRecaptureCohort(
      req({ predicate: "never_requeued", threshold: null }),
    );
    expect(preview.rowCount).toBe(1);
  });

  it("excludes a portal the owner has switched off (D-055)", async () => {
    // "Live candidate" has to mean the same thing here as in the list feed
    // (candidates.ts) and the map feed (map-candidates.ts), all three of which
    // hide listings whose connector is off. Idealista is capture-only
    // (`supports_discovery = false`), so its off-switch is `capture_enabled`.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    expect((await previewRecaptureCohort(req())).rowCount).toBe(1);

    await pool!.query(
      `INSERT INTO connector_registry (connector_name, supports_discovery)
       VALUES ('idealista', false)
       ON CONFLICT (connector_name)
         DO UPDATE SET supports_discovery = EXCLUDED.supports_discovery`,
    );
    await pool!.query(
      `INSERT INTO connector_config (connector_name, capture_enabled)
       VALUES ('idealista', false)
       ON CONFLICT (connector_name)
         DO UPDATE SET capture_enabled = EXCLUDED.capture_enabled`,
    );

    expect((await previewRecaptureCohort(req())).rowCount).toBe(0);
    // And the write agrees with the preview — no requeueing a dead portal.
    expect((await requeueRecaptureCohort(req(), "motivo", 0)).requeued).toBe(0);
    expect((await worklistRow(1)).status).toBe("captured");

    // Switching it back on restores the cohort, so this is the toggle doing
    // the work and not some unrelated side effect of writing those rows.
    await pool!.query(
      `UPDATE connector_config SET capture_enabled = true WHERE connector_name = 'idealista'`,
    );
    expect((await previewRecaptureCohort(req())).rowCount).toBe(1);
  });

  it("writes nothing — the preview is what the operator runs before deciding", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await previewRecaptureCohort(req());
    expect((await worklistRow(1)).status).toBe("captured");
    expect((await worklistRow(1)).requeued_at).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("the storage estimate", () => {
  /** A 'done' extension_capture for the portal, optionally still holding HTML. */
  async function seedCapture(n: number, html: string | null): Promise<void> {
    await pool!.query(
      `INSERT INTO extension_capture (url, html, connector_name, status)
       VALUES ($1, $2, 'idealista', 'done')`,
      [`${HOST}/inmueble/${MARK}${n}/`, html],
    );
  }

  it("reports retention OFF, and zero cost, when no recent capture kept its HTML", async () => {
    // The dashboard cannot read ETL_RETAIN_CAPTURE_HTML_FOR (D-150) — it
    // infers retention from what the ETL actually left behind. Every 'done'
    // capture here was nulled out, so a re-capture pass stores nothing and the
    // panel must not cry wolf about database growth.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seedCapture(1, null);
    await seedCapture(2, null);

    const preview = await previewRecaptureCohort(req());
    expect(preview.rowCount).toBe(1);
    expect(preview.estimate.htmlRetentionOn).toBe(false);
    expect(preview.estimate.storedHtmlBytes).toBe(0);
    expect(preview.estimate.rawHtmlBytes).toBe(0);
  });

  it("reports retention ON and scales the measured page size by the cohort", async () => {
    // The warning that stops the owner tripling the database. The figure has
    // to be MEASURED from this portal's own captures, and it has to scale with
    // the cohort — a per-page number is not a decision the operator can make.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed({ n: 2, photos: 3, score: 0.8 }, p);
    const body = "x".repeat(50_000);
    await seedCapture(1, body);
    await seedCapture(2, body);

    const preview = await previewRecaptureCohort(req());
    expect(preview.rowCount).toBe(2);
    expect(preview.estimate.htmlRetentionOn).toBe(true);
    // Raw bytes are octet_length: exactly the page size, times the cohort.
    expect(preview.estimate.rawHtmlBytes).toBe(2 * body.length);
    // Stored bytes are pg_column_size: TOAST-compressed, so smaller than raw
    // for this highly compressible body, but real and non-zero.
    expect(preview.estimate.storedHtmlBytes).toBeGreaterThan(0);
    expect(preview.estimate.storedHtmlBytes).toBeLessThan(
      preview.estimate.rawHtmlBytes,
    );
  });

  it("ignores captures belonging to another portal", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await pool!.query(
      `INSERT INTO extension_capture (url, html, connector_name, status)
       VALUES ($1, $2, 'aliseda', 'done')`,
      [`${HOST}/inmueble/${MARK}77/`, "y".repeat(50_000)],
    );

    const preview = await previewRecaptureCohort(req());
    expect(preview.estimate.htmlRetentionOn).toBe(false);
  });

  it("ignores captures that never reached 'done'", async () => {
    // A 'failed' row keeps its html for debugging (see the schema comment), so
    // counting it would report retention ON for a portal that discards HTML on
    // every successful parse.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await pool!.query(
      `INSERT INTO extension_capture (url, html, connector_name, status)
       VALUES ($1, $2, 'idealista', 'failed')`,
      [`${HOST}/inmueble/${MARK}78/`, "z".repeat(50_000)],
    );

    const preview = await previewRecaptureCohort(req());
    expect(preview.estimate.htmlRetentionOn).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("requeueRecaptureCohort", () => {
  it("flips exactly the previewed count and stamps the requeue", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed({ n: 2, photos: 3, score: 0.8 }, p);

    const preview = await previewRecaptureCohort(req());
    const result = await requeueRecaptureCohort(
      req(),
      "galería truncada (#625)",
      preview.rowCount,
    );

    expect(result.requeued).toBe(preview.rowCount);
    const row = await worklistRow(1);
    expect(row.status).toBe("pending");
    expect(row.requeued_at).not.toBeNull();
    expect(row.requeue_reason).toBe("galería truncada (#625)");
  });

  it("keeps a requeued row distinguishable from a never-captured one", async () => {
    // THE point of the feature. Both rows are 'pending' afterwards; only
    // requeued_at separates "already produced data once, queued again" from
    // "never captured at all" — and it has to hold in the database, so a pass
    // interrupted halfway still tells the two apart.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p); // captured → requeued
    await seed({ n: 2, photos: 3, score: 0.8, worklistStatus: "pending" }, p); // never captured

    await requeueRecaptureCohort(req(), "motivo", 1);

    const requeued = await worklistRow(1);
    const virgin = await worklistRow(2);
    expect(requeued.status).toBe("pending");
    expect(virgin.status).toBe("pending");
    expect(requeued.requeued_at).not.toBeNull();
    expect(virgin.requeued_at).toBeNull();
  });

  it("refuses the write when the cohort moved since the preview", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    const result = await requeueRecaptureCohort(req(), "motivo", 99);
    expect(result.requeued).toBe(0);
    expect(result.expected).toBe(1);
    expect((await worklistRow(1)).status).toBe("captured");
  });

  it("ranks the cohort by value: best profile score first, fewest photos next", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.4 }, p);
    await seed({ n: 2, photos: 3, score: 0.9 }, p); // best score → rank 1
    await seed({ n: 3, photos: 1, score: 0.4 }, p); // ties on score, fewer photos

    await requeueRecaptureCohort(req(), "motivo", 3);
    expect((await worklistRow(2)).requeue_rank).toBe(1);
    expect((await worklistRow(3)).requeue_rank).toBe(2);
    expect((await worklistRow(1)).requeue_rank).toBe(3);
  });

  it("drains requeued rows in rank order, after every never-requeued row", async () => {
    // listWorklist is what the extension's manual batch driver consumes
    // verbatim, so this ordering IS the capture order.
    //
    // Seeded so that rank order CONTRADICTS the pre-existing
    // `created_at DESC, id DESC` ordering rather than agreeing with it —
    // otherwise this test passes with the whole
    // `CASE WHEN status='pending' THEN requeue_rank END` clause deleted and
    // proves nothing about the feature it is named after.
    //
    //   seeded (oldest → newest):   9(virgin pending), 1, 2, 3
    //   score:                          —             .9  .5  .1
    //   requeue_rank after the flip:    NULL           1   2   3
    //
    //   expected  (rank ordering):  9, 1, 2, 3
    //   would be  (created_at only): 3, 2, 1, 9   ← the exact reverse
    const p = await seedProfile();
    await seed({ n: 9, photos: 3, score: 0.7, worklistStatus: "pending" }, p);
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed({ n: 2, photos: 3, score: 0.5 }, p);
    await seed({ n: 3, photos: 3, score: 0.1 }, p);

    await requeueRecaptureCohort(req(), "motivo", 3);

    const { rows } = await listWorklist("idealista");
    const mine = rows.filter((r) => r.url.includes(MARK));
    expect(mine.map((r) => r.url.match(/677000(\d)/)![1])).toEqual([
      "9", // never requeued — keeps its existing position, at the front
      "1", // requeue_rank 1 (best score) — but the OLDEST of the three
      "2", // requeue_rank 2
      "3", // requeue_rank 3 — but the NEWEST of the three
    ]);
  });

  it("honours a rank only while the row is still pending", async () => {
    // The `status = 'pending'` gate inside the CASE. A row that has since been
    // re-captured still carries its `requeue_rank`; it must fall back to the
    // normal newest-first position instead of holding a slot in a queue it has
    // already left. Without the gate the four rows below come back ordered by
    // bare rank (1, 2, 5, 9) instead.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.4, requeueRank: 1 }, p); // captured
    await seed(
      {
        n: 2,
        photos: 3,
        score: 0.4,
        worklistStatus: "pending",
        requeueRank: 5,
      },
      p,
    );
    await seed(
      {
        n: 3,
        photos: 3,
        score: 0.4,
        worklistStatus: "pending",
        requeueRank: 2,
      },
      p,
    );
    await seed({ n: 4, photos: 3, score: 0.4, requeueRank: 9 }, p); // captured

    const { rows } = await listWorklist("idealista");
    const mine = rows.filter((r) => r.url.includes(MARK));
    expect(mine.map((r) => r.url.match(/677000(\d)/)![1])).toEqual([
      "4", // not pending → rank ignored, newest first
      "1", // not pending → rank ignored
      "3", // pending, rank 2
      "2", // pending, rank 5
    ]);
  });

  it("leaves skipped, stale and failed rows untouched by the write itself", async () => {
    // The preview already excludes them, but the protection that actually
    // matters is `AND w.status = $4` on the UPDATE: it is what stops a stale
    // tab, or a cohort that moved between preview and confirm, from
    // overturning a per-row decision the owner made. Assert the rows, not the
    // count.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p); // the only eligible row
    const untouchable = ["skipped", "stale", "failed"] as const;
    for (const [i, status] of untouchable.entries()) {
      await seed(
        { n: 10 + i, photos: 3, score: 0.9, worklistStatus: status },
        p,
      );
    }

    const result = await requeueRecaptureCohort(req(), "motivo", 1);
    expect(result.requeued).toBe(1);

    for (const [i, status] of untouchable.entries()) {
      const row = await worklistRow(10 + i);
      expect(row.status).toBe(status);
      expect(row.requeued_at).toBeNull();
      expect(row.requeue_reason).toBeNull();
      expect(row.requeue_rank).toBeNull();
    }
  });

  it("stale_capture selects by capture age, and counts a never-refetched listing as stale", async () => {
    // The only predicate that uses `make_interval`, and the only one whose
    // NULL handling is a deliberate inclusion rather than an omission:
    // `last_fetched_at IS NULL` means "never re-fetched", which is the
    // stalest a listing can be, not a row to skip.
    const p = await seedProfile();
    await seed({ n: 1, photos: 20, score: 0.9 }, p); // last_fetched_at NULL
    await seed({ n: 2, photos: 20, score: 0.8 }, p);
    await seed({ n: 3, photos: 20, score: 0.7 }, p);
    await pool!.query(
      `UPDATE listing SET last_fetched_at = NOW() - INTERVAL '90 days'
        WHERE external_id = $1`,
      [`${MARK}2`],
    );
    await pool!.query(
      `UPDATE listing SET last_fetched_at = NOW() - INTERVAL '2 days'
        WHERE external_id = $1`,
      [`${MARK}3`],
    );

    const stale = req({ predicate: "stale_capture", threshold: 30 });
    const preview = await previewRecaptureCohort(stale);
    // n=1 (never re-fetched) and n=2 (90 days) match; n=3 (2 days) does not.
    // Photo count is 20 for all three, so `few_photos` would have matched none
    // of them — this is the staleness predicate doing the work.
    expect(preview.rowCount).toBe(2);

    await requeueRecaptureCohort(stale, "motivo", 2);
    expect((await worklistRow(1)).status).toBe("pending");
    expect((await worklistRow(2)).status).toBe("pending");
    expect((await worklistRow(3)).status).toBe("captured");
  });

  it("refuses a row that stopped being 'captured' after the cohort was resolved", async () => {
    // The UPDATE's `AND w.status = $4`, isolated. The cohort resolver runs
    // first and returns two eligible ids; the hook then marks one 'skipped'
    // before the UPDATE executes — the same window a second tab, or the
    // per-row "Omitir" button, opens in real use. The guard must drop that
    // row rather than overturn the decision that was just made about it.
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await seed({ n: 2, photos: 3, score: 0.8 }, p);

    let fired = false;
    sqlHook.after = async (text) => {
      // Fire once, right after the worklist rows are resolved and before the
      // UPDATE is issued.
      if (fired || !text.includes("FROM capture_worklist")) return;
      fired = true;
      await pool!.query(
        `UPDATE capture_worklist SET status = 'skipped' WHERE url LIKE $1`,
        [`%${MARK}2%`],
      );
    };

    const result = await requeueRecaptureCohort(req(), "motivo", 2);
    expect(fired).toBe(true);
    // Both ids were resolved (so the count guard is satisfied), but only one
    // was still eligible when the write landed.
    expect(result.expected).toBe(2);
    expect(result.requeued).toBe(1);

    expect((await worklistRow(1)).status).toBe("pending");
    const spared = await worklistRow(2);
    expect(spared.status).toBe("skipped");
    expect(spared.requeued_at).toBeNull();
    expect(spared.requeue_rank).toBeNull();
  });

  it("is idempotent: a second identical requeue finds nothing left to flip", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    expect((await requeueRecaptureCohort(req(), "motivo", 1)).requeued).toBe(1);
    // The row is 'pending' now, so it is no longer requeue-able — a repeat
    // run must not reset the rank of a queue that is already draining.
    const second = await previewRecaptureCohort(req());
    expect(second.rowCount).toBe(0);
  });
});
