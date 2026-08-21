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
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
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
    `INSERT INTO capture_worklist (url, match_key, source_portal, status, added_via, requeued_at)
     VALUES ($1, $2, 'idealista', $3, 'derived', $4)`,
    [
      url,
      `idealista.com/inmueble/${externalId}`,
      f.worklistStatus ?? "captured",
      f.requeuedAt ?? null,
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

  it("writes nothing — the preview is what the operator runs before deciding", async () => {
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.9 }, p);
    await previewRecaptureCohort(req());
    expect((await worklistRow(1)).status).toBe("captured");
    expect((await worklistRow(1)).requeued_at).toBeNull();
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
    const p = await seedProfile();
    await seed({ n: 1, photos: 3, score: 0.4 }, p);
    await seed({ n: 2, photos: 3, score: 0.9 }, p);
    await seed({ n: 3, photos: 3, score: 0.1, worklistStatus: "pending" }, p);

    await requeueRecaptureCohort(req(), "motivo", 2);

    const { rows } = await listWorklist("idealista");
    const mine = rows.filter((r) => r.url.includes(MARK));
    expect(mine.map((r) => r.url.match(/677000(\d)/)![1])).toEqual([
      "3", // never requeued — keeps its existing position, at the front
      "2", // requeue_rank 1 (best score)
      "1", // requeue_rank 2
    ]);
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
