/**
 * The assessment failure ledger — the guard that stops the scheduler paying
 * for the same doomed LLM call every 15 minutes forever.
 *
 * Before this, a flow that failed for a non-budget reason (unparseable model
 * output, empty completion, a CLI error) wrote nothing anywhere, so the
 * property still matched the "missing a current-version verdict" selection
 * predicate and came back on the very next tick — and first, since selection
 * is `created_at ASC`. Up to 96 paid retries per day per flow per poisoned
 * property.
 *
 * Mocks `@/lib/db-write`, routing by SQL text so the ledger reads/writes can
 * be asserted independently of the cache read.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSql = vi.fn();
const mockClientQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
vi.mock("@/lib/db-write", () => ({
  sql: (...a: unknown[]) => mockSql(...a),
  getPool: () => ({ connect: mockConnect }),
}));

import { getOrCompute, AssessmentParkedError } from "../cache";
// The REAL error classes the exemption keys off — see the "pins" test below.
import { BudgetExceededError } from "@/lib/llm-usage";
import { CircuitBreakerOpenError } from "@/lib/llm-circuit-breaker";
import { CliRunnerError } from "@/lib/llm-provider/cli/errors";
import type { ListingSnapshot } from "@/lib/llm-context";

const listings: ListingSnapshot[] = [{ listingId: 1, description: "piso de 90m2" }];

/** Queries issued by `getOrCompute`, classified by their SQL text. */
type Issued = { kind: "cache" | "read-failure" | "record-failure" | "clear-failure"; sql: string };

function classify(sqlText: string): Issued["kind"] {
  if (sqlText.includes("INSERT INTO ai_assessment_failure")) return "record-failure";
  if (sqlText.includes("DELETE FROM ai_assessment_failure")) return "clear-failure";
  if (sqlText.includes("ai_assessment_failure")) return "read-failure";
  return "cache";
}

function issued(): Issued["kind"][] {
  return mockSql.mock.calls.map((c) => classify(String(c[0])));
}

/**
 * Route responses by query kind. `failCount` null = no ledger row on file.
 */
function stubDb(opts: { failCount?: number | null; lastError?: string | null } = {}) {
  const { failCount = null, lastError = null } = opts;
  mockSql.mockImplementation((text: string) => {
    switch (classify(text)) {
      case "cache":
        return Promise.resolve([]); // always a cache miss
      case "read-failure":
        return Promise.resolve(
          failCount === null ? [] : [{ fail_count: failCount, last_error: lastError }],
        );
      default:
        return Promise.resolve([]);
    }
  });
}

beforeEach(() => {
  mockSql.mockReset();
  mockClientQuery.mockClear();
  mockConnect.mockClear();
});

