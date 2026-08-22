/**
 * Re-capture must not re-buy an assessment (#677/#683 + #654/#678).
 *
 * ## The thing being protected
 *
 * We are about to requeue ~2,800 Idealista listings for browser re-capture so
 * the #678 parser fix can replace 3 stored photos with 18. A re-capture
 * re-runs `normalize()` and re-upserts the listing row: `photo_urls` changes,
 * `last_seen_at`/`last_fetched_at` move, `raw_extra` is rewritten. For the
 * overwhelming majority the **description, price, size, rooms and address are
 * unchanged**.
 *
 * If anything in the assessment path keyed off "the listing row was touched"
 * rather than "the assessed content changed", that pass would fire thousands
 * of needless LLM calls. `cache.ts`'s content hash covers listing id +
 * trimmed description only, and `eligibility.ts`'s selection predicate keys on
 * "no `ai_assessment` row at the current prompt version" — neither reads a
 * timestamp or `photo_urls`. This file pins that end to end, against a real
 * database, at the point where money is actually spent.
 *
 * ## Why the spy sits on `llmComplete` and not on the cache
 *
 * Asserting `fromCache === true`, or spying `computeAssessmentContentHash`,
 * only proves the cache agreed with itself. The question the owner asked is
 * "does a model call happen", so the assertion is made at the single seam
 * every model call in the dashboard must pass through: `llmComplete`
 * (`lib/llm-client.ts`), reached only via `lib/llm-context/assemble.ts`
 * (D-006, CI-enforced). `runAgenticChat` is counted too, so a flow that ever
 * moves to the agentic branch cannot slip past this file. The wrappers
 * delegate to the REAL implementations — the `mock` provider still runs the
 * genuine assemble → prompt → parse → persist pipeline, exactly as
 * `occupancy.integration.test.ts` does; the spy only counts.
 *
 * `__tests__` is excluded from `check-llm-context.sh`'s scan, so importing
 * `llmComplete` here does not violate D-006.
 *
 * ## The controls
 *
 * A test that asserts "zero calls" is worthless if it would assert zero
 * anyway. Two controls run in the same file with the same spy:
 *   - the FIRST pass over a fresh property must be non-zero (the spy works);
 *   - changing the DESCRIPTION must produce a call (the cache is not simply
 *     stuck on "hit"), which is the invalidation direction we still need.
 *
 * Mutation-checked when written: making `computeAssessmentContentHash` cover
 * `photo_urls` (plus loading the column in `shared.ts`) turns three of these
 * red. Note WHICH three — the batch-pass and scheduler-selection tests stay
 * green under that mutation, because they are guarded one layer further out
 * (`isFlowCurrent` / `pendingClause` never consult the hash at all). That is
 * the defence in depth this file documents, not a weakness in it: the hash is
 * the inner guard, reached only by a direct/manual flow call.
 *
 * Cleanup is scoped to the exact ids this file creates, never a table-wide
 * delete — vitest runs integration files against one shared Postgres. Same
 * rationale as the sibling integration files.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool } from "@/lib/db-write";
import { resetDashboardLlmConfigCache } from "@/lib/llm-provider/config";

// Hoisted so `vi.mock`'s factory (which is hoisted above the imports) can see
// them. One counter per model seam.
const { completeSpy, agenticSpy } = vi.hoisted(() => ({
  completeSpy: vi.fn(),
  agenticSpy: vi.fn(),
}));

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>();
  return {
    ...actual,
    llmComplete: (...args: Parameters<typeof actual.llmComplete>) => {
      completeSpy();
      return actual.llmComplete(...args);
    },
  };
});

vi.mock("@/lib/llm-tools/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-tools/runner")>();
  return {
    ...actual,
    runAgenticChat: (...args: Parameters<typeof actual.runAgenticChat>) => {
      agenticSpy();
      return actual.runAgenticChat(...args);
    },
  };
});

import { assessPropertyOccupancy, OCCUPANCY_PROMPT_VERSION } from "../occupancy";
import { assessPropertyCondition, CONDITION_PROMPT_VERSION } from "../condition";
import { assessPropertyRedFlags, REDFLAGS_PROMPT_VERSION } from "../redflags";
import {
  assessPropertyLocation,
  parseLocationResult,
  saveLocationAssessment,
} from "../location";
import {
  assessPropertyOpportunity,
  parseOpportunityResult,
  saveOpportunityAssessment,
} from "../opportunity";
import { assessPropertyExtract } from "../extract";
import {
  runAssessmentBatch,
  selectPropertiesNeedingAssessment,
  DEFAULT_BATCH_FLOWS,
} from "../batch";
import { computeAssessmentContentHash } from "../cache";
import { loadPropertyListings } from "../shared";

/** Total model invocations across both seams since the last reset. */
function modelCalls(): number {
  return completeSpy.mock.calls.length + agenticSpy.mock.calls.length;
}

