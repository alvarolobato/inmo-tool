/**
 * #308 — assessment batch trigger, unit tests.
 *
 * These use `runAssessmentBatch`'s injectable seams (`selectPropertyIds`,
 * `isCurrent`, `flows`) so the whole trigger is exercised with NO database and
 * NO real LLM — the three exit criteria this task must prove in isolation:
 *
 *   EC-2  a property already at the current prompt version is SKIPPED, never
 *         re-billed.
 *   EC-3  a BudgetExceededError / CircuitBreakerOpenError mid-batch stops the
 *         pass CLEANLY (a summary, not a crash) and processes nothing further.
 *   + the batch calls the flows for a genuinely unassessed property, and one
 *     bad property (NoListingsError / unexpected error) never sinks the rest.
 *
 * Phase 1 of docs/roadmap/llm-batching-plan.md restructured the loop inside
 * `runAssessmentBatch` from property-major to flow-major (`for flow { for
 * property { … } }`). Most of the tests above don't care — they only assert
 * on aggregate counters and `toHaveBeenCalledWith` values, not call order —
 * so they pass unchanged against the new loop. The tests at the bottom of
 * this file are the ones Phase 1 added specifically to pin the restructure:
 * order-insensitivity of a full pass, and the one semantic consequence a
 * mid-pass stop now has under flow-major ordering (see batch.ts's loop-body
 * comment for the full explanation).
 */
import { describe, it, expect, vi } from "vitest";
import { BudgetExceededError, CircuitBreakerOpenError } from "@/lib/llm";
import { NoListingsError } from "../shared";
import { AssessmentParkedError } from "../cache";
import { LlmQuotaExceededError } from "@/lib/llm-enabled";
import {
  runAssessmentBatch,
  type BatchFlow,
} from "../batch";

/** Two fake flows so we can assert per-flow behaviour without the real LLM. */
function makeFlows(): { flows: BatchFlow[]; a: ReturnType<typeof vi.fn>; b: ReturnType<typeof vi.fn> } {
  const a = vi.fn(async () => undefined);
  const b = vi.fn(async () => undefined);
  const flows: BatchFlow[] = [
    { type: "occupancy", promptVersion: "occupancy/v2", assess: a },
    { type: "condition", promptVersion: "condition/v1", assess: b },
  ];
  return { flows, a, b };
}