describe("assessment failure ledger", () => {
  it("records a strike when the flow throws, and still surfaces the original error", async () => {
    stubDb();
    const boom = new Error("model returned unparseable JSON");
    const computeFn = vi.fn().mockRejectedValue(boom);
    const save = vi.fn();

    await expect(
      getOrCompute(1, "condition", "v1", listings, computeFn, save),
    ).rejects.toBe(boom);

    expect(issued()).toContain("record-failure");
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses to call the LLM once the strike count reaches the cap", async () => {
    stubDb({ failCount: 3, lastError: "unparseable JSON" });
    const computeFn = vi.fn();
    const save = vi.fn();

    const promise = getOrCompute(1, "condition", "v1", listings, computeFn, save);
    await expect(promise).rejects.toBeInstanceOf(AssessmentParkedError);
    // The whole point: no money spent on a known-bad input.
    expect(computeFn).not.toHaveBeenCalled();
  });

  it("still retries below the cap", async () => {
    stubDb({ failCount: 2 });
    const computeFn = vi.fn().mockResolvedValue({ result: { v: 1 }, model: "m" });
    const save = vi.fn().mockResolvedValue(undefined);

    const out = await getOrCompute(1, "condition", "v1", listings, computeFn, save);
    expect(out.fromCache).toBe(false);
    expect(computeFn).toHaveBeenCalledTimes(1);
  });

  it("clears the ledger after a success so a recovered flow is not parked later", async () => {
    stubDb({ failCount: 2 });
    const computeFn = vi.fn().mockResolvedValue({ result: { v: 1 }, model: "m" });
    const save = vi.fn().mockResolvedValue(undefined);

    await getOrCompute(1, "condition", "v1", listings, computeFn, save);
    expect(issued()).toContain("clear-failure");
  });

  // `isEnvironmentalError` matches on `.name`/`.code`, not `instanceof`
  // (importing lib/llm here would create a cycle). These use the REAL classes,
  // so deleting `this.name = ...` from either one fails a test instead of
  // silently disabling the exemption.
  it("pins the real classes' name/code, which the exemption matches on", () => {
    expect(new BudgetExceededError().name).toBe("BudgetExceededError");
    expect(new CircuitBreakerOpenError("x").name).toBe("CircuitBreakerOpenError");
    expect(new CliRunnerError("LLM_CLI_TIMEOUT", "x").code).toBe("LLM_CLI_TIMEOUT");
  });

  it("does NOT strike on a budget stop — that is about the environment, not the input", async () => {
    // Otherwise one budget-exhausted day would park the entire backlog and it
    // would never be assessed again without operator intervention.
    stubDb();
    const computeFn = vi.fn().mockRejectedValue(new BudgetExceededError());

    await expect(
      getOrCompute(1, "condition", "v1", listings, computeFn, vi.fn()),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(issued()).not.toContain("record-failure");
  });

  it("does NOT strike when the circuit breaker is open", async () => {
    stubDb();
    const computeFn = vi.fn().mockRejectedValue(new CircuitBreakerOpenError("open"));

    await expect(
      getOrCompute(1, "condition", "v1", listings, computeFn, vi.fn()),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(issued()).not.toContain("record-failure");
  });

  it.each([
    ["LLM_CLI_TIMEOUT"],
    ["LLM_CLI_AUTH"],
    ["LLM_CLI_API_ERROR"],
    ["LLM_CLI_EXIT"],
  ])("does NOT strike on %s — infrastructure, not content", async (code) => {
    // Selection is created_at ASC, so during an outage the SAME head-of-queue
    // property is retried every tick; striking on infra failures would park it
    // after three ticks of a bad 45 minutes.
    stubDb();
    const computeFn = vi.fn().mockRejectedValue(new CliRunnerError(code, "boom"));

    await expect(
      getOrCompute(1, "condition", "v1", listings, computeFn, vi.fn()),
    ).rejects.toBeInstanceOf(CliRunnerError);
    expect(issued()).not.toContain("record-failure");
  });

  it.each([["LLM_CLI_EMPTY"], ["LLM_CLI_PARSE"], ["LLM_CLI_TRUNCATED"]])(
    "DOES strike on %s — that is a property of this listing's text",
    async (code) => {
      stubDb();
      const computeFn = vi.fn().mockRejectedValue(new CliRunnerError(code, "boom"));

      await expect(
        getOrCompute(1, "condition", "v1", listings, computeFn, vi.fn()),
      ).rejects.toBeInstanceOf(CliRunnerError);
      expect(issued()).toContain("record-failure");
    },
  );

  it("does NOT strike on an upstream 429", async () => {
    stubDb();
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    await expect(
      getOrCompute(1, "condition", "v1", listings, vi.fn().mockRejectedValue(err), vi.fn()),
    ).rejects.toBe(err);
    expect(issued()).not.toContain("record-failure");
  });

  it("scopes the ledger read to a decay window so a park cannot outlive its cause", async () => {
    stubDb();
    await getOrCompute(
      1,
      "condition",
      "v1",
      listings,
      vi.fn().mockResolvedValue({ result: { v: 1 }, model: "m" }),
      vi.fn(),
    );
    const ledgerRead = mockSql.mock.calls
      .map((c) => String(c[0]))
      .find((t) => classify(t) === "read-failure");
    expect(ledgerRead).toContain("last_failed_at >");
  });

  it("a cache hit is served without touching the ledger", async () => {
    // Parking must never block a free read.
    const { computeAssessmentContentHash } = await import("../cache");
    const hash = computeAssessmentContentHash(listings);
    mockSql.mockImplementation((text: string) =>
      classify(text) === "cache"
        ? Promise.resolve([
            {
              result: { v: 1 },
              model: "m",
              generated_at: "2026-01-01T00:00:00Z",
              prompt_version: "v1",
              content_hash: hash,
            },
          ])
        : Promise.resolve([]),
    );

    const out = await getOrCompute(1, "condition", "v1", listings, vi.fn(), vi.fn());
    expect(out.fromCache).toBe(true);
    expect(issued()).not.toContain("read-failure");
  });
});