function resetModelCalls(): void {
  completeSpy.mockClear();
  agenticSpy.mockClear();
}

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
          `recapture-no-reassess.integration.test.ts: ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[recapture-no-reassess.integration.test] no reachable Postgres — skipping " +
        "real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

/** What the Idealista parser stored BEFORE #678: the truncated 3-photo gallery. */
const THREE_PHOTOS = [
  "https://img.example.test/a1.jpg",
  "https://img.example.test/a2.jpg",
  "https://img.example.test/a3.jpg",
];

/** What a re-capture stores AFTER #678: the full gallery. */
const EIGHTEEN_PHOTOS = Array.from(
  { length: 18 },
  (_v, i) => `https://img.example.test/full-${i + 1}.jpg`,
);

/**
 * The advert text. Synthetic — never a real scraped description (public repo,
 * AGENTS.md § No scraped personal data).
 */
const DESCRIPTION = "Piso exterior de 85 m2 con tres dormitorios. Se vende con inquilino.";

describe.runIf(dbAvailable)("re-capture does not re-run any LLM flow", () => {
  afterAll(async () => {
    await resetPool();
  });

  let createdPropertyIds: number[] = [];
  let createdProfileIds: number[] = [];

  beforeEach(() => {
    createdPropertyIds = [];
    createdProfileIds = [];
    resetModelCalls();
    // env > config.yaml, so this beats a developer's local config.yaml; the
    // cache reset stops a stale `cli` provider from spawning a real `claude`.
    vi.stubEnv("DASHBOARD_LLM_PROVIDER", "mock");
    resetDashboardLlmConfigCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetDashboardLlmConfigCache();
    await withRealDb(async (pool) => {
      if (createdPropertyIds.length > 0) {
        await pool.query(
          "DELETE FROM profile_listing_state WHERE property_id = ANY($1::bigint[])",
          [createdPropertyIds],
        );
        await pool.query("DELETE FROM ai_assessment WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query(
          "DELETE FROM ai_assessment_failure WHERE property_id = ANY($1::bigint[])",
          [createdPropertyIds],
        );
        await pool.query("DELETE FROM listing WHERE property_id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
        await pool.query("DELETE FROM property WHERE id = ANY($1::bigint[])", [
          createdPropertyIds,
        ]);
      }
      if (createdProfileIds.length > 0) {
        await pool.query("DELETE FROM search_profile WHERE id = ANY($1::bigint[])", [
          createdProfileIds,
        ]);
      }
    });
  });

  /**
   * One Idealista property in exactly the pre-re-capture state: a matched
   * candidate of an active profile (so it is assessment-ELIGIBLE, #327), one
   * active advert carrying a description and the truncated 3-photo gallery.
   */
  async function seedIdealistaProperty(pool: Pool, tag: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property (address, property_type, m2_built, rooms)
       VALUES ($1, 'piso', 85, 3) RETURNING id`,
      [`Calle Recaptura ${tag}`],
    );
    const propertyId = Number(rows[0].id);
    createdPropertyIds.push(propertyId);

    await pool.query(
      `INSERT INTO listing
          (property_id, source, external_id, url, status, operation,
           current_price, description, photo_urls, first_seen_at, last_seen_at,
           last_fetched_at)
       VALUES ($1, 'idealista', $2, $3, 'active', 'sale', 180000, $4, $5,
               now() - interval '30 days', now() - interval '30 days',
               now() - interval '30 days')`,
      [
        propertyId,
        `recap-${tag}`,
        `https://www.idealista.com/inmueble/recap-${tag}/`,
        DESCRIPTION,
        THREE_PHOTOS,
      ],
    );

    const { rows: profileRows } = await pool.query<{ id: number }>(
      `INSERT INTO search_profile (name, scope)
       VALUES ($1, '{"geography":{"type":"radius"},"property_types":["piso"]}'::jsonb)
       RETURNING id`,
      [`Recaptura profile ${tag}`],
    );
    const profileId = Number(profileRows[0].id);
    createdProfileIds.push(profileId);
    await pool.query(
      `INSERT INTO profile_listing_state (profile_id, property_id, matched)
       VALUES ($1, $2, true)`,
      [profileId, propertyId],
    );

    return propertyId;
  }

  /**
   * Exactly what a browser re-capture does to a row whose text did not change:
   * the full gallery replaces the truncated one, every freshness timestamp
   * moves, `raw_extra` is rewritten. `description` is byte-identical.
   */
  async function simulateRecapture(pool: Pool, propertyId: number): Promise<void> {
    await pool.query(
      `UPDATE listing
          SET photo_urls     = $2,
              last_seen_at   = now(),
              last_fetched_at = now(),
              raw_extra      = '{"recaptured": true}'::jsonb
        WHERE property_id = $1`,
      [propertyId, EIGHTEEN_PHOTOS],
    );
  }

  /**
   * The four flows the `mock` provider actually scripts, in the order the batch
   * runs them. `location`/`opportunity` are covered separately below — see
   * `MOCK_UNSCRIPTED_NOTE`.
   */
  async function runScriptedFlows(propertyId: number): Promise<void> {
    await assessPropertyOccupancy(propertyId);
    await assessPropertyCondition(propertyId);
    await assessPropertyRedFlags(propertyId);
    await assessPropertyExtract(propertyId);
  }

  const SCRIPTED_FLOW_TYPES = ["occupancy", "condition", "redflags", "extract"];
  const SCRIPTED_BATCH_FLOWS = DEFAULT_BATCH_FLOWS.filter((f) =>
    SCRIPTED_FLOW_TYPES.includes(f.type),
  );

  /**
   * Seed `location`/`opportunity` verdicts the way a real (non-mock) run would
   * leave them: the flow's own `save*`, carrying the content hash computed from
   * the property's listings AS THEY ARE NOW.
   *
   * This is the seam that lets those two flows be tested at all here — the
   * `mock` provider's `detectMockFlow` (`lib/llm-provider/mock/script.ts:44-55`)
   * only recognises occupancy/condition/redflags/extract/compare, so a live
   * `assessPropertyLocation` under the mock falls through to the `chat` script,
   * gets prose, and throws in `parseLocationResult`. That is a mock-fixture gap,
   * not a production behaviour, and it must not stop us pinning the thing this
   * file exists for. Seeding a valid row makes the SUBSEQUENT call a pure cache
   * decision: if the hash ever started tracking `photo_urls`, the post-recapture
   * call would MISS, reach the model, and blow up on the mock's prose — which
   * the assertion below catches either way (spy > 0, or a thrown parse error).
   */
  async function seedLocationAndOpportunity(propertyId: number): Promise<void> {
    const listings = await loadPropertyListings(propertyId);
    const hash = computeAssessmentContentHash(listings);
    await saveLocationAssessment(
      propertyId,
      parseLocationResult(
        JSON.stringify({
          beach_proximity: "unknown",
          beach_evidence: "",
          heritage_zone: false,
          confidence: 0.5,
          reasoning: "Fixture.",
        }),
      ),
      "test-model",
      hash,
    );
    await saveOpportunityAssessment(
      propertyId,
      parseOpportunityResult(
        JSON.stringify({
          is_vpo: false,
          vpo_evidence: "",
          tourist_license: false,
          confidence: 0.5,
          reasoning: "Fixture.",
        }),
      ),
      "test-model",
      hash,
    );
  }

  it("CONTROL: the first pass over a fresh property DOES call the model", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "control-first");

      await runScriptedFlows(propertyId);

      // If this is ever 0 the spy has come unwired and every other assertion
      // in this file is vacuous.
      expect(modelCalls()).toBeGreaterThan(0);
    });
  });

  it("re-capturing 3 photos → 18 with an unchanged description costs ZERO model calls", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "zero-calls");

      await runScriptedFlows(propertyId);
      const firstPass = modelCalls();
      expect(firstPass).toBeGreaterThan(0);

      await simulateRecapture(pool, propertyId);

      // The photo column really did change — otherwise this test proves
      // nothing about photos.
      const { rows } = await pool.query<{ photo_urls: string[] }>(
        `SELECT photo_urls FROM listing WHERE property_id = $1`,
        [propertyId],
      );
      expect(rows[0].photo_urls).toHaveLength(18);

      resetModelCalls();
      await runScriptedFlows(propertyId);

      expect(modelCalls()).toBe(0);
    });
  });

  it("a re-captured property is not re-selected by the scheduler", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "not-selected");

      await runScriptedFlows(propertyId);
      // Every selection flow (occupancy/condition/redflags) now has a
      // current-version row, so the property has left the backlog.
      expect(await selectPropertiesNeedingAssessment(5000)).not.toContain(propertyId);

      await simulateRecapture(pool, propertyId);

      // The whole point: selection keys on "missing a current-version verdict",
      // never on `last_fetched_at` / `last_seen_at` / `photo_urls`, so a touched
      // row does not re-enter the queue.
      expect(await selectPropertiesNeedingAssessment(5000)).not.toContain(propertyId);
    });
  });

  it("a full batch pass after re-capture costs ZERO model calls", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "batch-zero");

      // `flows` is narrowed to the mock-scripted four for the reason given on
      // `seedLocationAndOpportunity`; the batch's own selection, isCurrent gate,
      // concurrency pool and per-flow error handling are all the real ones.
      await runAssessmentBatch({
        selectPropertyIds: async () => [propertyId],
        flows: SCRIPTED_BATCH_FLOWS,
        batchSize: 5,
      });
      expect(modelCalls()).toBeGreaterThan(0);

      await simulateRecapture(pool, propertyId);
      resetModelCalls();

      // Pinned selection, so this measures the per-property work the batch does
      // even if selection HAD re-picked the property — belt and braces over the
      // previous test's braces.
      const result = await runAssessmentBatch({
        selectPropertyIds: async () => [propertyId],
        flows: SCRIPTED_BATCH_FLOWS,
        batchSize: 5,
      });

      expect(modelCalls()).toBe(0);
      // Every flow took the EC-2 "already current" skip, so nothing even
      // reached `getOrCompute`.
      expect(result.assessed).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.skipped).toBe(SCRIPTED_BATCH_FLOWS.length);
    });
  });

  it("location and opportunity also stay cached across a re-capture", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "loc-opp");

      await seedLocationAndOpportunity(propertyId);
      resetModelCalls();

      await simulateRecapture(pool, propertyId);

      // Under the mock provider a MISS here would either count a model call or
      // throw on the `chat` script's prose — both are failures, and both are
      // exactly what a photo-sensitive hash would produce.
      const loc = await assessPropertyLocation(propertyId);
      const opp = await assessPropertyOpportunity(propertyId);

      expect(modelCalls()).toBe(0);
      expect(loc.skipped).toBe(false);
      expect(opp.skipped).toBe(false);
    });
  });

  it("re-capture leaves every stored verdict byte-identical, at its original timestamp", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "untouched");

      await runScriptedFlows(propertyId);
      await seedLocationAndOpportunity(propertyId);
      const before = await pool.query<{
        assessment_type: string;
        content_hash: string;
        generated_at: string;
      }>(
        `SELECT assessment_type, content_hash, generated_at
           FROM ai_assessment WHERE property_id = $1 ORDER BY assessment_type`,
        [propertyId],
      );
      // occupancy + condition + redflags + location + opportunity (+ extract,
      // which self-gates and may legitimately skip).
      expect(before.rows.length).toBeGreaterThanOrEqual(5);

      await simulateRecapture(pool, propertyId);
      await runScriptedFlows(propertyId);
      await assessPropertyLocation(propertyId);
      await assessPropertyOpportunity(propertyId);

      const after = await pool.query(
        `SELECT assessment_type, content_hash, generated_at
           FROM ai_assessment WHERE property_id = $1 ORDER BY assessment_type`,
        [propertyId],
      );
      // Same hashes, same generated_at — nothing was rewritten, so nothing was
      // recomputed.
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("CONTROL: changing the DESCRIPTION still invalidates and re-calls the model", async () => {
    await withRealDb(async (pool) => {
      const propertyId = await seedIdealistaProperty(pool, "control-desc");

      await runScriptedFlows(propertyId);
      resetModelCalls();

      // Same shape of write as `simulateRecapture`, plus the one field the hash
      // covers. If this were also 0, the "zero calls" assertions above would be
      // measuring a cache that never invalidates rather than one that ignores
      // photos.
      await pool.query(
        `UPDATE listing
            SET description    = $2,
                photo_urls     = $3,
                last_seen_at   = now(),
                last_fetched_at = now()
          WHERE property_id = $1`,
        [
          propertyId,
          DESCRIPTION + " Rebajado por traslado; se admite negociacion.",
          EIGHTEEN_PHOTOS,
        ],
      );

      await runScriptedFlows(propertyId);

      expect(modelCalls()).toBeGreaterThan(0);
    });
  });

  it("the prompt versions this file pins are the ones production runs", () => {
    // A version bump is a legitimate re-assessment trigger and is NOT what this
    // file guards — but it should be a deliberate act, visible in a diff, not a
    // side effect of the re-capture pass. Naming the constants here means a bump
    // shows up in this file's blame alongside the cost question.
    expect(OCCUPANCY_PROMPT_VERSION).toBe("occupancy/v2");
    expect(CONDITION_PROMPT_VERSION).toBe("condition/v2");
    expect(REDFLAGS_PROMPT_VERSION).toBe("redflags/v8");
  });
});