describe("runAssessmentBatch", () => {
  it("runs every flow for an unassessed property", async () => {
    const { flows, a, b } = makeFlows();
    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [42],
      isCurrent: async () => false, // nothing cached → run everything
    });

    expect(a).toHaveBeenCalledWith(42, { requestId: null, trendingCandidates: [], dismissedCandidates: [] });
    expect(b).toHaveBeenCalledWith(42, { requestId: null, trendingCandidates: [], dismissedCandidates: [] });
    expect(result).toMatchObject({
      properties: 1,
      assessed: 2,
      skipped: 0,
      stopped: null,
    });
  });

  it("EC-2: skips a flow whose verdict already matches the current prompt version", async () => {
    const { flows, a, b } = makeFlows();
    // occupancy is current (stale:false), condition is not.
    const isCurrent = vi.fn(async (_id: number, flow: BatchFlow) => flow.type === "occupancy");

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [7],
      isCurrent,
    });

    expect(a).not.toHaveBeenCalled(); // already current → no spend
    expect(b).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ properties: 1, assessed: 1, skipped: 1, stopped: null });
  });

  it("EC-3: a BudgetExceededError stops the batch cleanly, processing nothing further", async () => {
    const { flows, a, b } = makeFlows();
    a.mockRejectedValueOnce(new BudgetExceededError());

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [1, 2, 3],
      isCurrent: async () => false,
    });

    // Stopped on the very first flow of the first property.
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled(); // never reached the second flow
    expect(result.stopped).toBe("budget");
    expect(result.properties).toBe(1); // properties 2 and 3 never examined
    expect(result.assessed).toBe(0);
  });

  it("EC-3: a CircuitBreakerOpenError also stops cleanly", async () => {
    const { flows, a } = makeFlows();
    a.mockRejectedValueOnce(new CircuitBreakerOpenError());

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [1, 2],
      isCurrent: async () => false,
    });

    expect(result.stopped).toBe("circuit");
    expect(result.properties).toBe(1);
  });

  it("skips a property with no readable listings and carries on", async () => {
    const { flows, a, b } = makeFlows();
    a.mockRejectedValueOnce(new NoListingsError(9)); // occupancy on property 9 has nothing to read

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [9, 10],
      isCurrent: async () => false,
    });

    // property 9: occupancy → NoListings (skip), condition → runs.
    // property 10: both flows run.
    expect(result.stopped).toBeNull();
    expect(result.noListings).toBe(1);
    expect(result.properties).toBe(2);
    expect(b).toHaveBeenCalledTimes(2); // condition ran on both properties
    expect(result.assessed).toBe(3); // 9:condition + 10:occupancy + 10:condition
  });

  it("logs and counts an unexpected per-flow error without stopping the batch", async () => {
    const { flows, a, b } = makeFlows();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    a.mockRejectedValueOnce(new Error("malformed model output"));

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [5],
      isCurrent: async () => false,
    });

    expect(result.stopped).toBeNull();
    expect(result.errors).toBe(1);
    expect(b).toHaveBeenCalledTimes(1); // the next flow still ran
    expect(result.assessed).toBe(1);
    spy.mockRestore();
  });

  it("does nothing on an empty selection", async () => {
    const { flows, a, b } = makeFlows();
    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [],
      isCurrent: async () => false,
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(result).toMatchObject({ properties: 0, assessed: 0, skipped: 0, stopped: null });
  });

  it("#396: fetches the trending candidates ONCE per batch and threads them into every flow call", async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const flows: BatchFlow[] = [
      { type: "redflags", promptVersion: "redflags/v6", assess: a },
      { type: "condition", promptVersion: "condition/v1", assess: b },
    ];
    const trending = [{ candidateType: "servidumbre_paso", count: 4 }];
    const fetchTrendingCandidates = vi.fn(async () => trending);

    await runAssessmentBatch({
      flows,
      fetchTrendingCandidates,
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [1, 2], // two properties
      isCurrent: async () => false,
    });

    // Computed ONCE for the whole pass, not once per property (2) or per flow (4).
    expect(fetchTrendingCandidates).toHaveBeenCalledTimes(1);
    // The same list is threaded into every flow.assess call (redflags reads it;
    // the others accept-and-ignore it).
    expect(a).toHaveBeenCalledWith(1, { requestId: null, trendingCandidates: trending, dismissedCandidates: [] });
    expect(a).toHaveBeenCalledWith(2, { requestId: null, trendingCandidates: trending, dismissedCandidates: [] });
    expect(b).toHaveBeenCalledWith(1, { requestId: null, trendingCandidates: trending, dismissedCandidates: [] });
  });

  it("#407: fetches the dismissed candidates ONCE per batch and threads them into every flow call", async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const flows: BatchFlow[] = [
      { type: "redflags", promptVersion: "redflags/v7", assess: a },
      { type: "condition", promptVersion: "condition/v1", assess: b },
    ];
    const dismissed = [{ slug: "sin_posesion", reason: "duplicado de occupancy" }];
    const fetchDismissedCandidates = vi.fn(async () => dismissed);

    await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates,
      selectPropertyIds: async () => [1, 2],
      isCurrent: async () => false,
    });

    // Computed ONCE for the whole pass, not per property or per flow.
    expect(fetchDismissedCandidates).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(1, {
      requestId: null,
      trendingCandidates: [],
      dismissedCandidates: dismissed,
    });
    expect(b).toHaveBeenCalledWith(2, {
      requestId: null,
      trendingCandidates: [],
      dismissedCandidates: dismissed,
    });
  });

  it("#407: a failing dismissed fetch does not sink the batch — flows still run with an empty list", async () => {
    const { flows, a, b } = makeFlows();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => {
        throw new Error("db down");
      },
      selectPropertyIds: async () => [42],
      isCurrent: async () => false,
    });

    expect(result).toMatchObject({ properties: 1, assessed: 2, stopped: null });
    expect(a).toHaveBeenCalledWith(42, {
      requestId: null,
      trendingCandidates: [],
      dismissedCandidates: [],
    });
    expect(b).toHaveBeenCalledWith(42, {
      requestId: null,
      trendingCandidates: [],
      dismissedCandidates: [],
    });
    spy.mockRestore();
  });

  it("#396: a failing trending fetch does not sink the batch — flows still run with an empty list", async () => {
    const { flows, a, b } = makeFlows();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => {
        throw new Error("db down");
      },
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [42],
      isCurrent: async () => false,
    });

    expect(result).toMatchObject({ properties: 1, assessed: 2, stopped: null });
    expect(a).toHaveBeenCalledWith(42, { requestId: null, trendingCandidates: [], dismissedCandidates: [] });
    expect(b).toHaveBeenCalledWith(42, { requestId: null, trendingCandidates: [], dismissedCandidates: [] });
    spy.mockRestore();
  });

  it("threads the requestId into the flows", async () => {
    const { flows, a } = makeFlows();
    await runAssessmentBatch({
      flows,
      fetchTrendingCandidates: async () => [],
      fetchDismissedCandidates: async () => [],
      selectPropertyIds: async () => [3],
      isCurrent: async () => false,
      requestId: "req-abc",
    });
    expect(a).toHaveBeenCalledWith(3, { requestId: "req-abc", trendingCandidates: [], dismissedCandidates: [] });
  });

  // ---------------------------------------------------------------------
  // Phase 1 (docs/roadmap/llm-batching-plan.md) — flow-major loop pinning.
  // ---------------------------------------------------------------------

  describe("Phase 1: flow-major loop", () => {
    /**
     * Builds three flows whose per-(property, flow) outcome is a pure function
     * of the pair, never of visiting order — so re-running with the flows (or
     * properties) supplied in a different order can't change what happens to
     * any given pair, only the SEQUENCE in which pairs are visited. Also
     * records every pair the loop actually reaches (via `isCurrent`, which
     * every visited pair calls exactly once) so two runs can be compared by
     * their attempted-pairs SET, not by call order.
     */
    function makeOrderInsensitiveFlows(attempted: Set<string>) {
      const outcomeFor: Record<string, "skip" | "ok" | "noListings" | "error"> = {
        // property 1
        "1:occupancy": "skip",
        "1:condition": "ok",
        "1:redflags": "ok",
        // property 2
        "2:occupancy": "ok",
        "2:condition": "noListings",
        "2:redflags": "ok",
        // property 3
        "3:occupancy": "ok",
        "3:condition": "ok",
        "3:redflags": "error",
      };

      function assessFor(type: string) {
        return vi.fn(async (propertyId: number) => {
          const outcome = outcomeFor[`${propertyId}:${type}`];
          if (outcome === "noListings") throw new NoListingsError(propertyId);
          if (outcome === "error") throw new Error("malformed model output");
          return undefined;
        });
      }

      const a = assessFor("occupancy");
      const b = assessFor("condition");
      const c = assessFor("redflags");
      const flows: BatchFlow[] = [
        { type: "occupancy", promptVersion: "occupancy/v2", assess: a },
        { type: "condition", promptVersion: "condition/v1", assess: b },
        { type: "redflags", promptVersion: "redflags/v6", assess: c },
      ];
      const isCurrent = async (propertyId: number, flow: BatchFlow) => {
        attempted.add(`${propertyId}:${flow.type}`);
        return outcomeFor[`${propertyId}:${flow.type}`] === "skip";
      };
      return { flows, isCurrent };
    }

    // NOTE ON WHAT THIS PROVES. This runs ONE implementation twice with the
    // inputs reversed, so it cannot detect a property-major -> flow-major
    // behaviour change: it still passes against the old loop. Its real value
    // is the golden counter values below, plus the 14 pre-existing tests in
    // this file whose golden values were written against the OLD loop and pass
    // unchanged — that is the strongest "same behaviour as before" evidence
    // available. The test that actually pins the new loop SHAPE is the budget
    // stop below, which is the only one that fails if the loop is reverted.
    it("produces IDENTICAL summary counters and attempted (property, flow) pairs regardless of flow/property order", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const attemptedForward = new Set<string>();
      const forward = makeOrderInsensitiveFlows(attemptedForward);
      const resultForward = await runAssessmentBatch({
        flows: forward.flows,
        fetchTrendingCandidates: async () => [],
        fetchDismissedCandidates: async () => [],
        selectPropertyIds: async () => [1, 2, 3],
        isCurrent: forward.isCurrent,
      });

      const attemptedReversed = new Set<string>();
      const reversed = makeOrderInsensitiveFlows(attemptedReversed);
      const resultReversed = await runAssessmentBatch({
        flows: [...reversed.flows].reverse(),
        fetchTrendingCandidates: async () => [],
        fetchDismissedCandidates: async () => [],
        selectPropertyIds: async () => [3, 2, 1], // reversed property order too
        isCurrent: reversed.isCurrent,
      });

      // Same counter object regardless of the order flows/properties were
      // supplied in — the whole point of the flow-major restructure being a
      // pure control-flow change with no behavioural difference on a full
      // (non-stopped) pass.
      expect(resultReversed).toEqual(resultForward);
      expect(resultForward).toMatchObject({
        properties: 3,
        assessed: 6, // 1:condition,1:redflags,2:occupancy,2:redflags,3:occupancy,3:condition
        skipped: 1, // 1:occupancy
        noListings: 1, // 2:condition
        parked: 0,
        errors: 1, // 3:redflags
        stopped: null,
      });
      // And the SET of (property, flow) pairs the loop actually reached is
      // identical too, even though the two runs visited them in opposite
      // sequence.
      expect(attemptedReversed).toEqual(attemptedForward);

      spy.mockRestore();
    });

    it("a budget stop mid-flow returns partial counters with stopped: 'budget', and skip/park/noListings accounting is unchanged", async () => {
      // Four properties, all funnelled through the FIRST flow only (occupancy)
      // before the stop fires — condition/redflags never get a chance to run
      // for anyone. This is the semantic consequence documented in batch.ts:
      // a mid-pass stop under flow-major leaves properties assessed on SOME
      // axes and not others, rather than a clean assessed-prefix/pending-
      // suffix split of properties.
      const isCurrent = vi.fn(async (propertyId: number, flow: BatchFlow) =>
        propertyId === 1 && flow.type === "occupancy",
      );
      const a = vi.fn(async (propertyId: number) => {
        if (propertyId === 2) throw new NoListingsError(propertyId);
        if (propertyId === 3) throw new AssessmentParkedError(propertyId, "occupancy", 3, "LLM_CLI_PARSE");
        if (propertyId === 4) throw new BudgetExceededError();
        return undefined; // property 1 is skipped via isCurrent before this runs
      });
      const b = vi.fn(async () => undefined); // condition — must never be reached
      const c = vi.fn(async () => undefined); // redflags — must never be reached
      const flows: BatchFlow[] = [
        { type: "occupancy", promptVersion: "occupancy/v2", assess: a },
        { type: "condition", promptVersion: "condition/v1", assess: b },
        { type: "redflags", promptVersion: "redflags/v6", assess: c },
      ];

      const result = await runAssessmentBatch({
        flows,
        fetchTrendingCandidates: async () => [],
        fetchDismissedCandidates: async () => [],
        selectPropertyIds: async () => [1, 2, 3, 4],
        isCurrent,
      });

      expect(result).toMatchObject({
        properties: 4, // all four were reached (touched) before the stop
        assessed: 0, // property 1 was skipped, not assessed; 2/3/4 all failed
        skipped: 1, // property 1 (already current on occupancy)
        noListings: 1, // property 2
        parked: 1, // property 3
        errors: 0,
        stopped: "budget",
      });
      // condition and redflags never ran for ANY property — the stop fired
      // inside the first flow, before the second flow was ever entered.
      expect(b).not.toHaveBeenCalled();
      expect(c).not.toHaveBeenCalled();
      // occupancy itself only reached properties 2, 3 and 4 (property 1 was
      // skipped via isCurrent before assess would have been called).
      expect(a).toHaveBeenCalledTimes(3);
    });

    it("EC-3: an LlmQuotaExceededError stops the batch cleanly with stopped: 'quota'", async () => {
      // D-107 gave the batch a third clean-stop reason but no batch-level test
      // (budget and circuit each have one). It matters more than the other two
      // now: the quota cap is the stop the owner is most likely to actually
      // hit, and a stop that fell through to the generic error branch would
      // strike the D-104 ledger for every property in the page.
      const err = new LlmQuotaExceededError(91, "session", 80);
      const failing = vi.fn().mockRejectedValue(err);
      const flows: BatchFlow[] = [
        { type: "occupancy", promptVersion: "occupancy/v2", assess: failing },
        { type: "condition", promptVersion: "condition/v2", assess: failing },
      ];

      const result = await runAssessmentBatch({
        flows,
        selectPropertyIds: async () => [1, 2, 3],
        isCurrent: async () => false,
        fetchTrendingCandidates: async () => [],
        fetchDismissedCandidates: async () => [],
      });

      expect(result.stopped).toBe("quota");
      // Halted on the FIRST property of the FIRST flow — not once per property.
      expect(failing).toHaveBeenCalledTimes(1);
      expect(result.assessed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("fetches trending/dismissed candidates exactly once per runAssessmentBatch call, regardless of flow count", async () => {
      const a = vi.fn(async () => undefined);
      const b = vi.fn(async () => undefined);
      const c = vi.fn(async () => undefined);
      const d = vi.fn(async () => undefined);
      const flows: BatchFlow[] = [
        { type: "occupancy", promptVersion: "occupancy/v2", assess: a },
        { type: "condition", promptVersion: "condition/v1", assess: b },
        { type: "redflags", promptVersion: "redflags/v6", assess: c },
        { type: "location", promptVersion: "location/v1", assess: d },
      ];
      const fetchTrendingCandidates = vi.fn(async () => []);
      const fetchDismissedCandidates = vi.fn(async () => []);

      await runAssessmentBatch({
        flows,
        fetchTrendingCandidates,
        fetchDismissedCandidates,
        selectPropertyIds: async () => [1, 2, 3],
        isCurrent: async () => false,
      });

      // 4 flows × 3 properties = 12 flow runs, but the once-per-batch fetch
      // stays once — it lives above both loops, untouched by the restructure.
      expect(fetchTrendingCandidates).toHaveBeenCalledTimes(1);
      expect(fetchDismissedCandidates).toHaveBeenCalledTimes(1);
      expect(a).toHaveBeenCalledTimes(3);
      expect(b).toHaveBeenCalledTimes(3);
      expect(c).toHaveBeenCalledTimes(3);
      expect(d).toHaveBeenCalledTimes(3);
    });
  });
});
